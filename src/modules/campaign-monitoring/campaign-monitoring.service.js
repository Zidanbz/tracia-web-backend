const { z } = require('zod');
const knex = require('../../database/knex');
const { actorFromRequest, applyScope, findScopedCampaign } = require('../campaigns/campaigns.service');
const { assertAcademicHierarchy } = require('../campus-dashboard/campus-dashboard.service');
const { buildCampaignMonitoringWorkbook, questionMatchKey } = require('../campaigns/campaign-monitoring-export');
const { shouldMaskPersonalData, maskPhone } = require('../../shared/data-masking');

const optionalId = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.coerce.number().int().positive().optional(),
);
const optionalUuid = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.string().uuid().optional(),
);
const optionalStatus = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.enum(['draft', 'active', 'paused', 'completed', 'archived']).optional(),
);
const filterSchema = z.object({
  search: z.string().trim().max(180).optional().default(''),
  campaign_public_id: optionalUuid,
  status: optionalStatus,
  operator_user_id: optionalId,
  university_group_id: optionalId,
  faculty_group_id: optionalId,
  study_program_group_id: optionalId,
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function parseFilters(filters = {}) {
  return filterSchema.parse(filters);
}

async function validateFilters(actor, filters) {
  let campaign = null;
  if (filters.campaign_public_id) {
    campaign = await findScopedCampaign(filters.campaign_public_id, actor);
  }
  const ids = [
    filters.university_group_id,
    filters.faculty_group_id,
    filters.study_program_group_id,
  ].filter(Boolean);
  const groups = ids.length
    ? await knex('contact_groups').whereIn('id', ids).select('id', 'parent_id', 'type')
    : [];
  assertAcademicHierarchy(filters, groups);
  if (campaign) {
    const mismatched = (filters.university_group_id
        && Number(campaign.university_group_id) !== filters.university_group_id)
      || (filters.faculty_group_id
        && Number(campaign.faculty_group_id) !== filters.faculty_group_id)
      || (filters.study_program_group_id
        && Number(campaign.study_program_group_id) !== filters.study_program_group_id)
      || (filters.operator_user_id
        && Number(campaign.operator_user_id) !== filters.operator_user_id)
      || (filters.status && campaign.status !== filters.status);
    if (mismatched) {
      throw httpError(422, 'Filter tidak sesuai dengan Campaign terpilih', 'CAMPAIGN_MONITORING_FILTER_MISMATCH');
    }
  }
}

function applyFilters(query, actor, filters) {
  applyScope(query, actor, 'campaigns');
  if (filters.campaign_public_id) query.where('campaigns.public_id', filters.campaign_public_id);
  if (filters.status) query.where('campaigns.status', filters.status);
  else query.whereNot('campaigns.status', 'archived');
  if (filters.operator_user_id) query.where('campaigns.operator_user_id', filters.operator_user_id);
  if (filters.university_group_id) query.where('campaigns.university_group_id', filters.university_group_id);
  if (filters.faculty_group_id) query.where('campaigns.faculty_group_id', filters.faculty_group_id);
  if (filters.study_program_group_id) query.where('campaigns.study_program_group_id', filters.study_program_group_id);
  if (filters.search) {
    const term = `%${filters.search}%`;
    query.where((builder) => builder.where('campaigns.title', 'like', term)
      .orWhere('university.name', 'like', term)
      .orWhere('faculty.name', 'like', term)
      .orWhere('study_program.name', 'like', term)
      .orWhere('operator.name', 'like', term));
  }
  return query;
}

function progressAggregate(database = knex) {
  return database('campaign_contacts as cc')
    .leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'cc.id')
    .where('cc.status', 'active')
    .select('cc.campaign_id')
    .countDistinct({ target_count: 'cc.id' })
    .select(database.raw("SUM(CASE WHEN COALESCE(progress.status, 'not_started') = 'not_started' THEN 1 ELSE 0 END) AS not_started_count"))
    .select(database.raw("SUM(CASE WHEN progress.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count"))
    .select(database.raw("SUM(CASE WHEN progress.status = 'completed' THEN 1 ELSE 0 END) AS completed_count"))
    .select(database.raw("SUM(CASE WHEN progress.status = 'review_pending_details' THEN 1 ELSE 0 END) AS review_pending_details_count"))
    .select(database.raw("SUM(CASE WHEN progress.status = 'needs_review' THEN 1 ELSE 0 END) AS needs_review_count"))
    .select(database.raw("SUM(CASE WHEN progress.status = 'stopped' THEN 1 ELSE 0 END) AS stopped_count"))
    .groupBy('cc.campaign_id')
    .as('progress_metrics');
}

function responseAggregate(database = knex) {
  return database('campaign_incoming_messages as attribution')
    .join('incoming_messages as incoming', 'incoming.id', 'attribution.incoming_message_id')
    .join('campaign_contacts as cc', 'cc.id', 'attribution.campaign_contact_id')
    .leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'cc.id')
    .where('cc.status', 'active')
    .where('attribution.interaction_type', 'session_answer')
    .whereRaw('(progress.reset_at IS NULL OR incoming.received_at > progress.reset_at)')
    .select('attribution.campaign_id')
    .countDistinct({ responded_count: 'attribution.campaign_contact_id' })
    .max({ last_response_at: 'incoming.received_at' })
    .groupBy('attribution.campaign_id')
    .as('response_metrics');
}

