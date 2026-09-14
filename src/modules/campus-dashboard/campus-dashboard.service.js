const { z } = require('zod');
const knex = require('../../database/knex');
const { shouldMaskPersonalData } = require('../../shared/data-masking');
const { actorFromRequest, applyScope, findScopedCampaign } = require('../campaigns/campaigns.service');

const optionalId = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.coerce.number().int().positive().optional(),
);
const optionalCampaignId = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.string().uuid().optional(),
);
const filterSchema = z.object({
  campaign_public_id: optionalCampaignId,
  university_group_id: optionalId,
  faculty_group_id: optionalId,
  study_program_group_id: optionalId,
  trend_days: z.coerce.number().int().pipe(z.union([z.literal(7), z.literal(30), z.literal(90)])).default(30),
});
const answerFilterSchema = filterSchema.extend({
  question_public_id: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
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

function assertAcademicHierarchy(filters, groups) {
  const byId = new Map(groups.map((group) => [Number(group.id), group]));
  const university = filters.university_group_id ? byId.get(filters.university_group_id) : null;
  const faculty = filters.faculty_group_id ? byId.get(filters.faculty_group_id) : null;
  const studyProgram = filters.study_program_group_id ? byId.get(filters.study_program_group_id) : null;

  if (filters.university_group_id && university?.type !== 'university') {
    throw httpError(422, 'Universitas tidak valid', 'INVALID_CAMPUS_FILTER');
  }
  if (filters.faculty_group_id && !filters.university_group_id) {
    throw httpError(422, 'Pilih universitas sebelum fakultas', 'FACULTY_REQUIRES_UNIVERSITY');
  }
  if (filters.faculty_group_id
      && (faculty?.type !== 'faculty' || Number(faculty.parent_id) !== Number(university.id))) {
    throw httpError(422, 'Fakultas tidak berada pada universitas terpilih', 'FACULTY_UNIVERSITY_MISMATCH');
  }
  if (filters.study_program_group_id && !filters.faculty_group_id) {
    throw httpError(422, 'Pilih fakultas sebelum program studi', 'STUDY_PROGRAM_REQUIRES_FACULTY');
  }
  if (filters.study_program_group_id
      && (studyProgram?.type !== 'study_program' || Number(studyProgram.parent_id) !== Number(faculty.id))) {
    throw httpError(422, 'Program studi tidak berada pada fakultas terpilih', 'STUDY_PROGRAM_FACULTY_MISMATCH');
  }
}

async function validateFilters(actor, filters) {
  if (filters.campaign_public_id) {
    const campaign = await findScopedCampaign(filters.campaign_public_id, actor);
    if (filters.university_group_id
        && Number(campaign.university_group_id) !== Number(filters.university_group_id)) {
      throw httpError(422, 'Campaign tidak berada pada universitas terpilih', 'CAMPAIGN_UNIVERSITY_MISMATCH');
    }
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
}

function applyDashboardFilters(query, filters) {
  if (filters.campaign_public_id) query.where('campaigns.public_id', filters.campaign_public_id);
  if (filters.university_group_id) query.where('profile.university_group_id', filters.university_group_id);
  if (filters.faculty_group_id) query.where('profile.faculty_group_id', filters.faculty_group_id);
  if (filters.study_program_group_id) query.where('profile.study_program_group_id', filters.study_program_group_id);
  return query;
}

function participantQuery(actor, filters, database = knex) {
  const query = database('campaign_contacts as cc')
    .join('campaigns', 'campaigns.id', 'cc.campaign_id')
    .join('contact_academic_profiles as profile', function joinAcademicProfile() {
      this.on('profile.contact_id', '=', 'cc.contact_id')
        .andOn('profile.university_group_id', '=', 'campaigns.university_group_id');
    })
    .where('cc.status', 'active');
  applyScope(query, actor, 'campaigns');
  return applyDashboardFilters(query, filters);
}

function answerQuery(actor, filters, database = knex) {
  const query = database('campaign_incoming_messages as attribution')
    .join('incoming_messages as incoming', 'incoming.id', 'attribution.incoming_message_id')
    .join('campaign_contacts as cc', function joinMembership() {
      this.on('cc.id', '=', 'attribution.campaign_contact_id')
        .andOn('cc.campaign_id', '=', 'attribution.campaign_id');
    })
    .join('campaigns', 'campaigns.id', 'attribution.campaign_id')
    .join('contact_academic_profiles as profile', function joinAcademicProfile() {
      this.on('profile.contact_id', '=', 'cc.contact_id')
        .andOn('profile.university_group_id', '=', 'campaigns.university_group_id');
    })
    .leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'cc.id')
    .join('campaign_questions as question', 'question.id', 'attribution.campaign_question_id')
    .join('campaign_questionnaires as questionnaire', 'questionnaire.id', 'question.questionnaire_id')
    .leftJoin('campaign_question_options as selected_option', 'selected_option.id', 'attribution.campaign_question_option_id')
    .where('cc.status', 'active')
    .where('attribution.interaction_type', 'session_answer')
    .whereRaw('(progress.reset_at IS NULL OR incoming.received_at > progress.reset_at)')
    .where((builder) => builder.where('question.answer_type', 'free_text')
      .orWhereNotNull('attribution.campaign_question_option_id'));
  applyScope(query, actor, 'campaigns');
  return applyDashboardFilters(query, filters);
}

function academicUnitQuery(query, level, countColumn, countAlias) {
  const isProgram = level === 'study_program';
  query.join('contact_groups as academic_unit', 'academic_unit.id', isProgram
    ? 'profile.study_program_group_id'
    : 'profile.faculty_group_id')
    .join('contact_groups as academic_university', 'academic_university.id', 'profile.university_group_id');
  if (isProgram) query.join('contact_groups as academic_faculty', 'academic_faculty.id', 'profile.faculty_group_id');
  return query.select(
    'academic_unit.id as unit_id', 'academic_unit.code as unit_code', 'academic_unit.name as unit_name',
    'academic_university.code as university_code', 'academic_university.name as university_name',
    ...(isProgram ? ['academic_faculty.code as faculty_code', 'academic_faculty.name as faculty_name'] : []),
  ).countDistinct({ [countAlias]: countColumn })
    .groupBy(
      'academic_unit.id', 'academic_unit.code', 'academic_unit.name',
      'academic_university.code', 'academic_university.name',
      ...(isProgram ? ['academic_faculty.code', 'academic_faculty.name'] : []),
    );
}

function buildTrendSeries(rows, days, localToday) {
  const byDate = new Map(rows.map((row) => [String(row.report_date), {
    answer_count: Number(row.answer_count || 0),
    respondent_count: Number(row.respondent_count || 0),
  }]));
  const end = new Date(`${localToday}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (days - index - 1));
    const reportDate = date.toISOString().slice(0, 10);
    return { report_date: reportDate, ...(byDate.get(reportDate) || { answer_count: 0, respondent_count: 0 }) };
  });
}

function uniqueGroups(rows, type) {
  const map = new Map();
  rows.forEach((row) => {
    const id = row[`${type}_id`];
    if (!id || map.has(Number(id))) return;
    map.set(Number(id), {
      id: Number(id),
      parent_id: row[`${type}_parent_id`] ? Number(row[`${type}_parent_id`]) : null,
      type,
      code: row[`${type}_code`],
      name: row[`${type}_name`],
    });
  });
  return [...map.values()].sort((left, right) => left.name.localeCompare(right.name, 'id'));
}

async function metadata(req) {
  const actor = actorFromRequest(req);
  const campaignsQuery = knex('campaigns')
    .join('contact_groups as university', 'university.id', 'campaigns.university_group_id')
    .leftJoin('contact_groups as faculty', 'faculty.id', 'campaigns.faculty_group_id')
    .leftJoin('contact_groups as study_program', 'study_program.id', 'campaigns.study_program_group_id');
  applyScope(campaignsQuery, actor, 'campaigns');
  const campaigns = await campaignsQuery.select(
    'campaigns.public_id', 'campaigns.title', 'campaigns.status',
    'campaigns.university_group_id', 'campaigns.faculty_group_id', 'campaigns.study_program_group_id',
    'university.code as university_code', 'university.name as university_name',
    'faculty.name as faculty_name', 'study_program.name as study_program_name',
  ).orderBy('campaigns.title');

  const scopeQuery = participantQuery(actor, {})
    .join('contact_groups as university', 'university.id', 'profile.university_group_id')
    .join('contact_groups as faculty', 'faculty.id', 'profile.faculty_group_id')
    .join('contact_groups as study_program', 'study_program.id', 'profile.study_program_group_id');
  const academicScopes = await scopeQuery.distinct(
    'campaigns.public_id as campaign_public_id',
    'university.id as university_id', 'university.code as university_code', 'university.name as university_name',
    'faculty.id as faculty_id', 'faculty.parent_id as faculty_parent_id', 'faculty.code as faculty_code', 'faculty.name as faculty_name',
    'study_program.id as study_program_id', 'study_program.parent_id as study_program_parent_id',
    'study_program.code as study_program_code', 'study_program.name as study_program_name',
  ).orderBy('university.name').orderBy('faculty.name').orderBy('study_program.name');

  const universityRows = campaigns.map((campaign) => ({
    university_id: campaign.university_group_id,
    university_parent_id: null,
    university_code: campaign.university_code,
    university_name: campaign.university_name,
  }));
  return {
    campaigns: campaigns.map((campaign) => ({
      ...campaign,
      university_group_id: Number(campaign.university_group_id),
      faculty_group_id: campaign.faculty_group_id ? Number(campaign.faculty_group_id) : null,
      study_program_group_id: campaign.study_program_group_id ? Number(campaign.study_program_group_id) : null,
    })),
    groups: [
      ...uniqueGroups([...universityRows, ...academicScopes], 'university'),
      ...uniqueGroups(academicScopes, 'faculty'),
      ...uniqueGroups(academicScopes, 'study_program'),
    ],
    academic_scopes: academicScopes.map((scope) => ({
      campaign_public_id: scope.campaign_public_id,
      university_group_id: Number(scope.university_id),
      faculty_group_id: Number(scope.faculty_id),
      study_program_group_id: Number(scope.study_program_id),
    })),
  };
}

async function summary(req, rawFilters = {}) {
  const actor = actorFromRequest(req);
  const filters = parseFilters(rawFilters);
  await validateFilters(actor, filters);

  const questionQuery = answerQuery(actor, filters).select(
    'campaigns.public_id as campaign_public_id', 'campaigns.title as campaign_title',
    'questionnaire.public_id as questionnaire_public_id', 'questionnaire.version as questionnaire_version',
    'questionnaire.name as questionnaire_name', 'question.id as question_id', 'question.public_id as question_public_id',
    'question.position', 'question.title', 'question.question_text', 'question.answer_type',
  ).countDistinct({ response_count: 'attribution.id' })
    .countDistinct({ respondent_count: 'cc.contact_id' })
    .max({ last_response_at: 'incoming.received_at' })
    .groupBy(
      'campaigns.public_id', 'campaigns.title', 'questionnaire.public_id', 'questionnaire.version',
      'questionnaire.name', 'question.id', 'question.public_id', 'question.position',
      'question.title', 'question.question_text', 'question.answer_type',
    )
    .orderBy('campaigns.title').orderBy('questionnaire.version').orderBy('question.position');

  const academicLevel = filters.faculty_group_id ? 'study_program' : 'faculty';
  const progressQuery = participantQuery(actor, filters)
    .leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'cc.id')
    .select(knex.raw("COALESCE(progress.status, 'not_started') AS progress_status"))
    .countDistinct({ count: 'cc.id' })
    .groupByRaw("COALESCE(progress.status, 'not_started')");
  const academicParticipantQuery = academicUnitQuery(
    participantQuery(actor, filters), academicLevel, 'cc.contact_id', 'alumni_count',
  );
  const academicRespondentQuery = academicUnitQuery(
    answerQuery(actor, filters), academicLevel, 'cc.contact_id', 'respondent_count',
  );
  const trendDateExpression = "DATE_FORMAT(CONVERT_TZ(incoming.received_at, '+00:00', '+08:00'), '%Y-%m-%d')";
  const trendQuery = answerQuery(actor, filters)
    .whereRaw(`incoming.received_at >= CONVERT_TZ(DATE_SUB(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+08:00')), INTERVAL ? DAY), '+08:00', '+00:00')`, [filters.trend_days - 1])
    .select(knex.raw(`${trendDateExpression} AS report_date`))
    .countDistinct({ answer_count: 'attribution.id' })
    .countDistinct({ respondent_count: 'cc.contact_id' })
    .groupByRaw(trendDateExpression)
    .orderBy('report_date');

  const [
    activeAlumniRow, respondentRow, answerRow, completedRow, campaignRow, questionRows,
    progressRows, academicParticipantRows, academicRespondentRows, trendRows, localTodayRow,
  ] = await Promise.all([
    participantQuery(actor, filters).countDistinct({ count: 'cc.contact_id' }).first(),
    answerQuery(actor, filters).countDistinct({ count: 'cc.contact_id' }).first(),
    answerQuery(actor, filters).countDistinct({ count: 'attribution.id' }).first(),
    participantQuery(actor, filters).join('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'cc.id')
      .where('progress.status', 'completed').countDistinct({ count: 'cc.contact_id' }).first(),
    participantQuery(actor, filters).countDistinct({ count: 'campaigns.id' }).first(),
    questionQuery,
    progressQuery,
    academicParticipantQuery,
    academicRespondentQuery,
    trendQuery,
    knex.select(knex.raw("DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+08:00'), '%Y-%m-%d') AS local_today")).first(),
  ]);

  const questionIds = questionRows.map((question) => Number(question.question_id));
  const [configuredOptions, selectedOptions] = questionIds.length ? await Promise.all([
    knex('campaign_question_options').whereIn('campaign_question_id', questionIds)
      .select('id', 'campaign_question_id', 'position', 'answer_text', 'is_active').orderBy('position'),
    answerQuery(actor, filters).whereIn('question.id', questionIds).whereNotNull('selected_option.id')
      .select('question.id as question_id', 'selected_option.id as option_id')
      .countDistinct({ count: 'attribution.id' })
      .groupBy('question.id', 'selected_option.id'),
  ]) : [[], []];
  const selectedCount = new Map(selectedOptions.map((row) => [
    `${Number(row.question_id)}:${Number(row.option_id)}`,
    Number(row.count),
  ]));
  const optionsByQuestion = new Map();
  configuredOptions.forEach((option) => {
    const questionId = Number(option.campaign_question_id);
    if (!optionsByQuestion.has(questionId)) optionsByQuestion.set(questionId, []);
    optionsByQuestion.get(questionId).push({
      position: Number(option.position),
      answer_text: option.answer_text,
      is_active: Number(option.is_active) === 1,
      count: selectedCount.get(`${questionId}:${Number(option.id)}`) || 0,
    });
  });

  const activeAlumni = Number(activeAlumniRow?.count || 0);
  const respondents = Number(respondentRow?.count || 0);
  const academicRespondents = new Map(academicRespondentRows.map((row) => [Number(row.unit_id), Number(row.respondent_count || 0)]));
  const progressStatuses = [
    'not_started', 'in_progress', 'review_pending_details', 'completed', 'needs_review', 'stopped',
  ];
  return {
    filters,
    metrics: {
      campaign_count: Number(campaignRow?.count || 0),
      active_alumni: activeAlumni,
      respondents,
      completed: Number(completedRow?.count || 0),
      answer_count: Number(answerRow?.count || 0),
      response_rate: activeAlumni ? Number(((respondents / activeAlumni) * 100).toFixed(1)) : 0,
    },
    questions: questionRows.map((question) => {
      const responseCount = Number(question.response_count || 0);
      return {
        campaign_public_id: question.campaign_public_id,
        campaign_title: question.campaign_title,
        questionnaire_public_id: question.questionnaire_public_id,
        questionnaire_version: Number(question.questionnaire_version),
        questionnaire_name: question.questionnaire_name,
        question_public_id: question.question_public_id,
        position: Number(question.position),
        title: question.title,
        question_text: question.question_text,
        answer_type: question.answer_type,
        response_count: responseCount,
        respondent_count: Number(question.respondent_count || 0),
        last_response_at: question.last_response_at,
        options: (optionsByQuestion.get(Number(question.question_id)) || []).map((option) => ({
          ...option,
          percentage: responseCount ? Number(((option.count / responseCount) * 100).toFixed(1)) : 0,
        })),
      };
    }),
    charts: {
      academic_response_rates: {
        level: academicLevel,
        data: academicParticipantRows.map((row) => {
          const alumniCount = Number(row.alumni_count || 0);
          const respondentCount = academicRespondents.get(Number(row.unit_id)) || 0;
          return {
            unit_id: Number(row.unit_id),
            unit_code: row.unit_code,
            unit_name: row.unit_name,
            context: academicLevel === 'study_program'
              ? `${row.university_code} / ${row.faculty_code}`
              : `${row.university_code} — ${row.university_name}`,
            alumni_count: alumniCount,
            respondent_count: respondentCount,
            response_rate: alumniCount ? Number(((respondentCount / alumniCount) * 100).toFixed(1)) : 0,
          };
        }).sort((left, right) => right.response_rate - left.response_rate || left.unit_name.localeCompare(right.unit_name, 'id')),
      },
      progress: progressStatuses.map((status) => ({
        status,
        count: Number(progressRows.find((row) => row.progress_status === status)?.count || 0),
      })),
      response_trend: {
        days: filters.trend_days,
        data: buildTrendSeries(trendRows, filters.trend_days, localTodayRow.local_today),
      },
    },
    generated_at: new Date().toISOString(),
  };
}

async function answers(req, rawFilters = {}) {
  const actor = actorFromRequest(req);
  const value = answerFilterSchema.parse(rawFilters);
  const filters = parseFilters(value);
  await validateFilters(actor, filters);

  const questionQuery = knex('campaign_questions as question')
    .join('campaigns', 'campaigns.id', 'question.campaign_id')
    .join('campaign_questionnaires as questionnaire', 'questionnaire.id', 'question.questionnaire_id')
    .where('question.public_id', value.question_public_id);
  applyScope(questionQuery, actor, 'campaigns');
  const question = await questionQuery.select(
    'question.id', 'question.public_id', 'question.title', 'question.answer_type',
    'campaigns.public_id as campaign_public_id', 'campaigns.title as campaign_title',
    'questionnaire.version as questionnaire_version',
  ).first();
  if (!question || (filters.campaign_public_id && filters.campaign_public_id !== question.campaign_public_id)) {
    throw httpError(404, 'Pertanyaan Dashboard Kampus tidak ditemukan', 'CAMPUS_DASHBOARD_QUESTION_NOT_FOUND');
  }

  const base = () => answerQuery(actor, filters).where('question.id', question.id);
  const [{ count }, rows] = await Promise.all([
    base().countDistinct({ count: 'attribution.id' }).first(),
    base().select(
      'incoming.public_id', 'incoming.body', 'incoming.received_at',
      'selected_option.answer_text as selected_answer_text',
    ).orderBy('incoming.received_at', 'desc')
      .limit(value.limit).offset((value.page - 1) * value.limit),
  ]);
  const mask = shouldMaskPersonalData(req);
  return {
    question: {
      public_id: question.public_id,
      title: question.title,
      answer_type: question.answer_type,
      campaign_public_id: question.campaign_public_id,
      campaign_title: question.campaign_title,
      questionnaire_version: Number(question.questionnaire_version),
    },
    data: rows.map((row) => ({
      public_id: row.public_id,
      answer: mask ? '[MASKED]' : (row.selected_answer_text || row.body),
      received_at: row.received_at,
    })),
    pagination: {
      page: value.page,
      limit: value.limit,
      total: Number(count || 0),
      total_pages: Math.max(1, Math.ceil(Number(count || 0) / value.limit)),
    },
  };
}

module.exports = {
  parseFilters,
  assertAcademicHierarchy,
  buildTrendSeries,
  metadata,
  summary,
  answers,
};
