const express = require('express');
const { z } = require('zod');
const knex = require('../../database/knex');
const asyncHandler = require('../../shared/async-handler');
const { requirePermission } = require('../../middleware/auth');
const { writeRequestAudit } = require('../audit/audit.repository');

const router = express.Router();
const allowedSettings = {
  default_country_code: z.string().regex(/^\d{1,4}$/),
  message_delay_ms: z.coerce.number().int().min(1000).max(60000),
  max_broadcast_recipients: z.coerce.number().int().min(1).max(10000),
  max_retry_attempts: z.coerce.number().int().min(0).max(10),
};
const batchUpdateSchema = z.object(allowedSettings).strict();

async function upsertSetting(db, key, value, userId) {
  const valueType = typeof value === 'number' ? 'number' : 'string';
  await db('application_settings').insert({
    setting_key: key,
    value_type: valueType,
    setting_value: String(value),
    category: 'operational',
    updated_by: userId,
  }).onConflict('setting_key').merge({
    value_type: valueType,
    setting_value: String(value),
    updated_by: userId,
    updated_at: db.fn.now(3),
  });
}

router.get('/', requirePermission('settings.view'), asyncHandler(async (req, res) => {
  const data = await knex('application_settings').select('setting_key', 'value_type', 'setting_value', 'category', 'updated_at');
  res.json({ success: true, data });
}));
router.patch('/', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
  const values = batchUpdateSchema.parse(req.body);
  await knex.transaction(async (trx) => {
    for (const [key, value] of Object.entries(values)) {
      await upsertSetting(trx, key, value, req.session.user.id);
    }
  });
  await writeRequestAudit(req, {
    action: 'settings.batch_updated',
    entityType: 'application_setting',
    afterData: { keys: Object.keys(values) },
  });
  res.json({ success: true, data: values });
}));
router.patch('/:key', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
  const validator = allowedSettings[req.params.key];
  if (!validator) {
    const error = new Error('Setting tidak diizinkan'); error.status = 404; throw error;
  }
  const value = validator.parse(req.body.value);
  await upsertSetting(knex, req.params.key, value, req.session.user.id);
  await writeRequestAudit(req, { action: 'setting.updated', entityType: 'application_setting', entityId: req.params.key });
  res.json({ success: true, data: { key: req.params.key, value } });
}));

module.exports = router;