function messageAggregate(database = knex) {
  return database('messages')
    .whereNotNull('campaign_id')
    .select('campaign_id')
    .select(database.raw("SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_message_count"))
    .select(database.raw("SUM(CASE WHEN status IN ('queued', 'processing') THEN 1 ELSE 0 END) AS active_message_count"))
    .max({ last_message_at: 'created_at' })
    .groupBy('campaign_id')
    .as('message_metrics');
}

function jobAggregate(database = knex) {
  return database('message_jobs as jobs')
    .join('messages', 'messages.id', 'jobs.message_id')
    .whereNotNull('messages.campaign_id')
    .select('messages.campaign_id')
    .select(database.raw("SUM(CASE WHEN jobs.status IN ('pending', 'reserved', 'processing') THEN 1 ELSE 0 END) AS active_job_count"))
    .select(database.raw(`SUM(CASE
      WHEN jobs.status = 'pending' AND jobs.available_at <= UTC_TIMESTAMP()
        AND jobs.created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 15 MINUTE) THEN 1
      WHEN jobs.status IN ('reserved', 'processing') AND jobs.locked_at IS NOT NULL
        AND jobs.locked_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 15 MINUTE) THEN 1
      ELSE 0 END) AS stuck_job_count`))
    .groupBy('messages.campaign_id')
    .as('job_metrics');
}

function baseCampaignQuery(database = knex) {
  return database('campaigns')
    .join('contact_groups as university', 'university.id', 'campaigns.university_group_id')
    .leftJoin('contact_groups as faculty', 'faculty.id', 'campaigns.faculty_group_id')
    .leftJoin('contact_groups as study_program', 'study_program.id', 'campaigns.study_program_group_id')
    .join('users as operator', 'operator.id', 'campaigns.operator_user_id');
}

function campaignMetricsQuery(database = knex) {
  return baseCampaignQuery(database)
    .leftJoin(progressAggregate(database), 'progress_metrics.campaign_id', 'campaigns.id')
    .leftJoin(responseAggregate(database), 'response_metrics.campaign_id', 'campaigns.id')
    .leftJoin(messageAggregate(database), 'message_metrics.campaign_id', 'campaigns.id')
    .leftJoin(jobAggregate(database), 'job_metrics.campaign_id', 'campaigns.id')
    .select(
      'campaigns.id', 'campaigns.public_id', 'campaigns.title', 'campaigns.status',
      'campaigns.operator_user_id', 'campaigns.created_at', 'campaigns.updated_at',
      'university.name as university_name', 'university.code as university_code',
      'faculty.name as faculty_name', 'faculty.code as faculty_code',
      'study_program.name as study_program_name', 'study_program.code as study_program_code',
      'operator.name as operator_name',
      'progress_metrics.target_count', 'progress_metrics.not_started_count',
      'progress_metrics.in_progress_count', 'progress_metrics.completed_count',
      'progress_metrics.review_pending_details_count', 'progress_metrics.needs_review_count',
      'progress_metrics.stopped_count',
      'response_metrics.responded_count', 'response_metrics.last_response_at',
      'message_metrics.failed_message_count', 'message_metrics.active_message_count',
      'message_metrics.last_message_at',
      'job_metrics.active_job_count', 'job_metrics.stuck_job_count',
    );
}

function numeric(value) {
  return Number(value || 0);
}

function latestDate(...values) {
  const dates = values.filter(Boolean).map((value) => new Date(value)).filter((date) => !Number.isNaN(date.getTime()));
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime()))).toISOString();
}

