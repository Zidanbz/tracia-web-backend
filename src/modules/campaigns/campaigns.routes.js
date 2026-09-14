const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { requirePermission } = require('../../middleware/auth');
const asyncHandler = require('../../shared/async-handler');
const { writeRequestAudit } = require('../audit/audit.repository');
const service = require('./campaigns.service');

const router = express.Router();
const campaignMutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `campaign:${req.session?.user?.id || ipKeyGenerator(req.ip)}`,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Batas perubahan Campaign terlampaui' } },
});
const campaignBlastLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `campaign-blast:${req.session?.user?.id || ipKeyGenerator(req.ip)}`,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Batas operasi blast Campaign terlampaui' } },
});
const campaignPreviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `campaign-preview:${req.session?.user?.id || ipKeyGenerator(req.ip)}`,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Batas preview pesan Campaign terlampaui' } },
});
const campaignExportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `campaign-export:${req.session?.user?.id || ipKeyGenerator(req.ip)}`,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Batas export Monitoring Campaign terlampaui' } },
});

router.get('/metadata', requirePermission('campaigns.view'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service.metadata(req) });
}));

router.get('/', requirePermission('campaigns.view'), asyncHandler(async (req, res) => {
  const result = await service.list(req, req.query);
  res.json({ success: true, data: result.data, pagination: result.pagination });
}));

router.post('/', requirePermission('campaigns.manage'), campaignMutationLimiter, asyncHandler(async (req, res) => {
  const data = await service.create(req, req.body);
  await writeRequestAudit(req, { action: 'campaign.created', entityType: 'campaign', entityId: data.public_id, afterData: { operator_user_id: data.operator_user_id, status: data.status } });
  res.status(201).json({ success: true, data });
}));

router.get('/:publicId', requirePermission('campaigns.view'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service.getDetail(req, req.params.publicId) });
}));

router.get('/:publicId/questions', requirePermission('campaigns.view'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service.listQuestions(req, req.params.publicId) });
}));

router.get('/:publicId/question-sources', requirePermission('campaigns.manage'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service.listQuestionSources(req, req.params.publicId, req.query) });
}));

router.post('/:publicId/questions/import', requirePermission('campaigns.manage'), campaignMutationLimiter, asyncHandler(async (req, res) => {
  const data = await service.importQuestionsFromCampaign(req, req.params.publicId, req.body);
  await writeRequestAudit(req, {
    action: 'campaign.questions_imported',
    entityType: 'campaign',
    entityId: req.params.publicId,
    afterData: {
      source_campaign_public_id: data.source_campaign_public_id,
      source_questionnaire_version: data.source_questionnaire_version,
      target_questionnaire_version: data.questionnaire_version,
      question_count: data.question_count,
      option_count: data.option_count,
    },
  });
  res.status(201).json({ success: true, data });
}));

router.post('/:publicId/questions', requirePermission('campaigns.manage'), campaignMutationLimiter, asyncHandler(async (req, res) => {
  const data = await service.createQuestion(req, req.params.publicId, req.body);
  await writeRequestAudit(req, {
    action: 'campaign.question_created',
    entityType: 'campaign_question',
    entityId: data.public_id,
    afterData: { campaign_public_id: req.params.publicId, position: data.position, answer_type: data.answer_type },
  });
  res.status(201).json({ success: true, data });
}));

router.put('/:publicId/questions/:questionPublicId', requirePermission('campaigns.manage'), campaignMutationLimiter, asyncHandler(async (req, res) => {
  const data = await service.updateQuestion(req, req.params.publicId, req.params.questionPublicId, req.body);
  await writeRequestAudit(req, {
    action: 'campaign.question_updated',
    entityType: 'campaign_question',
    entityId: data.public_id,
    afterData: { campaign_public_id: req.params.publicId, position: data.position, answer_type: data.answer_type, is_active: data.is_active },
  });
  res.json({ success: true, data });
}));

router.delete('/:publicId/questions/:questionPublicId', requirePermission('campaigns.manage'), campaignMutationLimiter, asyncHandler(async (req, res) => {
  const data = await service.removeQuestion(req, req.params.publicId, req.params.questionPublicId);
  await writeRequestAudit(req, {
    action: 'campaign.question_deleted',
    entityType: 'campaign_question',
    entityId: data.public_id,
    afterData: { campaign_public_id: req.params.publicId },
  });
  res.status(204).end();
}));

router.patch('/:publicId', requirePermission('campaigns.manage'), campaignMutationLimiter, asyncHandler(async (req, res) => {
  const data = await service.update(req, req.params.publicId, req.body);
  await writeRequestAudit(req, { action: 'campaign.updated', entityType: 'campaign', entityId: data.public_id, afterData: { fields: Object.keys(req.body) } });
  res.json({ success: true, data });
}));

router.patch('/:publicId/status', requirePermission('campaigns.manage'), campaignMutationLimiter, asyncHandler(async (req, res) => {
  const data = await service.setStatus(req, req.params.publicId, req.body.status);
  await writeRequestAudit(req, { action: 'campaign.status_changed', entityType: 'campaign', entityId: data.public_id, afterData: { status: data.status } });
  res.json({ success: true, data });
}));

