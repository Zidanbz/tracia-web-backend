const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const knex = require('../../database/knex');
const asyncHandler = require('../../shared/async-handler');
const { requirePermission } = require('../../middleware/auth');
const { encryptSecret } = require('../../shared/encryption');
const { assertPublicHttpsUrl } = require('../../shared/url-security');
const { writeRequestAudit } = require('../audit/audit.repository');

const router = express.Router();
const allowedApiScopes = [
  'whatsapp.view', 'messages.view', 'messages.send',
  'broadcasts.view', 'contacts.view', 'templates.view', 'reports.view',
];
const apiKeySchema = z.object({
  name: z.string().trim().min(2).max(150),
  scopes: z.array(z.enum(allowedApiScopes)).min(1).max(allowedApiScopes.length),
  expires_at: z.coerce.date().optional(),
});

router.get('/api-keys', requirePermission('integrations.view'), asyncHandler(async (req, res) => {
  const data = await knex('api_keys').select('id', 'name', 'key_prefix', 'scopes', 'status', 'expires_at', 'last_used_at', 'created_at').orderBy('id', 'desc');
  res.json({ success: true, data });
}));
router.post('/api-keys', requirePermission('integrations.manage'), asyncHandler(async (req, res) => {
  const value = apiKeySchema.parse(req.body);
  const secret = crypto.randomBytes(32).toString('base64url');
  const prefix = `wa_${crypto.randomBytes(4).toString('hex')}`;
  const rawKey = `${prefix}.${secret}`;
  const [id] = await knex('api_keys').insert({
    name: value.name,
    key_prefix: prefix,
    key_hash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    scopes: JSON.stringify(value.scopes),
    expires_at: value.expires_at || null,
    created_by: req.session.user.id,
  });
  await writeRequestAudit(req, { action: 'api_key.created', entityType: 'api_key', entityId: String(id) });
  res.status(201).json({
    success: true,
    data: { id, name: value.name, prefix, api_key: rawKey, warning: 'Simpan API key sekarang; nilai ini tidak akan ditampilkan lagi.' },
  });
}));
router.delete('/api-keys/:id', requirePermission('integrations.manage'), asyncHandler(async (req, res) => {
  const affected = await knex('api_keys').where({ id: req.params.id, status: 'active' }).update({ status: 'revoked' });
  if (!affected) { const error = new Error('API key aktif tidak ditemukan'); error.status = 404; throw error; }
  await writeRequestAudit(req, { action: 'api_key.revoked', entityType: 'api_key', entityId: String(req.params.id) });
  res.status(204).end();
}));

const webhookSchema = z.object({
  url: z.url(),
  events: z.array(z.enum(['message.sent', 'message.failed', 'broadcast.completed'])).min(1),
});
router.get('/webhooks', requirePermission('integrations.view'), asyncHandler(async (req, res) => {
  const data = await knex('webhooks').select('id', 'url', 'subscribed_events', 'status', 'created_at', 'updated_at').orderBy('id', 'desc');
  res.json({ success: true, data });
}));
router.post('/webhooks', requirePermission('integrations.manage'), asyncHandler(async (req, res) => {
  const value = webhookSchema.parse(req.body);
  const safeUrl = await assertPublicHttpsUrl(value.url);
  const signingSecret = crypto.randomBytes(32).toString('base64url');
  const [id] = await knex('webhooks').insert({
    url: safeUrl,
    signing_secret_encrypted: encryptSecret(signingSecret),
    subscribed_events: JSON.stringify(value.events),
    status: 'active',
    created_by: req.session.user.id,
  });
  await writeRequestAudit(req, { action: 'webhook.created', entityType: 'webhook', entityId: String(id) });
  res.status(201).json({
    success: true,
    data: { id, url: safeUrl, signing_secret: signingSecret, warning: 'Simpan signing secret sekarang; nilai ini tidak akan ditampilkan lagi.' },
  });
}));
router.delete('/webhooks/:id', requirePermission('integrations.manage'), asyncHandler(async (req, res) => {
  const affected = await knex('webhooks').where({ id: req.params.id }).update({ status: 'inactive', updated_at: knex.fn.now(3) });
  if (!affected) { const error = new Error('Webhook tidak ditemukan'); error.status = 404; throw error; }
  await writeRequestAudit(req, { action: 'webhook.deactivated', entityType: 'webhook', entityId: String(req.params.id) });
  res.status(204).end();
}));

module.exports = router;
