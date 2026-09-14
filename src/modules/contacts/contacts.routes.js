const express = require('express');
const asyncHandler = require('../../shared/async-handler');
const { requirePermission } = require('../../middleware/auth');
const service = require('./contacts.service');
const { writeRequestAudit } = require('../audit/audit.repository');
const { shouldMaskPersonalData, maskPhone } = require('../../shared/data-masking');

const router = express.Router();
router.get('/', requirePermission('contacts.view'), asyncHandler(async (req, res) => {
  const result = await service.list(req.query);
  if (shouldMaskPersonalData(req)) {
    result.data = result.data.map((contact) => ({ ...contact, phone_e164: maskPhone(contact.phone_e164) }));
  }
  res.json({ success: true, ...result });
}));
router.post('/', requirePermission('contacts.manage'), asyncHandler(async (req, res) => {
  const data = await service.create(req.body);
  await writeRequestAudit(req, { action: 'contact.created', entityType: 'contact', entityId: String(data.id) });
  res.status(201).json({ success: true, data });
}));
router.patch('/:id', requirePermission('contacts.manage'), asyncHandler(async (req, res) => {
  const data = await service.update(req.params.id, req.body);
  await writeRequestAudit(req, { action: 'contact.updated', entityType: 'contact', entityId: String(data.id) });
  res.json({ success: true, data });
}));
router.delete('/:id', requirePermission('contacts.manage'), asyncHandler(async (req, res) => {
  await service.remove(req.params.id);
  await writeRequestAudit(req, { action: 'contact.hard_deleted', entityType: 'contact', entityId: String(req.params.id) });
  res.status(204).end();
}));

module.exports = router;