router.delete('/:publicId', requirePermission('campaigns.manage'), campaignMutationLimiter, asyncHandler(async (req, res) => {
  const data = await service.remove(req, req.params.publicId, req.body);
  await writeRequestAudit(req, {
    action: 'campaign.deleted',
    entityType: 'campaign',
    entityId: data.public_id,
    afterData: { deletion_type: 'hard_delete', previous_status: data.status },
  });
  res.status(204).end();
}));

router.get('/:publicId/contacts', requirePermission('campaigns.view'), asyncHandler(async (req, res) => {
  const result = await service.listContacts(req, req.params.publicId, req.query);
  res.json({ success: true, data: result.data, pagination: result.pagination });
}));

router.delete('/:publicId/contacts/:contactId', requirePermission('campaigns.operate'), campaignMutationLimiter, asyncHandler(async (req, res) => {
  const data = await service.excludeContact(req, req.params.publicId, req.params.contactId);
  await writeRequestAudit(req, { action: 'campaign.contact_excluded', entityType: 'campaign', entityId: req.params.publicId, afterData: { contact_id: data.contact_id } });
  res.json({ success: true, data });
}));

router.post('/:publicId/contacts/:contactId/reactivate', requirePermission('campaigns.operate'), campaignMutationLimiter, asyncHandler(async (req, res) => {
  const data = await service.reactivateContact(req, req.params.publicId, req.params.contactId);
  await writeRequestAudit(req, {
    action: 'campaign.contact_reactivated',
    entityType: 'campaign',
    entityId: req.params.publicId,
    afterData: { membership_id: data.membership_id, contact_id: data.contact_id, status: data.status },
  });
  res.json({ success: true, data });
}));

router.post('/:publicId/blasts/preview', requirePermission('campaigns.operate'), campaignBlastLimiter, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service.previewBlast(req, req.params.publicId, req.body) });
}));

router.post('/:publicId/blasts', requirePermission('campaigns.operate'), campaignBlastLimiter, asyncHandler(async (req, res) => {
  const data = await service.createBlast(req, req.params.publicId, req.body);
  await writeRequestAudit(req, { action: 'campaign.blast_created', entityType: 'campaign', entityId: req.params.publicId, afterData: { broadcast_public_id: data.public_id, queued_count: data.queued_count } });
  res.status(202).json({ success: true, data });
}));

router.post('/:publicId/reblasts/preview', requirePermission('campaigns.operate'), campaignBlastLimiter, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service.previewReblast(req, req.params.publicId, req.body) });
}));

router.get('/:publicId/reblasts/targets', requirePermission('campaigns.operate'), asyncHandler(async (req, res) => {
  const result = await service.listReblastTargets(req, req.params.publicId, req.query);
  res.json({ success: true, data: result.data, pagination: result.pagination });
}));

router.post('/:publicId/reblasts/targets/:membershipId/preview', requirePermission('campaigns.operate'), campaignPreviewLimiter, asyncHandler(async (req, res) => {
  const data = await service.previewReblastTarget(req, req.params.publicId, req.params.membershipId, req.body);
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data });
}));

router.post('/:publicId/reblasts', requirePermission('campaigns.operate'), campaignBlastLimiter, asyncHandler(async (req, res) => {
  const data = await service.createReblast(req, req.params.publicId, req.body);
  await writeRequestAudit(req, {
    action: 'campaign.reblast_created',
    entityType: 'campaign',
    entityId: req.params.publicId,
    afterData: {
      broadcast_public_id: data.public_id,
      delivery_type: data.campaign_delivery_type,
      target_session: data.campaign_target_session,
      queued_count: data.queued_count,
    },
  });
  res.status(202).json({ success: true, data });
}));

router.get('/:publicId/blasts', requirePermission('campaigns.view'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service.listBlasts(req, req.params.publicId, req.query) });
}));

for (const action of ['pause', 'resume', 'cancel']) {
  router.post(`/:publicId/blasts/:broadcastPublicId/${action}`, requirePermission('campaigns.operate'), campaignBlastLimiter, asyncHandler(async (req, res) => {
    const data = await service.setBlastStatus(req, req.params.publicId, req.params.broadcastPublicId, action);
    await writeRequestAudit(req, { action: `campaign.blast_${action}`, entityType: 'campaign', entityId: req.params.publicId, afterData: { broadcast_public_id: data.public_id } });
    res.json({ success: true, data });
  }));
}

router.get('/:publicId/monitoring/summary', requirePermission('campaigns.monitor'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service.monitoringSummary(req, req.params.publicId) });
}));

router.get('/:publicId/monitoring/contacts', requirePermission('campaigns.monitor'), asyncHandler(async (req, res) => {
  const result = await service.monitoringContacts(req, req.params.publicId, req.query);
  res.json({ success: true, data: result.data, pagination: result.pagination });
}));