function normalizeCampaign(row) {
  const targetCount = numeric(row.target_count);
  const respondedCount = numeric(row.responded_count);
  const completedCount = numeric(row.completed_count);
  const reviewPendingDetailsCount = numeric(row.review_pending_details_count);
  const needsReviewCount = numeric(row.needs_review_count);
  const failedMessageCount = numeric(row.failed_message_count);
  const stuckJobCount = numeric(row.stuck_job_count);
  return {
    public_id: row.public_id,
    title: row.title,
    status: row.status,
    operator_user_id: numeric(row.operator_user_id),
    operator_name: row.operator_name,
    scope: {
      university: { code: row.university_code, name: row.university_name },
      faculty: row.faculty_name ? { code: row.faculty_code, name: row.faculty_name } : null,
      study_program: row.study_program_name ? { code: row.study_program_code, name: row.study_program_name } : null,
    },
    metrics: {
      target: targetCount,
      responded: respondedCount,
      not_started: numeric(row.not_started_count),
      in_progress: numeric(row.in_progress_count),
      completed: completedCount,
      review_pending_details: reviewPendingDetailsCount,
      needs_review: needsReviewCount,
      stopped: numeric(row.stopped_count),
      failed_messages: failedMessageCount,
      active_messages: numeric(row.active_message_count),
      active_jobs: numeric(row.active_job_count),
      stuck_jobs: stuckJobCount,
      response_rate: targetCount ? Number(((respondedCount / targetCount) * 100).toFixed(1)) : 0,
      completion_rate: targetCount ? Number(((completedCount / targetCount) * 100).toFixed(1)) : 0,
    },
    attention_count: reviewPendingDetailsCount + needsReviewCount + failedMessageCount + stuckJobCount,
    last_activity_at: latestDate(row.updated_at, row.last_response_at, row.last_message_at),
  };
}

function calculateOverview(campaigns) {
  const metrics = campaigns.reduce((result, campaign) => {
    result.campaign_count += 1;
    if (campaign.status === 'active') result.active_campaigns += 1;
    result.alumni_memberships += campaign.metrics.target;
    result.responded += campaign.metrics.responded;
    result.not_started += campaign.metrics.not_started;
    result.in_progress += campaign.metrics.in_progress;
    result.completed += campaign.metrics.completed;
    result.needs_attention += campaign.metrics.review_pending_details + campaign.metrics.needs_review;
    result.failed_messages += campaign.metrics.failed_messages;
    result.stuck_jobs += campaign.metrics.stuck_jobs;
    result.active_jobs += campaign.metrics.active_jobs;
    return result;
  }, {
    campaign_count: 0,
    active_campaigns: 0,
    alumni_memberships: 0,
    responded: 0,
    not_started: 0,
    in_progress: 0,
    completed: 0,
    needs_attention: 0,
    failed_messages: 0,
    stuck_jobs: 0,
    active_jobs: 0,
  });
  metrics.response_rate = metrics.alumni_memberships
    ? Number(((metrics.responded / metrics.alumni_memberships) * 100).toFixed(1)) : 0;
  metrics.completion_rate = metrics.alumni_memberships
    ? Number(((metrics.completed / metrics.alumni_memberships) * 100).toFixed(1)) : 0;

  const actionItems = campaigns.filter((campaign) => campaign.attention_count > 0)
    .sort((left, right) => right.attention_count - left.attention_count
      || new Date(right.last_activity_at || 0) - new Date(left.last_activity_at || 0))
    .slice(0, 10)
    .map((campaign) => ({
      campaign_public_id: campaign.public_id,
      campaign_title: campaign.title,
      operator_name: campaign.operator_name,
      status: campaign.status,
      correction_count: campaign.metrics.review_pending_details + campaign.metrics.needs_review,
      failed_message_count: campaign.metrics.failed_messages,
      stuck_job_count: campaign.metrics.stuck_jobs,
      total: campaign.attention_count,
    }));
  return { metrics, action_items: actionItems };
}

