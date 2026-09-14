const express = require('express');
const asyncHandler = require('../../shared/async-handler');
const { requirePermission } = require('../../middleware/auth');
const { manager } = require('./whatsapp-client-manager');
const knex = require('../../database/knex');
const { writeAuditLog } = require('../audit/audit.repository');

const router = express.Router();

router.get('/status', requirePermission('whatsapp.view'), (req, res) => {
  res.json({ success: true, data: manager.getStatus() });
});
router.get('/events', requirePermission('whatsapp.view'), asyncHandler(async (req, res) => {
  const data = await knex('whatsapp_connection_events')
    .join('whatsapp_accounts', 'whatsapp_accounts.id', 'whatsapp_connection_events.whatsapp_account_id')
    .where('whatsapp_accounts.public_id', 'default')
    .select('whatsapp_connection_events.id', 'event_type', 'metadata', 'whatsapp_connection_events.created_at')
    .orderBy('whatsapp_connection_events.id', 'desc')
    .limit(100);
  res.json({ success: true, data });
}));
async function auditAction(req, action) {
  return writeAuditLog({
    actorUserId: req.session?.user?.id || null,
    action: `whatsapp.${action}`,
    entityType: 'whatsapp_account',
    entityId: 'default',
    requestId: req.id,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });
}
router.post('/connect', requirePermission('whatsapp.manage'), asyncHandler(async (req, res) => {
  const result = await manager.connect();
  await auditAction(req, 'connect');
  res.status(result.started ? 202 : 200).json({ success: true, data: result });
}));
router.post('/reconnect', requirePermission('whatsapp.manage'), asyncHandler(async (req, res) => {
  const result = await manager.reconnect();
  await auditAction(req, 'reconnect');
  res.status(202).json({ success: true, data: result });
}));
router.post('/logout', requirePermission('whatsapp.manage'), asyncHandler(async (req, res) => {
  const result = await manager.logout();
  await auditAction(req, 'logout');
  res.json({ success: true, data: result });
}));

module.exports = router;
