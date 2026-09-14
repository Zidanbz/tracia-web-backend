const express = require('express');
const { z } = require('zod');
const knex = require('../../database/knex');
const asyncHandler = require('../../shared/async-handler');
const { requirePermission } = require('../../middleware/auth');
const { shouldMaskPersonalData, maskPhone } = require('../../shared/data-masking');

const router = express.Router();
router.get('/', requirePermission('queue.view'), asyncHandler(async (req, res) => {
  const query = z.object({
    status: z.enum(['pending', 'reserved', 'processing', 'completed', 'failed', 'cancelled']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }).parse(req.query);
  const builder = knex('message_jobs')
    .join('messages', 'messages.id', 'message_jobs.message_id')
    .select('message_jobs.*', 'messages.public_id', 'messages.recipient_phone_e164')
    .orderBy('message_jobs.id', 'desc');
  if (query.status) builder.where('message_jobs.status', query.status);
  const data = await builder.limit(query.limit);
  const safeData = shouldMaskPersonalData(req)
    ? data.map((job) => ({ ...job, recipient_phone_e164: maskPhone(job.recipient_phone_e164) }))
    : data;
  res.json({ success: true, data: safeData });
}));
router.post('/:id/cancel', requirePermission('queue.manage'), asyncHandler(async (req, res) => {
  await knex.transaction(async (trx) => {
    const job = await trx('message_jobs').where({ id: req.params.id }).forUpdate().first();
    if (!job || !['pending', 'reserved'].includes(job.status)) {
      const error = new Error('Job tidak dapat dibatalkan'); error.status = 409; throw error;
    }
    await trx('message_jobs').where({ id: job.id }).update({
      status: 'cancelled', locked_at: null, locked_by: null, updated_at: trx.fn.now(3),
    });
    await trx('messages').where({ id: job.message_id }).whereIn('status', ['queued', 'processing']).update({
      status: 'cancelled', updated_at: trx.fn.now(3),
    });
    await trx('message_events').insert({ message_id: job.message_id, event_type: 'cancelled' });
    await trx('broadcast_recipients').where({ message_id: job.message_id }).whereIn('status', ['pending', 'queued']).update({ status: 'skipped', skip_reason: 'JOB_CANCELLED' });
  });
  res.json({ success: true, data: { id: req.params.id, status: 'cancelled' } });
}));

module.exports = router;
