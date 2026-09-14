const express = require('express');
const { requirePermission } = require('../../middleware/auth');
const asyncHandler = require('../../shared/async-handler');
const service = require('./message-timing.service');

const router = express.Router();

router.use(requirePermission('campaigns.monitor'));

router.get('/metadata', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await service.metadata(req) });
}));

router.get('/', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const result = await service.list(req, req.query);
  res.json({
    success: true,
    data: result.data,
    summary: result.summary,
    pagination: result.pagination,
    range: result.range,
    generated_at: result.generated_at,
  });
}));

module.exports = router;
