const express = require('express');
const asyncHandler = require('../../shared/async-handler');
const { requirePermission } = require('../../middleware/auth');
const service = require('./broadcasts.service');
const { writeRequestAudit } = require('../audit/audit.repository');

const router = express.Router();
router.get('/', requirePermission('broadcasts.view'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service.list() });
}));
router.post('/preview', requirePermission('broadcasts.manage'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service.preview(req.body) });
}));
router.post('/', requirePermission('broadcasts.manage'), asyncHandler(async (req, res) => {
  const data = await service.create(req.body, req.session.user.id);
  await writeRequestAudit(req, { action: 'broadcast.created', entityType: 'broadcast', entityId: data.public_id });
  res.status(202).json({ success: true, data });
}));
for (const action of ['pause', 'resume', 'cancel']) {
  router.post(`/:publicId/${action}`, requirePermission('broadcasts.manage'), asyncHandler(async (req, res) => {
    const data = await service.setStatus(req.params.publicId, action);
    await writeRequestAudit(req, { action: `broadcast.${action}`, entityType: 'broadcast', entityId: data.public_id });
    res.json({ success: true, data });
  }));
}

module.exports = router;
