const express = require('express');
const { requirePermission } = require('../../middleware/auth');
const asyncHandler = require('../../shared/async-handler');
const service = require('./campus-dashboard.service');

const router = express.Router();

router.use(requirePermission('campaigns.monitor'));

router.get('/metadata', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await service.metadata(req) });
}));

router.get('/summary', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await service.summary(req, req.query) });
}));

router.get('/answers', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const result = await service.answers(req, req.query);
  res.json({ success: true, data: result.data, question: result.question, pagination: result.pagination });
}));

module.exports = router;