async function metadata(req) {
  const actor = actorFromRequest(req);
  const query = baseCampaignQuery().select(
    'campaigns.public_id', 'campaigns.title', 'campaigns.status', 'campaigns.operator_user_id',
    'campaigns.university_group_id', 'campaigns.faculty_group_id', 'campaigns.study_program_group_id',
    'operator.name as operator_name',
    'university.code as university_code', 'university.name as university_name',
    'faculty.code as faculty_code', 'faculty.name as faculty_name',
    'study_program.code as study_program_code', 'study_program.name as study_program_name',
  );
  applyScope(query, actor, 'campaigns');
  const campaigns = await query.orderBy('campaigns.title');
  const operators = new Map();
  const groups = new Map();
  campaigns.forEach((campaign) => {
    operators.set(Number(campaign.operator_user_id), {
      id: Number(campaign.operator_user_id), name: campaign.operator_name,
    });
    groups.set(`university:${campaign.university_group_id}`, {
      id: Number(campaign.university_group_id), parent_id: null, type: 'university',
      code: campaign.university_code, name: campaign.university_name,
    });
    if (campaign.faculty_group_id) {
      groups.set(`faculty:${campaign.faculty_group_id}`, {
        id: Number(campaign.faculty_group_id), parent_id: Number(campaign.university_group_id), type: 'faculty',
        code: campaign.faculty_code, name: campaign.faculty_name,
      });
    }
    if (campaign.study_program_group_id) {
      groups.set(`study_program:${campaign.study_program_group_id}`, {
        id: Number(campaign.study_program_group_id), parent_id: Number(campaign.faculty_group_id), type: 'study_program',
        code: campaign.study_program_code, name: campaign.study_program_name,
      });
    }
  });
  return {
    campaigns: campaigns.map((campaign) => ({
      public_id: campaign.public_id,
      title: campaign.title,
      status: campaign.status,
      operator_user_id: Number(campaign.operator_user_id),
      university_group_id: Number(campaign.university_group_id),
      faculty_group_id: campaign.faculty_group_id ? Number(campaign.faculty_group_id) : null,
      study_program_group_id: campaign.study_program_group_id ? Number(campaign.study_program_group_id) : null,
    })),
    operators: [...operators.values()].sort((left, right) => left.name.localeCompare(right.name, 'id')),
    groups: [...groups.values()].sort((left, right) => left.name.localeCompare(right.name, 'id')),
  };
}

async function summary(req, rawFilters = {}) {
  const actor = actorFromRequest(req);
  const filters = parseFilters(rawFilters);
  await validateFilters(actor, filters);
  const rows = await applyFilters(campaignMetricsQuery(), actor, filters).orderBy('campaigns.updated_at', 'desc');
  return {
    ...calculateOverview(rows.map(normalizeCampaign)),
    generated_at: new Date().toISOString(),
  };
}

async function campaigns(req, rawFilters = {}) {
  const actor = actorFromRequest(req);
  const filters = parseFilters(rawFilters);
  await validateFilters(actor, filters);
  const countQuery = applyFilters(baseCampaignQuery(), actor, filters);
  const [countRows, rows] = await Promise.all([
    countQuery.countDistinct({ count: 'campaigns.id' }),
    applyFilters(campaignMetricsQuery(), actor, filters)
      .orderBy('campaigns.updated_at', 'desc')
      .limit(filters.limit)
      .offset((filters.page - 1) * filters.limit),
  ]);
  const total = numeric(countRows[0]?.count);
  return {
    data: rows.map(normalizeCampaign),
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / filters.limit)),
    },
  };
}

