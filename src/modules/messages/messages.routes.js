const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const asyncHandler = require('../../shared/async-handler');
const { requirePermission } = require('../../middleware/auth');
const service = require('./messages.service');
const { writeRequestAudit } = require('../audit/audit.repository');
const { shouldMaskPersonalData, maskMessage } = require('../../shared/data-masking');

const router = express.Router();
const enqueueLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => (req.apiKey ? `api-key:${req.apiKey.id}` : `session:${req.session?.user?.id || ipKeyGenerator(req.ip)}`),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Batas enqueue pesan terlampaui' } },
});
router.get('/', requirePermission('messages.view'), asyncHandler(async (req, res) => {
  const result = await service.list(req.query);
  if (shouldMaskPersonalData(req)) result.data = result.data.map(maskMessage);
  res.json({ success: true, ...result });
}));
router.get('/:publicId', requirePermission('messages.view'), asyncHandler(async (req, res) => {
  let data = await service.detail(req.params.publicId);
  if (shouldMaskPersonalData(req)) data = maskMessage(data);
  res.json({ success: true, data });
}));
router.post('/', requirePermission('messages.send'), enqueueLimiter, asyncHandler(async (req, res) => {
  const data = await service.enqueue({
    ...req.body,
    source: req.apiKey ? 'api' : 'dashboard',
    idempotency_key: req.get('idempotency-key') || req.body.idempotency_key,
  }, req.session?.user?.id || null);
  await writeRequestAudit(req, { action: 'message.enqueued', entityType: 'message', entityId: data.public_id });
  res.status(202).json({ success: true, data });
}));
router.post('/:publicId/retry', requirePermission('messages.retry'), asyncHandler(async (req, res) => {
  const data = await service.retry(req.params.publicId);
  await writeRequestAudit(req, { action: 'message.retried', entityType: 'message', entityId: data.public_id });
  res.status(202).json({ success: true, data });
}));

module.exports = router;