router.get('/:publicId/monitoring/export', requirePermission('campaigns.monitor'), campaignExportLimiter, asyncHandler(async (req, res) => {
  const data = await service.exportMonitoringAnswers(req, req.params.publicId, req.query);
  await writeRequestAudit(req, {
    action: 'campaign.monitoring_answers_exported',
    entityType: 'campaign',
    entityId: req.params.publicId,
    afterData: {
      contact_count: data.contact_count,
      answer_count: data.answer_count,
      masked: data.masked,
      filters: {
        search_used: Boolean(data.filters.search),
        progress_status: data.filters.progress_status || null,
        session_number: data.filters.session_number || null,
      },
    },
  });
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${data.filename}"`,
    'Cache-Control': 'private, no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(data.buffer);
}));

router.get('/:publicId/monitoring/contacts/:membershipId', requirePermission('campaigns.monitor'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service.monitoringContactDetail(req, req.params.publicId, req.params.membershipId) });
}));

router.post('/:publicId/monitoring/contacts/:membershipId/read-all', requirePermission('campaigns.operate'), campaignMutationLimiter, asyncHandler(async (req, res) => {
  const data = await service.markMonitoringContactRepliesRead(req, req.params.publicId, req.params.membershipId);
  await writeRequestAudit(req, {
    action: 'campaign.contact_replies_marked_read',
    entityType: 'campaign',
    entityId: req.params.publicId,
    afterData: data,
  });
  res.json({ success: true, data });
}));

router.get('/:publicId/data-corrections', requirePermission('campaigns.operate'), asyncHandler(async (req, res) => {
  const result = await service.listReviewCorrections(req, req.params.publicId, req.query);
  res.set('Cache-Control', 'private, no-store');
  res.json({
    success: true,
    data: result.data,
    study_programs: result.study_programs,
    pagination: result.pagination,
  });
}));

router.put('/:publicId/data-corrections/:membershipId', requirePermission('campaigns.operate'), campaignMutationLimiter, asyncHandler(async (req, res) => {
  const data = await service.correctReviewedContact(req, req.params.publicId, req.params.membershipId, req.body);
  await writeRequestAudit(req, {
    action: 'campaign.contact_data_corrected',
    entityType: 'campaign',
    entityId: req.params.publicId,
    afterData: {
      membership_id: data.membership_id,
      changed_fields: data.changed_fields,
      reported_fields: data.reported_fields,
      progress_status: data.progress_status,
      current_session_number: data.current_session_number,
    },
  });
  res.set('Cache-Control', 'private, no-store');
  res.json({ success: true, data });
}));

router.post('/:publicId/monitoring/contacts/:membershipId/resolve-review', requirePermission('campaigns.operate'), campaignMutationLimiter, asyncHandler(async (req, res) => {
  const data = await service.resumeReviewedContact(req, req.params.publicId, req.params.membershipId);
  await writeRequestAudit(req, {
    action: 'campaign.contact_review_resolved',
    entityType: 'campaign',
    entityId: req.params.publicId,
    afterData: data,
  });
  res.json({ success: true, data });
}));

router.post('/:publicId/development/reset-progress', requirePermission('campaigns.manage'), campaignMutationLimiter, asyncHandler(async (req, res) => {
  const data = await service.resetCampaignProgress(req, req.params.publicId, req.body);
  await writeRequestAudit(req, {
    action: 'campaign.development_progress_reset',
    entityType: 'campaign',
    entityId: req.params.publicId,
    afterData: {
      membership_count: data.membership_count,
      existing_progress_count: data.existing_progress_count,
      created_progress_count: data.created_progress_count,
      previous_statuses: data.previous_statuses,
      cancelled_message_count: data.cancelled_message_count,
      cancelled_job_count: data.cancelled_job_count,
    },
  });
  res.json({ success: true, data });
}));

router.patch('/:publicId/monitoring/messages/:incomingPublicId/read', requirePermission('campaigns.operate'), campaignMutationLimiter, asyncHandler(async (req, res) => {
  const data = await service.markMonitoringMessageRead(req, req.params.publicId, req.params.incomingPublicId);
  await writeRequestAudit(req, {
    action: 'campaign.reply_marked_read',
    entityType: 'campaign',
    entityId: req.params.publicId,
    afterData: { incoming_message_public_id: req.params.incomingPublicId },
  });
  res.json({ success: true, data });
}));

router.get('/:publicId/monitoring/recipients', requirePermission('campaigns.monitor'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service.monitoringRecipients(req, req.params.publicId, req.query) });
}));

router.get('/:publicId/monitoring/replies', requirePermission('campaigns.monitor'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service.monitoringReplies(req, req.params.publicId) });
}));

router.get('/:publicId/monitoring/unattributed', requirePermission('campaigns.monitor'), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service.monitoringUnattributed(req, req.params.publicId) });
}));

router.post('/:publicId/monitoring/replies/:incomingPublicId/attribute', requirePermission('campaigns.attribute_replies'), campaignMutationLimiter, asyncHandler(async (req, res) => {
  const data = await service.attributeReply(req, req.params.publicId, req.params.incomingPublicId);
  await writeRequestAudit(req, { action: 'campaign.reply_attributed', entityType: 'campaign', entityId: req.params.publicId, afterData: { incoming_message_public_id: req.params.incomingPublicId } });
  res.json({ success: true, data });
}));

module.exports = router;