async function exportContacts(req, rawFilters = {}) {
  const actor = actorFromRequest(req);
  const filters = parseFilters({ ...rawFilters, page: 1, limit: 100 });
  await validateFilters(actor, filters);
  const campaignRows = await applyFilters(baseCampaignQuery(), actor, filters)
    .select('campaigns.id').orderBy('campaigns.id');
  const campaignIds = campaignRows.map((row) => Number(row.id));
  const waveOne = await knex('campaigns').where('title', 'UMI/FIKOM/TI/2025-Wave1').first('id');
  if (!waveOne) throw httpError(422, 'Campaign acuan Wave 1 tidak ditemukan; export dibatalkan agar kolom pertanyaan tidak berubah.', 'CAMPAIGN_MONITORING_WAVE_ONE_NOT_FOUND');
  const canonicalQuestions = await knex('campaign_questions as question')
    .join('campaign_questionnaires as questionnaire', 'questionnaire.id', 'question.questionnaire_id')
    .where({ 'question.campaign_id': waveOne.id, 'questionnaire.is_current': true, 'question.is_active': true })
    .select('question.public_id', 'question.position', 'question.title').orderBy('question.position');
  if (!canonicalQuestions.length) throw httpError(422, 'Questionnaire aktif Wave 1 tidak tersedia; export dibatalkan.', 'CAMPAIGN_MONITORING_WAVE_ONE_QUESTIONNAIRE_NOT_FOUND');
  const questionColumns = canonicalQuestions.map((question) => ({ publicId: question.public_id, position: Number(question.position), header: `P${question.position} - ${question.title}`, matchKey: questionMatchKey(question.title) }));
  if (!campaignIds.length) return { workbook: buildCampaignMonitoringWorkbook({ campaign: { title: 'Monitoring Campaign' }, contacts: [], answers: [], filters, canonicalQuestions: questionColumns }), contact_count: 0, answer_count: 0 };
  let contacts = await knex('campaign_contacts as cc')
    .join('campaigns', 'campaigns.id', 'cc.campaign_id')
    .join('contacts', 'contacts.id', 'cc.contact_id')
    .leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'cc.id')
    .leftJoin('campaign_questions as current_question', 'current_question.id', 'progress.current_question_id')
    .leftJoin('contact_academic_profiles as profile', function joinProfile() { this.on('profile.contact_id', '=', 'contacts.id').andOn('profile.university_group_id', '=', 'campaigns.university_group_id'); })
    .leftJoin('contact_groups as university', 'university.id', 'profile.university_group_id')
    .leftJoin('contact_groups as faculty', 'faculty.id', 'profile.faculty_group_id')
    .leftJoin('contact_groups as study_program', 'study_program.id', 'profile.study_program_group_id')
    .whereIn('cc.campaign_id', campaignIds).where('cc.status', 'active').whereNull('contacts.deleted_at')
    .select('cc.id as membership_id', 'campaigns.title as campaign_title', 'contacts.name', 'contacts.phone_e164', 'profile.student_number', 'profile.entry_year', 'university.name as university_name', 'faculty.name as faculty_name', 'study_program.name as study_program_name', knex.raw("COALESCE(progress.status, 'not_started') AS progress_status"), 'current_question.title as current_question_title', 'progress.started_at', 'progress.completed_at')
    .orderBy('campaigns.title').orderBy('contacts.name').limit(10001);
  if (contacts.length > 10000) throw httpError(413, 'Export dibatasi maksimal 10.000 alumni. Persempit filter lalu coba lagi.', 'CAMPAIGN_MONITORING_EXPORT_CONTACT_LIMIT');
  const membershipIds = contacts.map((contact) => Number(contact.membership_id));
  let answers = membershipIds.length ? await knex('campaign_incoming_messages as attribution')
    .join('incoming_messages as incoming', 'incoming.id', 'attribution.incoming_message_id').join('campaign_contacts as membership', 'membership.id', 'attribution.campaign_contact_id').join('contacts', 'contacts.id', 'membership.contact_id').leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'membership.id').join('campaign_questions as question', 'question.id', 'attribution.campaign_question_id').leftJoin('campaign_questionnaires as questionnaire', 'questionnaire.id', 'question.questionnaire_id').leftJoin('campaign_question_options as selected_option', 'selected_option.id', 'attribution.campaign_question_option_id')
    .where('attribution.interaction_type', 'session_answer').whereIn('membership.id', membershipIds).whereRaw('(progress.reset_at IS NULL OR incoming.received_at > progress.reset_at)')
    .select('membership.id as membership_id', 'contacts.name', 'contacts.phone_e164', 'incoming.body as raw_answer', 'incoming.session_number', 'incoming.received_at', 'question.public_id as question_public_id', 'question.position as question_position', 'question.title as question_title', 'question.question_text', 'question.answer_type', 'selected_option.answer_text as selected_answer_text', 'questionnaire.name as questionnaire_name', 'questionnaire.version as questionnaire_version').orderBy('incoming.received_at').limit(150001) : [];
  if (answers.length > 150000) throw httpError(413, 'Export dibatasi maksimal 150.000 input jawaban. Persempit filter lalu coba lagi.', 'CAMPAIGN_MONITORING_EXPORT_ANSWER_LIMIT');
  if (shouldMaskPersonalData(req)) {
    contacts = contacts.map((contact) => ({ ...contact, name: '[MASKED]', phone_e164: maskPhone(contact.phone_e164), student_number: contact.student_number ? '[MASKED]' : null }));
    answers = answers.map((answer) => ({ ...answer, name: '[MASKED]', phone_e164: maskPhone(answer.phone_e164), raw_answer: answer.raw_answer ? '[MASKED]' : '' }));
  }
  const workbook = buildCampaignMonitoringWorkbook({ campaign: { title: 'Monitoring Campaign' }, contacts, answers, filters, canonicalQuestions: questionColumns });
  return { workbook, contact_count: contacts.length, answer_count: answers.length };
}

module.exports = {
  parseFilters,
  calculateOverview,
  metadata,
  summary,
  campaigns,
  exportContacts,
};
