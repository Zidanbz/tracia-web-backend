const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { requirePermission } = require('../../middleware/auth');
const asyncHandler = require('../../shared/async-handler');
const { writeRequestAudit } = require('../audit/audit.repository');
const service = require('./campaign-monitoring.service');

const router = express.Router();

router.use(requirePermission('campaigns.monitor'));
const exportLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: (req) => `campaign-monitoring-export:${req.session?.user?.id || ipKeyGenerator(req.ip)}`, message: { success: false, error: { code: 'RATE_LIMITED', message: 'Batas export Monitoring Campaign terlampaui' } } });

router.get('/metadata', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await service.metadata(req) });
}));

router.get('/summary', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await service.summary(req, req.query) });
}));

router.get('/campaigns', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const result = await service.campaigns(req, req.query);
  res.json({ success: true, data: result.data, pagination: result.pagination });
}));

router.get('/export', exportLimiter, asyncHandler(async (req, res) => {
  const data = await service.exportContacts(req, req.query);
  const buffer = Buffer.from(await data.workbook.xlsx.writeBuffer());
  await writeRequestAudit(req, { action: 'campaign_monitoring.exported', entityType: 'campaign_monitoring', entityId: 'filtered', afterData: { contact_count: data.contact_count, answer_count: data.answer_count } });
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="monitoring-campaign.xlsx"', 'Cache-Control': 'private, no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.send(buffer);
}));

module.exports = router;
