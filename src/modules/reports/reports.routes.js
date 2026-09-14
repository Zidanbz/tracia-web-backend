const express = require('express');
const knex = require('../../database/knex');
const asyncHandler = require('../../shared/async-handler');
const { requirePermission } = require('../../middleware/auth');

const router = express.Router();
router.get('/message-summary', requirePermission('reports.view'), asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const data = await knex('messages')
    .select(knex.raw('DATE(created_at) AS report_date'), 'status')
    .count({ count: '*' })
    .where('created_at', '>=', knex.raw('UTC_TIMESTAMP() - INTERVAL ? DAY', [days]))
    .groupByRaw('DATE(created_at), status')
    .orderBy('report_date');
  res.json({ success: true, data: data.map((row) => ({ ...row, count: Number(row.count) })) });
}));
router.get('/broadcast-summary', requirePermission('reports.view'), asyncHandler(async (req, res) => {
  const data = await knex('broadcasts')
    .select('public_id', 'name', 'status', 'total_count', 'sent_count', 'failed_count', 'skipped_count', 'created_at')
    .orderBy('id', 'desc')
    .limit(100);
  res.json({ success: true, data });
}));

module.exports = router;
