const crypto = require('crypto');
const { z } = require('zod');
const knex = require('../../database/knex');
const env = require('../../config/env');
const { resolveSelectedGrouping } = require('../contact-groups/group-hierarchy');
const { normalizePhone } = require('../../shared/phone');
const {
  isValidEmail,
  normalizeEmail,
  parseEntryYear,
} = require('../contact-imports/academic-import-format');
const { manager: whatsappManager } = require('../whatsapp/whatsapp-client-manager');
const broadcastsService = require('../broadcasts/broadcasts.service');
const { shouldMaskPersonalData, maskEmail, maskPhone } = require('../../shared/data-masking');
const {
  findEligibleTargetContact,
  listTargetContacts,
  parseReblastTarget,
  targetContactIds,
  withReblastConfirmationPrompt,
} = require('./campaign-reblast');
const {
  attributeAndAdvance,
  resumeReviewedContactInTransaction,
} = require('./campaign-attribution');
const { parseStoredReviewFields, reviewFieldLabels } = require('./campaign-review-fields');
const {
  getCurrentQuestionnaire,
  hydrateQuestions,
  normalizeAnswer,
  QUESTION_VARIABLES,
} = require('./campaign-questions');
const { createTracerStudyQuestionnaire } = require('./tracer-questionnaire');
const { buildCampaignMonitoringWorkbook } = require('./campaign-monitoring-export');

const MONITORING_EXPORT_MAX_CONTACTS = 10000;
const MONITORING_EXPORT_MAX_ANSWERS = 150000;

const campaignInputSchema = z.object({
  title: z.string().trim().min(3).max(180),
  description: z.string().trim().max(2000).nullable().optional(),
  university_group_id: z.coerce.number().int().positive(),
  faculty_group_id: z.union([z.coerce.number().int().positive(), z.literal(''), z.null()]).optional(),
  study_program_group_id: z.union([z.coerce.number().int().positive(), z.literal(''), z.null()]).optional(),
  operator_user_id: z.coerce.number().int().positive(),
});

const updateCampaignSchema = campaignInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'Minimal satu field harus diubah',
);
const campaignDeleteSchema = z.object({
  confirmation: z.literal('HAPUS'),
}).strict();
const campaignQuestionSourceSchema = z.object({
  search: z.string().trim().max(180).optional().default(''),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});
const campaignQuestionImportSchema = z.object({
  source_campaign_public_id: z.string().uuid(),
});
const reblastTargetPreviewSchema = z.object({
  mode: z.enum(['no_reply', 'stalled']),
  body: z.string().trim().min(1).max(9800),
}).strict();
const campaignQuestionOptionSchema = z.union([
  z.string().trim().min(1).max(500).transform((answerText) => ({
    answer_text: answerText,
    action_type: 'next',
    next_question_public_id: null,
  })),
  z.object({
    answer_text: z.string().trim().min(1).max(500),
    action_type: z.enum(['next', 'goto', 'review', 'complete']).default('next'),
    next_question_public_id: z.string().uuid().nullable().optional().default(null),
  }),
]);
const campaignQuestionSchema = z.object({
  title: z.string().trim().min(2).max(180),
  question_text: z.string().trim().min(3).max(5000),
  answer_type: z.enum(['free_text', 'choice']).default('choice'),
  next_question_public_id: z.string().uuid().nullable().optional().default(null),
  is_active: z.boolean().optional().default(true),
  options: z.array(campaignQuestionOptionSchema).max(26).optional().default([]),
}).superRefine((value, context) => {
  if (value.answer_type === 'choice' && value.options.length < 2) {
    context.addIssue({ code: 'custom', path: ['options'], message: 'Pertanyaan pilihan membutuhkan minimal 2 pilihan jawaban' });
  }
  const normalized = value.options.map((option) => normalizeAnswer(option.answer_text));
  if (new Set(normalized).size !== normalized.length) {
    context.addIssue({ code: 'custom', path: ['options'], message: 'Pilihan jawaban tidak boleh duplikat' });
  }
  if (value.answer_type === 'choice' && value.next_question_public_id) {
    context.addIssue({ code: 'custom', path: ['next_question_public_id'], message: 'Routing default hanya berlaku untuk pertanyaan teks bebas' });
  }
  value.options.forEach((option, index) => {
    if (option.action_type === 'goto' && !option.next_question_public_id) {
      context.addIssue({ code: 'custom', path: ['options', index, 'next_question_public_id'], message: 'Target pertanyaan wajib dipilih' });
    }
  });
  const variables = [...value.question_text.matchAll(/{{\s*([a-z_]+)\s*}}/gi)]
    .map((match) => match[1].toLocaleLowerCase('id-ID'));
  const unsupported = [...new Set(variables.filter((variable) => !QUESTION_VARIABLES.includes(variable)))];
  if (unsupported.length) {
    context.addIssue({ code: 'custom', path: ['question_text'], message: `Variable tidak didukung: ${unsupported.join(', ')}` });
  }
});
const monitoringFilterSchema = z.object({
  search: z.string().trim().max(180).optional().default(''),
  progress_status: z.enum([
    'not_started', 'in_progress', 'review_pending_details', 'completed', 'stopped', 'needs_review',
  ]).optional(),
  session_number: z.coerce.number().int().min(1).max(1000).optional(),
});
const reviewCorrectionSchema = z.object({
  name: z.string().trim().min(2).max(150),
  phone: z.union([z.string(), z.number()]),
  email: z.string().trim().max(254),
  entry_year: z.union([z.string(), z.number()]),
  study_program_group_id: z.coerce.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (!isValidEmail(value.email)) {
    context.addIssue({ code: 'custom', path: ['email'], message: 'Format email tidak valid' });
  }
  if (!parseEntryYear(value.entry_year)) {
    context.addIssue({ code: 'custom', path: ['entry_year'], message: 'Tahun masuk tidak valid' });
  }
});
const CAMPAIGN_TRANSITIONS = Object.freeze({
  draft: ['active', 'archived'],
  active: ['paused', 'completed', 'archived'],
  paused: ['active', 'completed', 'archived'],
  completed: ['archived'],
  archived: ['restore'],
});

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function actorFromRequest(req) {
  if (!req.session?.user) throw httpError(403, 'Endpoint Campaign hanya tersedia untuk session dashboard', 'CAMPAIGN_SESSION_REQUIRED');
  return {
    id: Number(req.session.user.id),
    roles: req.session.roles || [],
    permissions: req.session.permissions || [],
  };
}

function hasGlobalAccess(actor) {
  return actor.roles.includes('super_admin') || actor.permissions.includes('campaigns.manage');
}

function canAccessCampaign(campaign, actor) {
  return Boolean(campaign) && (hasGlobalAccess(actor) || Number(campaign.operator_user_id) === Number(actor.id));
}

function canTransitionCampaign(from, to) {
  return Boolean(CAMPAIGN_TRANSITIONS[from]?.includes(to));
}

function applyScope(query, actor, alias = 'campaigns') {
  if (!hasGlobalAccess(actor)) query.where(`${alias}.operator_user_id`, actor.id);
  return query;
}

function assertScopedCampaign(campaign, actor) {
  if (!canAccessCampaign(campaign, actor)) {
    throw httpError(404, 'Campaign tidak ditemukan', 'CAMPAIGN_NOT_FOUND');
  }
  return campaign;
}

async function findScopedCampaign(publicId, actor, database = knex, lock = false) {
  let query = database('campaigns').where({ public_id: publicId });
  query = applyScope(query, actor);
  if (lock) query.forUpdate();
  return assertScopedCampaign(await query.first(), actor);
}

async function validateOperator(operatorUserId, database = knex) {
  const operator = await database('users as users')
    .join('user_roles', 'user_roles.user_id', 'users.id')
    .join('roles', 'roles.id', 'user_roles.role_id')
    .where('users.id', operatorUserId)
    .where('users.status', 'active')
    .whereNull('users.deleted_at')
    .whereIn('roles.name', ['operator', 'super_admin'])
    .select('users.id', 'users.name', 'users.email')
    .first();
  if (!operator) throw httpError(422, 'Operator harus berupa user aktif dengan role operator atau super admin', 'INVALID_CAMPAIGN_OPERATOR');
  return operator;
}

async function validateAcademicScope(value, database = knex) {
  const groups = await database('contact_groups')
    .whereIn('type', ['university', 'faculty', 'study_program'])
    .select('id', 'parent_id', 'type', 'code', 'name', 'status', 'path_key');
  const result = resolveSelectedGrouping({
    universityId: value.university_group_id,
    facultyId: value.faculty_group_id,
    studyProgramId: value.study_program_group_id,
  }, groups);
  if (!result.valid) {
    const messages = {
      UNIVERSITY_REQUIRED: 'Universitas wajib dipilih',
      UNIVERSITY_NOT_FOUND_OR_INACTIVE: 'Universitas tidak ditemukan atau nonaktif',
      FACULTY_NOT_FOUND_OR_INACTIVE: 'Fakultas tidak ditemukan atau nonaktif',
      FACULTY_UNIVERSITY_MISMATCH: 'Fakultas bukan bagian dari universitas terpilih',
      STUDY_PROGRAM_REQUIRES_FACULTY: 'Program studi hanya dapat dipilih setelah memilih fakultas',
      STUDY_PROGRAM_NOT_FOUND_OR_INACTIVE: 'Program studi tidak ditemukan atau nonaktif',
      STUDY_PROGRAM_FACULTY_MISMATCH: 'Program studi bukan bagian dari fakultas terpilih',
    };
    throw httpError(422, messages[result.errorCode] || 'Scope akademik tidak valid', result.errorCode);
  }
  return result;
}

function baseListQuery(database = knex) {
  return database('campaigns')
    .join('contact_groups as university', 'university.id', 'campaigns.university_group_id')
    .leftJoin('contact_groups as faculty', 'faculty.id', 'campaigns.faculty_group_id')
    .leftJoin('contact_groups as study_program', 'study_program.id', 'campaigns.study_program_group_id')
    .join('users as operator', 'operator.id', 'campaigns.operator_user_id')
    .select(
      'campaigns.*',
      'university.name as university_name', 'university.code as university_code',
      'faculty.name as faculty_name', 'faculty.code as faculty_code',
      'study_program.name as study_program_name', 'study_program.code as study_program_code',
      'operator.name as operator_name', 'operator.email as operator_email',
      database.raw('(SELECT COUNT(*) FROM campaign_contacts cc WHERE cc.campaign_id = campaigns.id AND cc.status = ?) AS contact_count', ['active']),
      database.raw('(SELECT COUNT(*) FROM broadcasts b WHERE b.campaign_id = campaigns.id) AS blast_count'),
      database.raw(`CASE WHEN
        NOT EXISTS (SELECT 1 FROM contact_imports ci WHERE ci.campaign_id = campaigns.id)
        AND NOT EXISTS (SELECT 1 FROM campaign_contacts cc_any WHERE cc_any.campaign_id = campaigns.id)
        AND NOT EXISTS (SELECT 1 FROM broadcasts b_any WHERE b_any.campaign_id = campaigns.id)
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.campaign_id = campaigns.id)
        AND NOT EXISTS (SELECT 1 FROM campaign_incoming_messages cim WHERE cim.campaign_id = campaigns.id)
        THEN 1 ELSE 0 END AS can_delete`),
    );
}

async function list(req, filters) {
  const actor = actorFromRequest(req);
  const value = z.object({
    search: z.string().trim().max(180).optional().default(''),
    status: z.enum(['draft', 'active', 'paused', 'completed', 'archived']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }).parse(filters);
  const applyFilters = (query) => {
    applyScope(query, actor);
    if (value.status) query.where('campaigns.status', value.status);
    else query.whereNot('campaigns.status', 'archived');
    if (value.search) {
      query.where((builder) => builder.where('campaigns.title', 'like', `%${value.search}%`)
        .orWhere('university.name', 'like', `%${value.search}%`)
        .orWhere('operator.name', 'like', `%${value.search}%`));
    }
    return query;
  };
  const countQuery = knex('campaigns')
    .join('contact_groups as university', 'university.id', 'campaigns.university_group_id')
    .join('users as operator', 'operator.id', 'campaigns.operator_user_id');
  const [{ count }] = await applyFilters(countQuery).countDistinct({ count: 'campaigns.id' });
  const data = await applyFilters(baseListQuery())
    .orderBy('campaigns.updated_at', 'desc')
    .limit(value.limit)
    .offset((value.page - 1) * value.limit);
  return {
    data: data.map((row) => ({
      ...row,
      contact_count: Number(row.contact_count),
      blast_count: Number(row.blast_count),
      can_delete: Boolean(Number(row.can_delete)),
    })),
    pagination: { page: value.page, limit: value.limit, total: Number(count), total_pages: Math.max(1, Math.ceil(Number(count) / value.limit)) },
  };
}

async function getDetail(req, publicId) {
  const actor = actorFromRequest(req);
  const campaign = await applyScope(baseListQuery().where('campaigns.public_id', publicId), actor).first();
  assertScopedCampaign(campaign, actor);
  const [recipientStats, replyCount, lastBlast] = await Promise.all([
    knex('campaign_contacts').where({ campaign_id: campaign.id }).select('status').count({ count: '*' }).groupBy('status'),
    currentCampaignReplyQuery(knex, campaign.id).count({ count: '*' }).first(),
    knex('broadcasts').where({ campaign_id: campaign.id }).orderBy('id', 'desc').first(),
  ]);
  return {
    ...campaign,
    contact_count: Number(campaign.contact_count),
    blast_count: Number(campaign.blast_count),
    can_delete: Boolean(Number(campaign.can_delete)),
    contact_statuses: Object.fromEntries(recipientStats.map((row) => [row.status, Number(row.count)])),
    reply_count: Number(replyCount?.count || 0),
    last_blast: lastBlast || null,
  };
}

async function create(req, input) {
  const actor = actorFromRequest(req);
  if (!hasGlobalAccess(actor)) throw httpError(403, 'Hanya pengelola Campaign yang dapat membuat campaign', 'FORBIDDEN');
  const value = campaignInputSchema.parse(input);
  await Promise.all([validateAcademicScope(value), validateOperator(value.operator_user_id)]);
  return knex.transaction(async (trx) => {
    const publicId = crypto.randomUUID();
    const [id] = await trx('campaigns').insert({
      public_id: publicId,
      title: value.title,
      description: value.description || null,
      university_group_id: value.university_group_id,
      faculty_group_id: value.faculty_group_id || null,
      study_program_group_id: value.study_program_group_id || null,
      operator_user_id: value.operator_user_id,
      status: 'draft',
      created_by: actor.id,
      updated_by: actor.id,
    });
    await createTracerStudyQuestionnaire(trx, id, { name: 'Tracer Study Alumni 2026' });
    return trx('campaigns').where({ id }).first();
  });
}

function assertQuestionsMutable(campaign) {
  if (['completed', 'archived'].includes(campaign.status)) {
    throw httpError(409, 'Master Questions tidak dapat diubah pada Campaign selesai atau diarsipkan', 'CAMPAIGN_QUESTIONS_LOCKED');
  }
}

async function listQuestions(req, publicId) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  const questionnaire = await getCurrentQuestionnaire(knex, campaign.id);
  if (!questionnaire) return [];
  const rows = await knex('campaign_questions')
    .where({ campaign_id: campaign.id, questionnaire_id: questionnaire.id })
    .orderBy('position');
  const questions = await hydrateQuestions(knex, rows);
  return questions.map((question) => ({
    ...question,
    questionnaire_public_id: questionnaire.public_id,
    questionnaire_version: questionnaire.version,
    questionnaire_name: questionnaire.name,
  }));
}

function isDatabaseBoolean(value) {
  return value === true || Number(value) === 1;
}

function assertQuestionnaireCopyable(questions) {
  if (!questions.length || !questions.some((question) => isDatabaseBoolean(question.is_active))) {
    throw httpError(409, 'Campaign sumber belum memiliki pertanyaan aktif yang siap dimuat', 'SOURCE_QUESTIONNAIRE_EMPTY');
  }
  const questionsById = new Map(questions.map((question) => [Number(question.id), question]));
  for (const question of questions) {
    const activeOptions = (question.options || []).filter((option) => isDatabaseBoolean(option.is_active));
    if (isDatabaseBoolean(question.is_active) && question.answer_type === 'choice' && activeOptions.length < 2) {
      throw httpError(409, `Pertanyaan sumber "${question.title}" belum memiliki minimal dua pilihan aktif`, 'SOURCE_QUESTIONNAIRE_OPTIONS_INVALID');
    }
    if (question.next_question_id) {
      const target = questionsById.get(Number(question.next_question_id));
      if (!target || !isDatabaseBoolean(target.is_active) || Number(target.position) <= Number(question.position)) {
        throw httpError(409, 'Questionnaire sumber memiliki routing teks tidak aktif, tidak valid, atau mundur', 'SOURCE_QUESTIONNAIRE_BRANCH_INVALID');
      }
    }
    for (const option of question.options || []) {
      if (option.next_question_id && !questionsById.has(Number(option.next_question_id))) {
        throw httpError(409, 'Questionnaire sumber memiliki referensi cabang lintas versi atau tidak ditemukan', 'SOURCE_QUESTIONNAIRE_BRANCH_INVALID');
      }
      if (option.action_type !== 'goto' || !isDatabaseBoolean(question.is_active) || !isDatabaseBoolean(option.is_active)) continue;
      const target = questionsById.get(Number(option.next_question_id));
      if (!target || !isDatabaseBoolean(target.is_active) || Number(target.position) <= Number(question.position)) {
        throw httpError(409, 'Questionnaire sumber memiliki cabang tidak aktif, tidak valid, atau mundur', 'SOURCE_QUESTIONNAIRE_BRANCH_INVALID');
      }
    }
  }
}

async function listQuestionSources(req, publicId, filters = {}) {
  const actor = actorFromRequest(req);
  const value = campaignQuestionSourceSchema.parse(filters);
  const target = await findScopedCampaign(publicId, actor);
  const query = knex('campaigns as source')
    .join('campaign_questionnaires as questionnaire', function joinCurrentQuestionnaire() {
      this.on('questionnaire.campaign_id', '=', 'source.id')
        .andOn('questionnaire.is_current', '=', knex.raw('?', [true]));
    })
    .whereNot('source.id', target.id)
    .select(
      'source.public_id', 'source.title', 'source.status',
      'questionnaire.public_id as questionnaire_public_id',
      'questionnaire.name as questionnaire_name',
      'questionnaire.version as questionnaire_version',
      knex.raw('(SELECT COUNT(*) FROM campaign_questions question WHERE question.questionnaire_id = questionnaire.id) AS question_count'),
      knex.raw('(SELECT COUNT(*) FROM campaign_questions question WHERE question.questionnaire_id = questionnaire.id AND question.is_active = 1) AS active_question_count'),
    );
  applyScope(query, actor, 'source');
  if (value.search) query.where('source.title', 'like', `%${value.search}%`);
  const rows = await query.orderBy('source.updated_at', 'desc').limit(value.limit);
  return rows.map((row) => ({
    ...row,
    questionnaire_version: Number(row.questionnaire_version),
    question_count: Number(row.question_count),
    active_question_count: Number(row.active_question_count),
  }));
}

async function importQuestionsFromCampaign(req, publicId, input) {
  const actor = actorFromRequest(req);
  const value = campaignQuestionImportSchema.parse(input);
  if (value.source_campaign_public_id === publicId) {
    throw httpError(422, 'Campaign sumber harus berbeda dari Campaign tujuan', 'QUESTION_SOURCE_SAME_CAMPAIGN');
  }
  return knex.transaction(async (trx) => {
    const campaignRows = await trx('campaigns')
      .whereIn('public_id', [publicId, value.source_campaign_public_id]);
    const initialTarget = assertScopedCampaign(campaignRows.find((item) => item.public_id === publicId), actor);
    const initialSource = assertScopedCampaign(campaignRows.find((item) => item.public_id === value.source_campaign_public_id), actor);
    const lockedCampaigns = [];
    for (const id of [initialTarget.id, initialSource.id].sort((left, right) => Number(left) - Number(right))) {
      lockedCampaigns.push(await trx('campaigns').where({ id }).forUpdate().first());
    }
    const target = assertScopedCampaign(lockedCampaigns.find((item) => item.public_id === publicId), actor);
    const source = assertScopedCampaign(lockedCampaigns.find((item) => item.public_id === value.source_campaign_public_id), actor);
    assertQuestionsMutable(target);

    const sourceQuestionnaire = await trx('campaign_questionnaires')
      .where({ campaign_id: source.id, is_current: true }).orderBy('version', 'desc').forUpdate().first();
    if (!sourceQuestionnaire) {
      throw httpError(409, 'Campaign sumber belum memiliki questionnaire aktif', 'SOURCE_QUESTIONNAIRE_REQUIRED');
    }
    const sourceRows = await trx('campaign_questions')
      .where({ campaign_id: source.id, questionnaire_id: sourceQuestionnaire.id }).orderBy('position');
    const sourceQuestions = await hydrateQuestions(trx, sourceRows);
    assertQuestionnaireCopyable(sourceQuestions);

    const [{ version: latestVersion }] = await trx('campaign_questionnaires')
      .where({ campaign_id: target.id }).max({ version: 'version' });
    const nextVersion = Number(latestVersion || 0) + 1;
    await trx('campaign_questionnaires').where({ campaign_id: target.id, is_current: true })
      .update({ is_current: false, updated_at: trx.fn.now(3) });
    const questionnaireName = `Salinan ${source.title} — ${sourceQuestionnaire.name}`.slice(0, 180);
    const questionnairePublicId = crypto.randomUUID();
    const [questionnaireId] = await trx('campaign_questionnaires').insert({
      public_id: questionnairePublicId,
      campaign_id: target.id,
      version: nextVersion,
      name: questionnaireName,
      is_current: true,
    });

    const copiedQuestionIds = new Map();
    for (const question of sourceQuestions) {
      const [questionId] = await trx('campaign_questions').insert({
        public_id: crypto.randomUUID(),
        campaign_id: target.id,
        questionnaire_id: questionnaireId,
        position: question.position,
        title: question.title,
        question_text: question.question_text,
        answer_type: question.answer_type,
        is_active: isDatabaseBoolean(question.is_active),
      });
      copiedQuestionIds.set(Number(question.id), questionId);
    }

    for (const question of sourceQuestions) {
      if (!question.next_question_id) continue;
      await trx('campaign_questions').where({ id: copiedQuestionIds.get(Number(question.id)) }).update({
        next_question_id: copiedQuestionIds.get(Number(question.next_question_id)),
      });
    }

    const copiedOptions = sourceQuestions.flatMap((question) => (question.options || []).map((option) => ({
      public_id: crypto.randomUUID(),
      campaign_question_id: copiedQuestionIds.get(Number(question.id)),
      position: option.position,
      answer_text: option.answer_text,
      action_type: option.action_type,
      next_question_id: option.next_question_id ? copiedQuestionIds.get(Number(option.next_question_id)) : null,
      is_active: isDatabaseBoolean(option.is_active),
    })));
    if (copiedOptions.length) await trx('campaign_question_options').insert(copiedOptions);

    return {
      questionnaire_public_id: questionnairePublicId,
      questionnaire_name: questionnaireName,
      questionnaire_version: nextVersion,
      source_campaign_public_id: source.public_id,
      source_campaign_title: source.title,
      source_questionnaire_version: Number(sourceQuestionnaire.version),
      question_count: sourceQuestions.length,
      option_count: copiedOptions.length,
    };
  });
}

async function resolveQuestionOptionRows(trx, campaign, questionnaire, question, options) {
  const targetPublicIds = options
    .filter((option) => option.action_type === 'goto')
    .map((option) => option.next_question_public_id)
    .filter(Boolean);
  const targets = targetPublicIds.length
    ? await trx('campaign_questions').where({ campaign_id: campaign.id, questionnaire_id: questionnaire.id })
      .whereIn('public_id', targetPublicIds).select('id', 'public_id', 'position')
    : [];
  const targetMap = new Map(targets.map((target) => [target.public_id, target]));
  return options.map((option, index) => {
    const target = option.action_type === 'goto' ? targetMap.get(option.next_question_public_id) : null;
    if (option.action_type === 'goto' && !target) {
      throw httpError(422, `Target pertanyaan untuk pilihan ${index + 1} tidak valid`, 'INVALID_QUESTION_BRANCH_TARGET');
    }
    if (target && Number(target.position) <= Number(question.position)) {
      throw httpError(422, 'Percabangan hanya boleh menuju pertanyaan setelah posisi saat ini untuk mencegah loop', 'QUESTION_BRANCH_LOOP_NOT_ALLOWED');
    }
    return {
      public_id: crypto.randomUUID(),
      campaign_question_id: question.id,
      position: index + 1,
      answer_text: option.answer_text,
      action_type: option.action_type,
      next_question_id: target?.id || null,
      is_active: true,
    };
  });
}

async function resolveQuestionNextId(trx, campaign, questionnaire, question, targetPublicId) {
  if (!targetPublicId) return null;
  const target = await trx('campaign_questions')
    .where({
      campaign_id: campaign.id,
      questionnaire_id: questionnaire.id,
      public_id: targetPublicId,
      is_active: true,
    })
    .first('id', 'position');
  if (!target) {
    throw httpError(422, 'Target lanjutan pertanyaan teks tidak valid atau tidak aktif', 'INVALID_QUESTION_BRANCH_TARGET');
  }
  if (Number(target.position) <= Number(question.position)) {
    throw httpError(422, 'Routing pertanyaan teks hanya boleh menuju pertanyaan setelah posisi saat ini', 'QUESTION_BRANCH_LOOP_NOT_ALLOWED');
  }
  return target.id;
}

async function createQuestion(req, publicId, input) {
  const actor = actorFromRequest(req);
  const value = campaignQuestionSchema.parse(input);
  return knex.transaction(async (trx) => {
    const campaign = await findScopedCampaign(publicId, actor, trx, true);
    assertQuestionsMutable(campaign);
    const questionnaire = await getCurrentQuestionnaire(trx, campaign.id);
    if (!questionnaire) throw httpError(409, 'Questionnaire aktif belum tersedia', 'CAMPAIGN_QUESTIONNAIRE_REQUIRED');
    const last = await trx('campaign_questions')
      .where({ campaign_id: campaign.id, questionnaire_id: questionnaire.id }).max({ position: 'position' }).first();
    const [id] = await trx('campaign_questions').insert({
      public_id: crypto.randomUUID(),
      campaign_id: campaign.id,
      questionnaire_id: questionnaire.id,
      position: Number(last?.position || 0) + 1,
      title: value.title,
      question_text: value.question_text,
      answer_type: value.answer_type,
      next_question_id: null,
      is_active: value.is_active,
    });
    const question = await trx('campaign_questions').where({ id }).first();
    const nextQuestionId = value.answer_type === 'free_text'
      ? await resolveQuestionNextId(trx, campaign, questionnaire, question, value.next_question_public_id)
      : null;
    if (nextQuestionId) await trx('campaign_questions').where({ id }).update({ next_question_id: nextQuestionId });
    if (value.answer_type === 'choice') {
      await trx('campaign_question_options').insert(
        await resolveQuestionOptionRows(trx, campaign, questionnaire, question, value.options),
      );
    }
    return (await hydrateQuestions(trx, [await trx('campaign_questions').where({ id }).first()]))[0];
  });
}

async function updateQuestion(req, publicId, questionPublicId, input) {
  const actor = actorFromRequest(req);
  const value = campaignQuestionSchema.parse(input);
  return knex.transaction(async (trx) => {
    const campaign = await findScopedCampaign(publicId, actor, trx, true);
    assertQuestionsMutable(campaign);
    const questionnaire = await getCurrentQuestionnaire(trx, campaign.id);
    if (!questionnaire) throw httpError(409, 'Questionnaire aktif belum tersedia', 'CAMPAIGN_QUESTIONNAIRE_REQUIRED');
    const question = await trx('campaign_questions')
      .where({ campaign_id: campaign.id, questionnaire_id: questionnaire.id, public_id: questionPublicId })
      .forUpdate().first();
    if (!question) throw httpError(404, 'Pertanyaan Campaign tidak ditemukan', 'CAMPAIGN_QUESTION_NOT_FOUND');

    const [selected, existingOptions, waiting] = await Promise.all([
      trx('campaign_incoming_messages')
        .where({ campaign_question_id: question.id }).whereNotNull('campaign_question_option_id').first('id'),
      trx('campaign_question_options').where({ campaign_question_id: question.id }).orderBy('position'),
      trx('campaign_contact_progress').where({ current_question_id: question.id, status: 'in_progress' }).first('id'),
    ]);
    const resolvedOptionRows = value.answer_type === 'choice'
      ? await resolveQuestionOptionRows(trx, campaign, questionnaire, question, value.options)
      : [];
    const resolvedNextQuestionId = value.answer_type === 'free_text'
      ? await resolveQuestionNextId(trx, campaign, questionnaire, question, value.next_question_public_id)
      : null;
    const resolvedOptionsChanged = question.answer_type !== value.answer_type
      || existingOptions.length !== resolvedOptionRows.length
      || existingOptions.some((option, index) => (
        normalizeAnswer(option.answer_text) !== normalizeAnswer(resolvedOptionRows[index].answer_text)
        || option.action_type !== resolvedOptionRows[index].action_type
        || Number(option.next_question_id || 0) !== Number(resolvedOptionRows[index].next_question_id || 0)
      ));
    const nextQuestionChanged = Number(question.next_question_id || 0) !== Number(resolvedNextQuestionId || 0);
    const pendingContentChanged = question.title !== value.title
      || question.question_text !== value.question_text
      || Boolean(question.is_active) !== value.is_active
      || resolvedOptionsChanged
      || nextQuestionChanged;
    if (!value.is_active) {
      const branchReference = await trx('campaign_question_options as option_item')
        .join('campaign_questions as source_question', 'source_question.id', 'option_item.campaign_question_id')
        .where({
          'option_item.next_question_id': question.id,
          'option_item.action_type': 'goto',
          'option_item.is_active': true,
          'source_question.is_active': true,
        })
        .first('option_item.id');
      if (branchReference) {
        throw httpError(409, 'Pertanyaan masih menjadi tujuan cabang aktif. Ubah alur pilihan yang mengarah ke pertanyaan ini terlebih dahulu', 'CAMPAIGN_QUESTION_BRANCH_TARGET');
      }
      const textBranchReference = await trx('campaign_questions')
        .where({ next_question_id: question.id, is_active: true }).first('id');
      if (textBranchReference) {
        throw httpError(409, 'Pertanyaan masih menjadi tujuan routing teks aktif. Ubah alurnya terlebih dahulu', 'CAMPAIGN_QUESTION_BRANCH_TARGET');
      }
    }
    if (waiting && pendingContentChanged) {
      throw httpError(409, 'Pertanyaan sedang ditunggu alumni. Selesaikan progres tersebut sebelum mengubah isi atau pilihan', 'CAMPAIGN_QUESTION_IN_USE');
    }
    if (selected && resolvedOptionsChanged) {
      throw httpError(409, 'Pilihan jawaban sudah digunakan dan dikunci untuk menjaga integritas histori', 'CAMPAIGN_QUESTION_OPTIONS_LOCKED');
    }

    await trx('campaign_questions').where({ id: question.id }).update({
      title: value.title,
      question_text: value.question_text,
      answer_type: value.answer_type,
      next_question_id: resolvedNextQuestionId,
      is_active: value.is_active,
      updated_at: trx.fn.now(3),
    });
    if (!selected && resolvedOptionsChanged) {
      await trx('campaign_question_options').where({ campaign_question_id: question.id }).delete();
      if (value.answer_type === 'choice') {
        await trx('campaign_question_options').insert(resolvedOptionRows);
      }
    }
    return (await hydrateQuestions(trx, [await trx('campaign_questions').where({ id: question.id }).first()]))[0];
  });
}

async function removeQuestion(req, publicId, questionPublicId) {
  const actor = actorFromRequest(req);
  return knex.transaction(async (trx) => {
    const campaign = await findScopedCampaign(publicId, actor, trx, true);
    assertQuestionsMutable(campaign);
    const questionnaire = await getCurrentQuestionnaire(trx, campaign.id);
    if (!questionnaire) throw httpError(409, 'Questionnaire aktif belum tersedia', 'CAMPAIGN_QUESTIONNAIRE_REQUIRED');
    const question = await trx('campaign_questions')
      .where({ campaign_id: campaign.id, questionnaire_id: questionnaire.id, public_id: questionPublicId })
      .forUpdate().first();
    if (!question) throw httpError(404, 'Pertanyaan Campaign tidak ditemukan', 'CAMPAIGN_QUESTION_NOT_FOUND');
    const [progress, answer, branchReference, textBranchReference] = await Promise.all([
      trx('campaign_contact_progress').where({ current_question_id: question.id }).first('id'),
      trx('campaign_incoming_messages').where({ campaign_question_id: question.id }).first('id'),
      trx('campaign_question_options as option_item')
        .join('campaign_questions as source_question', 'source_question.id', 'option_item.campaign_question_id')
        .where({
          'option_item.next_question_id': question.id,
          'option_item.action_type': 'goto',
          'option_item.is_active': true,
          'source_question.is_active': true,
        })
        .first('option_item.id'),
      trx('campaign_questions').where({ next_question_id: question.id, is_active: true }).first('id'),
    ]);
    if (progress || answer) {
      throw httpError(409, 'Pertanyaan sudah digunakan. Nonaktifkan jika tidak ingin mengirimkannya lagi', 'CAMPAIGN_QUESTION_IN_USE');
    }
    if (branchReference || textBranchReference) {
      throw httpError(409, 'Pertanyaan masih menjadi tujuan cabang aktif. Ubah alur pilihan yang mengarah ke pertanyaan ini terlebih dahulu', 'CAMPAIGN_QUESTION_BRANCH_TARGET');
    }
    await trx('campaign_questions').where({ id: question.id }).delete();
    return { public_id: question.public_id, deleted: true };
  });
}

async function activityCount(campaignId, database = knex) {
  const [imports, contacts, broadcasts, messages, replies] = await Promise.all([
    database('contact_imports').where({ campaign_id: campaignId }).count({ count: '*' }).first(),
    database('campaign_contacts').where({ campaign_id: campaignId }).count({ count: '*' }).first(),
    database('broadcasts').where({ campaign_id: campaignId }).count({ count: '*' }).first(),
    database('messages').where({ campaign_id: campaignId }).count({ count: '*' }).first(),
    database('campaign_incoming_messages').where({ campaign_id: campaignId }).count({ count: '*' }).first(),
  ]);
  return [imports, contacts, broadcasts, messages, replies].reduce((sum, row) => sum + Number(row?.count || 0), 0);
}

async function update(req, publicId, input) {
  const actor = actorFromRequest(req);
  if (!hasGlobalAccess(actor)) throw httpError(403, 'Hanya pengelola Campaign yang dapat mengubah metadata', 'FORBIDDEN');
  const value = updateCampaignSchema.parse(input);
  return knex.transaction(async (trx) => {
    const campaign = await findScopedCampaign(publicId, actor, trx, true);
    if (campaign.status === 'archived') throw httpError(409, 'Campaign archived bersifat read-only', 'CAMPAIGN_READ_ONLY');
    const academicKeys = ['university_group_id', 'faculty_group_id', 'study_program_group_id'];
    if (academicKeys.some((key) => Object.prototype.hasOwnProperty.call(value, key)) && await activityCount(campaign.id, trx)) {
      throw httpError(409, 'Scope akademik tidak dapat diubah setelah campaign memiliki aktivitas', 'CAMPAIGN_SCOPE_LOCKED');
    }
    const merged = { ...campaign, ...value };
    if (academicKeys.some((key) => Object.prototype.hasOwnProperty.call(value, key))) await validateAcademicScope(merged, trx);
    if (value.operator_user_id) await validateOperator(value.operator_user_id, trx);
    const updates = {
      ...value,
      faculty_group_id: value.faculty_group_id === '' ? null : value.faculty_group_id,
      study_program_group_id: value.study_program_group_id === '' ? null : value.study_program_group_id,
      description: value.description || null,
      updated_by: actor.id,
      updated_at: trx.fn.now(3),
    };
    await trx('campaigns').where({ id: campaign.id }).update(updates);
    return trx('campaigns').where({ id: campaign.id }).first();
  });
}

async function setStatus(req, publicId, requestedStatus) {
  const actor = actorFromRequest(req);
  if (!hasGlobalAccess(actor)) throw httpError(403, 'Hanya pengelola Campaign yang dapat mengubah lifecycle', 'FORBIDDEN');
  const status = z.enum(['active', 'paused', 'completed', 'archived', 'restore']).parse(requestedStatus);
  return knex.transaction(async (trx) => {
    const campaign = await findScopedCampaign(publicId, actor, trx, true);
    let target = status;
    if (!canTransitionCampaign(campaign.status, status)) throw httpError(409, `Transisi ${campaign.status} ke ${status} tidak diizinkan`, 'INVALID_CAMPAIGN_TRANSITION');
    if (status === 'restore') target = campaign.archived_from_status || 'draft';
    if (target === 'active') {
      await Promise.all([validateAcademicScope(campaign, trx), validateOperator(campaign.operator_user_id, trx)]);
      const [activeQuestions, invalidChoice, invalidBranch, invalidTextBranch] = await Promise.all([
        trx('campaign_questions as question')
          .join('campaign_questionnaires as questionnaire', 'questionnaire.id', 'question.questionnaire_id')
          .where({ 'question.campaign_id': campaign.id, 'question.is_active': true, 'questionnaire.is_current': true })
          .count({ count: '*' }).first(),
        trx('campaign_questions as question')
          .join('campaign_questionnaires as questionnaire', 'questionnaire.id', 'question.questionnaire_id')
          .where({ 'question.campaign_id': campaign.id, 'question.is_active': true, 'question.answer_type': 'choice' })
          .where('questionnaire.is_current', true)
          .whereRaw('(SELECT COUNT(*) FROM campaign_question_options option_item WHERE option_item.campaign_question_id = question.id AND option_item.is_active = 1) < 2')
          .first('question.id'),
        trx('campaign_question_options as option_item')
          .join('campaign_questions as source_question', 'source_question.id', 'option_item.campaign_question_id')
          .join('campaign_questionnaires as questionnaire', 'questionnaire.id', 'source_question.questionnaire_id')
          .leftJoin('campaign_questions as target_question', 'target_question.id', 'option_item.next_question_id')
          .where({
            'source_question.campaign_id': campaign.id,
            'source_question.is_active': true,
            'questionnaire.is_current': true,
            'option_item.is_active': true,
            'option_item.action_type': 'goto',
          })
          .where((builder) => builder.whereNull('target_question.id')
            .orWhere('target_question.is_active', false)
            .orWhereRaw('target_question.questionnaire_id <> source_question.questionnaire_id')
            .orWhereRaw('target_question.position <= source_question.position'))
          .first('option_item.id'),
        trx('campaign_questions as source_question')
          .join('campaign_questionnaires as questionnaire', 'questionnaire.id', 'source_question.questionnaire_id')
          .leftJoin('campaign_questions as target_question', 'target_question.id', 'source_question.next_question_id')
          .where({
            'source_question.campaign_id': campaign.id,
            'source_question.is_active': true,
            'questionnaire.is_current': true,
          })
          .whereNotNull('source_question.next_question_id')
          .where((builder) => builder.whereNull('target_question.id')
            .orWhere('target_question.is_active', false)
            .orWhereRaw('target_question.questionnaire_id <> source_question.questionnaire_id')
            .orWhereRaw('target_question.position <= source_question.position'))
          .first('source_question.id'),
      ]);
      if (!Number(activeQuestions?.count)) {
        throw httpError(409, 'Aktivasi membutuhkan minimal satu pertanyaan aktif', 'CAMPAIGN_QUESTIONS_REQUIRED');
      }
      if (invalidChoice) {
        throw httpError(409, 'Setiap pertanyaan pilihan aktif membutuhkan minimal dua pilihan jawaban', 'CAMPAIGN_QUESTION_OPTIONS_REQUIRED');
      }
      if (invalidBranch || invalidTextBranch) {
        throw httpError(409, 'Alur pertanyaan memiliki tujuan cabang yang tidak aktif, tidak valid, atau mundur', 'CAMPAIGN_QUESTION_BRANCH_INVALID');
      }
    }
    const updates = {
      status: target,
      updated_by: actor.id,
      updated_at: trx.fn.now(3),
      archived_at: status === 'archived' ? trx.fn.now(3) : null,
      archived_from_status: status === 'archived' ? campaign.status : null,
    };
    await trx('campaigns').where({ id: campaign.id }).update(updates);
    if (['paused', 'completed', 'archived'].includes(target)) {
      await trx('broadcasts').where({ campaign_id: campaign.id }).whereIn('status', ['scheduled', 'running'])
        .update({ status: 'paused', updated_at: trx.fn.now(3) });
    }
    return trx('campaigns').where({ id: campaign.id }).first();
  });
}

function canHardDeleteCampaign(activityTotal) {
  return Number(activityTotal) === 0;
}

function validateCampaignDeleteConfirmation(input) {
  return campaignDeleteSchema.parse(input);
}

async function remove(req, publicId, input) {
  const actor = actorFromRequest(req);
  if (!hasGlobalAccess(actor)) throw httpError(403, 'Hanya pengelola Campaign yang dapat menghapus campaign', 'FORBIDDEN');
  validateCampaignDeleteConfirmation(input);
  return knex.transaction(async (trx) => {
    const campaign = await findScopedCampaign(publicId, actor, trx, true);
    const totalActivity = await activityCount(campaign.id, trx);
    if (!canHardDeleteCampaign(totalActivity)) {
      throw httpError(409, 'Campaign yang sudah memiliki aktivitas tidak dapat dihapus permanen; arsipkan campaign agar histori tetap tersimpan', 'CAMPAIGN_HAS_ACTIVITY');
    }
    await trx('campaigns').where({ id: campaign.id }).del();
    return campaign;
  });
}

async function metadata(req) {
  const actor = actorFromRequest(req);
  const [groups, operators] = await Promise.all([
    knex('contact_groups').whereIn('type', ['university', 'faculty', 'study_program'])
      .select('id', 'parent_id', 'type', 'code', 'name', 'status').orderBy('name'),
    hasGlobalAccess(actor) ? knex('users as users').join('user_roles', 'user_roles.user_id', 'users.id')
      .join('roles', 'roles.id', 'user_roles.role_id')
      .where('users.status', 'active').whereNull('users.deleted_at')
      .whereIn('roles.name', ['operator', 'super_admin'])
      .distinct('users.id', 'users.name', 'users.email').orderBy('users.name') : Promise.resolve([]),
  ]);
  return { groups, operators };
}

async function listContacts(req, publicId, filters) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  const value = z.object({
    search: z.string().trim().max(150).optional().default(''),
    status: z.enum(['active', 'excluded', 'completed']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }).parse(filters);
  const base = () => {
    const query = knex('campaign_contacts as cc').join('contacts', 'contacts.id', 'cc.contact_id')
      .leftJoin('contact_academic_profiles as profile', function joinAcademicProfile() {
        this.on('profile.contact_id', '=', 'contacts.id')
          .andOn('profile.university_group_id', '=', knex.raw('?', [campaign.university_group_id]));
      })
      .leftJoin('contact_groups as profile_faculty', 'profile_faculty.id', 'profile.faculty_group_id')
      .leftJoin('contact_groups as profile_program', 'profile_program.id', 'profile.study_program_group_id')
      .where('cc.campaign_id', campaign.id).whereNull('contacts.deleted_at');
    if (value.status) query.where('cc.status', value.status);
    if (value.search) query.where((builder) => builder.where('contacts.name', 'like', `%${value.search}%`)
      .orWhere('contacts.phone_e164', 'like', `%${value.search}%`)
      .orWhere('profile.student_number', 'like', `%${value.search}%`)
      .orWhere('profile.email', 'like', `%${value.search}%`));
    return query;
  };
  const [{ count }] = await base().count({ count: '*' });
  let rows = await base().select(
    'cc.id as membership_id', 'cc.status as membership_status', 'cc.exclusion_reason', 'cc.added_at',
    'contacts.id', 'contacts.name', 'contacts.phone_e164', 'contacts.status', 'contacts.consent_status', 'contacts.wa_registration_status',
    'profile.student_number', 'profile.entry_year', 'profile.email', 'profile.graduation_period',
    'profile_faculty.name as faculty_name', 'profile_program.name as study_program_name',
  ).orderBy('cc.id', 'desc').limit(value.limit).offset((value.page - 1) * value.limit);
  if (shouldMaskPersonalData(req)) {
    rows = rows.map((row) => ({ ...row, email: maskEmail(row.email), phone_e164: maskPhone(row.phone_e164) }));
  }
  return { data: rows, pagination: { page: value.page, limit: value.limit, total: Number(count), total_pages: Math.max(1, Math.ceil(Number(count) / value.limit)) } };
}

async function excludeContact(req, publicId, contactId) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  if (campaign.status === 'archived') throw httpError(409, 'Campaign archived bersifat read-only', 'CAMPAIGN_READ_ONLY');
  const affected = await knex('campaign_contacts').where({ campaign_id: campaign.id, contact_id: contactId }).update({
    status: 'excluded', exclusion_reason: 'REMOVED_BY_OPERATOR', excluded_at: knex.fn.now(3), updated_at: knex.fn.now(3),
  });
  if (!affected) throw httpError(404, 'Kontak campaign tidak ditemukan', 'CAMPAIGN_CONTACT_NOT_FOUND');
  return { contact_id: Number(contactId), status: 'excluded' };
}

async function reactivateContact(req, publicId, contactId) {
  const actor = actorFromRequest(req);
  const parsedContactId = z.coerce.number().int().positive().parse(contactId);
  return knex.transaction(async (trx) => {
    const campaign = await findScopedCampaign(publicId, actor, trx, true);
    if (['completed', 'archived'].includes(campaign.status)) {
      throw httpError(409, 'Kontak tidak dapat ditambahkan lagi pada Campaign selesai atau diarsipkan', 'CAMPAIGN_READ_ONLY');
    }
    const membership = await trx('campaign_contacts as membership')
      .join('contacts as contact', 'contact.id', 'membership.contact_id')
      .where({ 'membership.campaign_id': campaign.id, 'membership.contact_id': parsedContactId })
      .whereNull('contact.deleted_at')
      .select(
        'membership.id', 'membership.status as membership_status',
        'contact.status as contact_status', 'contact.consent_status',
      )
      .forUpdate().first();
    if (!membership) throw httpError(404, 'Kontak Campaign tidak ditemukan', 'CAMPAIGN_CONTACT_NOT_FOUND');
    if (membership.membership_status !== 'excluded') {
      throw httpError(409, 'Hanya membership excluded yang dapat ditambahkan kembali', 'CAMPAIGN_CONTACT_NOT_EXCLUDED');
    }
    if (membership.contact_status !== 'active' || membership.consent_status !== 'granted') {
      throw httpError(409, 'Kontak harus aktif dan memiliki consent granted sebelum ditambahkan kembali', 'CAMPAIGN_CONTACT_NOT_ELIGIBLE');
    }
    await trx('campaign_contacts').where({ id: membership.id }).update({
      status: 'active',
      exclusion_reason: null,
      excluded_at: null,
      updated_at: trx.fn.now(3),
    });
    return {
      membership_id: Number(membership.id),
      contact_id: parsedContactId,
      status: 'active',
    };
  });
}

function activeCampaignContactIds(campaignId, database = knex) {
  return database('campaign_contacts as membership')
    .leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'membership.id')
    .where('membership.campaign_id', campaignId)
    .where('membership.status', 'active')
    .where((builder) => builder.whereNull('progress.status').orWhereNotIn(
      'progress.status', ['review_pending_details', 'completed', 'stopped', 'needs_review'],
    ))
    .pluck('membership.contact_id');
}

async function previewBlast(req, publicId, input) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  if (campaign.status !== 'active') throw httpError(409, 'Campaign harus aktif sebelum blast', 'CAMPAIGN_NOT_ACTIVE');
  const contactIds = await activeCampaignContactIds(campaign.id);
  if (!contactIds.length) throw httpError(409, 'Campaign belum memiliki kontak aktif', 'CAMPAIGN_HAS_NO_CONTACTS');
  return broadcastsService.preview({ ...input, name: input.name || campaign.title, contact_ids: contactIds });
}

async function createBlast(req, publicId, input) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  if (campaign.status !== 'active') throw httpError(409, 'Campaign harus aktif sebelum blast', 'CAMPAIGN_NOT_ACTIVE');
  const contactIds = await activeCampaignContactIds(campaign.id);
  if (!contactIds.length) throw httpError(409, 'Campaign belum memiliki kontak aktif', 'CAMPAIGN_HAS_NO_CONTACTS');
  return broadcastsService.create(
    { ...input, name: input.name || campaign.title, contact_ids: contactIds },
    actor.id,
    { campaignId: campaign.id },
  );
}

async function previewReblast(req, publicId, input) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  if (campaign.status !== 'active') throw httpError(409, 'Campaign harus aktif sebelum reblast', 'CAMPAIGN_NOT_ACTIVE');
  const target = parseReblastTarget(input);
  const contactIds = await targetContactIds(knex, campaign.id, target);
  const preview = await broadcastsService.preview({
    ...input,
    name: input.name || `Reblast ${campaign.title}`,
    body: withReblastConfirmationPrompt(input.body),
    contact_ids: contactIds,
  });
  return {
    ...preview,
    target_mode: target.mode,
    target_session: target.sessionNumber,
  };
}

async function createReblast(req, publicId, input) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  if (campaign.status !== 'active') throw httpError(409, 'Campaign harus aktif sebelum reblast', 'CAMPAIGN_NOT_ACTIVE');
  const target = parseReblastTarget(input);
  const contactIds = await targetContactIds(knex, campaign.id, target);
  if (!contactIds.length) throw httpError(409, 'Tidak ada alumni yang memenuhi target Reblast ini', 'CAMPAIGN_REBLAST_HAS_NO_TARGETS');
  return broadcastsService.create(
    {
      ...input,
      name: input.name || `Reblast ${campaign.title}`,
      body: withReblastConfirmationPrompt(input.body),
      contact_ids: contactIds,
    },
    actor.id,
    {
      campaignId: campaign.id,
      campaignDeliveryType: target.deliveryType,
      campaignTargetSession: target.sessionNumber,
    },
  );
}

async function listReblastTargets(req, publicId, filters) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  const value = z.object({
    mode: z.enum(['no_reply', 'stalled']),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }).parse(filters);
  const result = await listTargetContacts(knex, campaign.id, parseReblastTarget(value), value);
  if (shouldMaskPersonalData(req)) {
    result.data = result.data.map((row) => ({ ...row, name: '[MASKED]', phone_e164: maskPhone(row.phone_e164) }));
  }
  return result;
}

async function previewReblastTarget(req, publicId, membershipId, input) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  if (campaign.status !== 'active') {
    throw httpError(409, 'Campaign harus aktif sebelum preview Reblast', 'CAMPAIGN_NOT_ACTIVE');
  }
  const parsedMembershipId = z.coerce.number().int().positive().parse(membershipId);
  const value = reblastTargetPreviewSchema.parse(input);
  const target = parseReblastTarget(value);
  const contact = await findEligibleTargetContact(knex, campaign.id, target, parsedMembershipId);
  if (!contact) {
    throw httpError(409, 'Alumni tidak lagi memenuhi target Reblast ini. Muat ulang daftar target.', 'CAMPAIGN_REBLAST_TARGET_NOT_ELIGIBLE');
  }
  const preview = await broadcastsService.preview({
    name: `Preview Reblast ${campaign.title}`,
    body: withReblastConfirmationPrompt(value.body),
    contact_ids: [contact.contact_id],
  });
  const sample = preview.samples?.[0];
  if (!sample || preview.eligible !== 1) {
    throw httpError(409, 'Pesan tidak dapat dirender untuk alumni ini', 'CAMPAIGN_REBLAST_TARGET_PREVIEW_FAILED');
  }
  const masked = shouldMaskPersonalData(req);
  return {
    membership_id: contact.membership_id,
    contact_id: contact.contact_id,
    name: masked ? '[MASKED]' : contact.name,
    phone_e164: masked ? maskPhone(contact.phone_e164) : contact.phone_e164,
    current_session_number: contact.current_session_number,
    current_question_title: contact.current_question_title,
    target_mode: target.mode,
    body: masked ? '[MASKED]' : sample.body,
    character_count: masked ? null : sample.body.length,
  };
}

async function listBlasts(req, publicId, filters = {}) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  const kind = z.enum(['all', 'blast', 'reblast']).optional().default('all').parse(filters.kind);
  const query = knex('broadcasts').where({ campaign_id: campaign.id });
  if (kind === 'blast') query.where('campaign_delivery_type', 'blast');
  if (kind === 'reblast') query.whereIn('campaign_delivery_type', ['reblast_no_reply', 'reblast_stalled']);
  return query.select('*').orderBy('id', 'desc').limit(100);
}

async function setBlastStatus(req, publicId, broadcastPublicId, action) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  const broadcast = await knex('broadcasts').where({ campaign_id: campaign.id, public_id: broadcastPublicId }).first();
  if (!broadcast) throw httpError(404, 'Batch blast tidak ditemukan', 'CAMPAIGN_BLAST_NOT_FOUND');
  if (campaign.status !== 'active' && action === 'resume') throw httpError(409, 'Aktifkan campaign sebelum resume blast', 'CAMPAIGN_NOT_ACTIVE');
  return broadcastsService.setStatus(broadcastPublicId, action);
}

function currentCampaignReplyQuery(database, campaignId) {
  return database('campaign_incoming_messages as attribution')
    .join('incoming_messages as incoming', 'incoming.id', 'attribution.incoming_message_id')
    .leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'attribution.campaign_contact_id')
    .where('attribution.campaign_id', campaignId)
    .whereRaw('(progress.reset_at IS NULL OR incoming.received_at > progress.reset_at)');
}

async function monitoringSummary(req, publicId) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [membershipRows, messageRows, queueRows, replies, progressRows, unattributed, unread, today, registered, sessionRows, contactProgressRows] = await Promise.all([
    knex('campaign_contacts').where({ campaign_id: campaign.id }).select('status').count({ count: '*' }).groupBy('status'),
    knex('messages').where({ campaign_id: campaign.id }).select('status').count({ count: '*' }).groupBy('status'),
    knex('message_jobs').join('messages', 'messages.id', 'message_jobs.message_id').where('messages.campaign_id', campaign.id)
      .select('message_jobs.status').count({ count: '*' }).groupBy('message_jobs.status'),
    currentCampaignReplyQuery(knex, campaign.id).count({ count: '*' }).first(),
    knex('campaign_contact_progress as progress').join('campaign_contacts as cc', 'cc.id', 'progress.campaign_contact_id')
      .where('cc.campaign_id', campaign.id).select('progress.status').count({ count: '*' }).groupBy('progress.status'),
    knex('incoming_messages as incoming').leftJoin('campaign_incoming_messages as attributed', 'attributed.incoming_message_id', 'incoming.id')
      .whereNull('attributed.id').whereIn('incoming.contact_id', knex('campaign_contacts').select('contact_id').where({ campaign_id: campaign.id }))
      .count({ count: '*' }).first(),
    currentCampaignReplyQuery(knex, campaign.id).where('incoming.is_read', false).count({ count: '*' }).first(),
    currentCampaignReplyQuery(knex, campaign.id).where('incoming.received_at', '>=', todayStart).count({ count: '*' }).first(),
    currentCampaignReplyQuery(knex, campaign.id).whereNotNull('incoming.contact_id').countDistinct({ count: 'incoming.contact_id' }).first(),
    currentCampaignReplyQuery(knex, campaign.id).select('incoming.session_number').count({ count: '*' }).groupBy('incoming.session_number'),
    knex('campaign_contacts as cc').leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'cc.id')
      .where('cc.campaign_id', campaign.id).where('cc.status', 'active')
      .select(knex.raw("COALESCE(progress.status, 'not_started') AS progress_status"))
      .count({ count: '*' }).groupByRaw("COALESCE(progress.status, 'not_started')"),
  ]);
  const mapCounts = (rows, key = 'status') => Object.fromEntries(rows.map((row) => [row[key], Number(row.count)]));
  const sessionsBreakdown = {};
  sessionRows.forEach((row) => {
    const sessionNumber = Number(row.session_number);
    if (sessionNumber >= 1) sessionsBreakdown[sessionNumber] = Number(row.count);
  });
  return {
    campaign: { public_id: campaign.public_id, title: campaign.title, status: campaign.status },
    contacts: mapCounts(membershipRows),
    messages: mapCounts(messageRows),
    queue: mapCounts(queueRows),
    replies: Number(replies?.count || 0),
    unattributed_replies_for_campaign_contacts: Number(unattributed?.count || 0),
    progress: mapCounts(progressRows),
    inbox: {
      total: Number(replies?.count || 0),
      unread: Number(unread?.count || 0),
      today: Number(today?.count || 0),
      registered_contacts: Number(registered?.count || 0),
      sessions_breakdown: sessionsBreakdown,
    },
    contact_monitoring: {
      total: contactProgressRows.reduce((sum, row) => sum + Number(row.count), 0),
      ...Object.fromEntries(contactProgressRows.map((row) => [row.progress_status, Number(row.count)])),
    },
  };
}

async function monitoringContacts(req, publicId, filters) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  const value = monitoringFilterSchema.extend({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }).parse(filters);
  const base = () => {
    const query = knex('campaign_contacts as cc')
      .join('contacts', 'contacts.id', 'cc.contact_id')
      .leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'cc.id')
      .leftJoin('campaign_questions as current_question', 'current_question.id', 'progress.current_question_id')
      .where('cc.campaign_id', campaign.id)
      .where('cc.status', 'active')
      .whereNull('contacts.deleted_at');
    if (value.search) {
      const term = `%${value.search}%`;
      query.where((builder) => builder.where('contacts.name', 'like', term)
        .orWhere('contacts.phone_e164', 'like', term));
    }
    if (value.progress_status) query.whereRaw("COALESCE(progress.status, 'not_started') = ?", [value.progress_status]);
    if (value.session_number) query.where('progress.current_session_number', value.session_number);
    return query;
  };
  const [{ count }] = await base().count({ count: '*' });
  let rows = await base().select(
    'cc.id as membership_id', 'contacts.id as contact_id', 'contacts.name', 'contacts.phone_e164',
    knex.raw("COALESCE(progress.status, 'not_started') AS progress_status"),
    knex.raw('COALESCE(progress.current_session_number, 0) AS current_session_number'),
    'current_question.title as current_question_title',
    knex.raw('(SELECT COUNT(*) FROM campaign_incoming_messages attribution JOIN incoming_messages incoming ON incoming.id = attribution.incoming_message_id WHERE attribution.campaign_contact_id = cc.id AND (progress.reset_at IS NULL OR incoming.received_at > progress.reset_at)) AS reply_count'),
    knex.raw('(SELECT COUNT(*) FROM campaign_incoming_messages attribution JOIN incoming_messages incoming ON incoming.id = attribution.incoming_message_id WHERE attribution.campaign_contact_id = cc.id AND incoming.is_read = 0 AND (progress.reset_at IS NULL OR incoming.received_at > progress.reset_at)) AS unread_count'),
    knex.raw('(SELECT MAX(incoming.received_at) FROM campaign_incoming_messages attribution JOIN incoming_messages incoming ON incoming.id = attribution.incoming_message_id WHERE attribution.campaign_contact_id = cc.id AND (progress.reset_at IS NULL OR incoming.received_at > progress.reset_at)) AS last_reply_at'),
  ).orderBy('last_reply_at', 'desc').orderBy('contacts.name').limit(value.limit).offset((value.page - 1) * value.limit);
  rows = rows.map((row) => ({
    ...row,
    current_session_number: Number(row.current_session_number || 0),
    reply_count: Number(row.reply_count || 0),
    unread_count: Number(row.unread_count || 0),
  }));
  if (shouldMaskPersonalData(req)) rows = rows.map((row) => ({ ...row, name: '[MASKED]', phone_e164: maskPhone(row.phone_e164) }));
  return {
    data: rows,
    pagination: {
      page: value.page,
      limit: value.limit,
      total: Number(count),
      total_pages: Math.max(1, Math.ceil(Number(count) / value.limit)),
    },
  };
}

function safeExportFilename(title, generatedAt) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Makassar', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(generatedAt).replace(/-/g, '');
  const slug = String(title || 'campaign')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'campaign';
  return `jawaban-${slug}-${date}.xlsx`;
}

async function exportMonitoringAnswers(req, publicId, filters) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  const value = monitoringFilterSchema.parse(filters);
  const contactsQuery = knex('campaign_contacts as cc')
    .join('contacts', 'contacts.id', 'cc.contact_id')
    .leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'cc.id')
    .leftJoin('campaign_questions as current_question', 'current_question.id', 'progress.current_question_id')
    .leftJoin('contact_academic_profiles as profile', function joinAcademicProfile() {
      this.on('profile.contact_id', '=', 'contacts.id')
        .andOn('profile.university_group_id', '=', knex.raw('?', [campaign.university_group_id]));
    })
    .leftJoin('contact_groups as university', 'university.id', 'profile.university_group_id')
    .leftJoin('contact_groups as faculty', 'faculty.id', 'profile.faculty_group_id')
    .leftJoin('contact_groups as study_program', 'study_program.id', 'profile.study_program_group_id')
    .where('cc.campaign_id', campaign.id)
    .where('cc.status', 'active')
    .whereNull('contacts.deleted_at');
  if (value.search) {
    const term = `%${value.search}%`;
    contactsQuery.where((builder) => builder.where('contacts.name', 'like', term)
      .orWhere('contacts.phone_e164', 'like', term));
  }
  if (value.progress_status) {
    contactsQuery.whereRaw("COALESCE(progress.status, 'not_started') = ?", [value.progress_status]);
  }
  if (value.session_number) contactsQuery.where('progress.current_session_number', value.session_number);

  let contacts = await contactsQuery.select(
    'cc.id as membership_id', 'contacts.name', 'contacts.phone_e164',
    'profile.student_number', 'profile.entry_year',
    'university.name as university_name', 'faculty.name as faculty_name',
    'study_program.name as study_program_name',
    knex.raw("COALESCE(progress.status, 'not_started') AS progress_status"),
    'current_question.title as current_question_title',
    'progress.started_at', 'progress.completed_at', 'progress.reset_at',
  ).orderBy('contacts.name').orderBy('cc.id').limit(MONITORING_EXPORT_MAX_CONTACTS + 1);
  if (contacts.length > MONITORING_EXPORT_MAX_CONTACTS) {
    throw httpError(
      413,
      `Export dibatasi maksimal ${MONITORING_EXPORT_MAX_CONTACTS.toLocaleString('id-ID')} alumni. Persempit filter Monitoring lalu coba lagi.`,
      'CAMPAIGN_MONITORING_EXPORT_CONTACT_LIMIT',
    );
  }

  const membershipIds = contacts.map((contact) => Number(contact.membership_id));
  let answers = [];
  if (membershipIds.length) {
    answers = await knex('campaign_incoming_messages as attribution')
      .join('incoming_messages as incoming', 'incoming.id', 'attribution.incoming_message_id')
      .join('campaign_contacts as membership', 'membership.id', 'attribution.campaign_contact_id')
      .join('contacts', 'contacts.id', 'membership.contact_id')
      .leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'membership.id')
      .join('campaign_questions as question', 'question.id', 'attribution.campaign_question_id')
      .leftJoin('campaign_questionnaires as questionnaire', 'questionnaire.id', 'question.questionnaire_id')
      .leftJoin('campaign_question_options as selected_option', 'selected_option.id', 'attribution.campaign_question_option_id')
      .leftJoin('contact_academic_profiles as profile', function joinAcademicProfile() {
        this.on('profile.contact_id', '=', 'contacts.id')
          .andOn('profile.university_group_id', '=', knex.raw('?', [campaign.university_group_id]));
      })
      .where('attribution.campaign_id', campaign.id)
      .where('attribution.interaction_type', 'session_answer')
      .whereIn('membership.id', membershipIds)
      .whereRaw('(progress.reset_at IS NULL OR incoming.received_at > progress.reset_at)')
      .select(
        'attribution.id as attribution_id', 'membership.id as membership_id',
        'contacts.name', 'contacts.phone_e164', 'profile.student_number',
        'incoming.body as raw_answer', 'incoming.session_number', 'incoming.received_at',
        'question.public_id as question_public_id', 'question.position as question_position',
        'question.title as question_title', 'question.question_text', 'question.answer_type',
        'selected_option.answer_text as selected_answer_text',
        'questionnaire.name as questionnaire_name', 'questionnaire.version as questionnaire_version',
      )
      .orderBy('contacts.name').orderBy('incoming.received_at').orderBy('attribution.id')
      .limit(MONITORING_EXPORT_MAX_ANSWERS + 1);
  }
  if (answers.length > MONITORING_EXPORT_MAX_ANSWERS) {
    throw httpError(
      413,
      `Export dibatasi maksimal ${MONITORING_EXPORT_MAX_ANSWERS.toLocaleString('id-ID')} input jawaban. Persempit filter Monitoring lalu coba lagi.`,
      'CAMPAIGN_MONITORING_EXPORT_ANSWER_LIMIT',
    );
  }

  const masked = shouldMaskPersonalData(req);
  if (masked) {
    contacts = contacts.map((contact) => ({
      ...contact,
      name: '[MASKED]',
      phone_e164: maskPhone(contact.phone_e164),
      student_number: contact.student_number ? '[MASKED]' : null,
    }));
    answers = answers.map((answer) => ({
      ...answer,
      name: '[MASKED]',
      phone_e164: maskPhone(answer.phone_e164),
      student_number: answer.student_number ? '[MASKED]' : null,
      raw_answer: answer.raw_answer ? '[MASKED]' : '',
    }));
  }

  const generatedAt = new Date();
  const workbook = buildCampaignMonitoringWorkbook({ campaign, contacts, answers, filters: value, generatedAt });
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    buffer,
    filename: safeExportFilename(campaign.title, generatedAt),
    contact_count: contacts.length,
    answer_count: answers.length,
    masked,
    filters: value,
  };
}

async function monitoringContactDetail(req, publicId, membershipId) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  let contact = await knex('campaign_contacts as cc')
    .join('contacts', 'contacts.id', 'cc.contact_id')
    .leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'cc.id')
    .leftJoin('campaign_questions as current_question', 'current_question.id', 'progress.current_question_id')
    .where('cc.campaign_id', campaign.id)
    .where('cc.id', z.coerce.number().int().positive().parse(membershipId))
    .whereNull('contacts.deleted_at')
    .select(
      'cc.id as membership_id', 'cc.status as membership_status', 'cc.exclusion_reason', 'cc.added_at',
      'contacts.id as contact_id', 'contacts.name', 'contacts.phone_e164', 'contacts.status as contact_status',
      'contacts.consent_status', 'contacts.consent_source', 'contacts.wa_registration_status',
      knex.raw("COALESCE(progress.status, 'not_started') AS progress_status"),
      knex.raw('COALESCE(progress.current_session_number, 0) AS current_session_number'),
      'current_question.title as current_question_title',
      'progress.review_fields',
      'progress.started_at', 'progress.completed_at', 'progress.reset_at', 'progress.reset_count',
      'progress.updated_at as progress_updated_at',
    ).first();
  if (!contact) throw httpError(404, 'Kontak monitoring Campaign tidak ditemukan', 'CAMPAIGN_MONITORING_CONTACT_NOT_FOUND');
  const applyResetBoundary = (query, column) => {
    if (contact.reset_at) query.where(column, '>', contact.reset_at);
    return query;
  };
  const [replies, replyStats, deliveryRows, latestOutbound] = await Promise.all([
    applyResetBoundary(knex('campaign_incoming_messages as attribution')
      .join('incoming_messages as incoming', 'incoming.id', 'attribution.incoming_message_id')
      .leftJoin('campaign_questions as question', 'question.id', 'attribution.campaign_question_id')
      .leftJoin('campaign_question_options as selected_option', 'selected_option.id', 'attribution.campaign_question_option_id')
      .where('attribution.campaign_id', campaign.id)
      .where('attribution.campaign_contact_id', contact.membership_id)
      .select(
        'incoming.public_id', 'incoming.body', 'incoming.has_media', 'incoming.media_type',
        'incoming.session_number', 'incoming.is_read', 'incoming.received_at', 'attribution.attribution_method',
        'attribution.interaction_type', 'attribution.reblast_decision',
        'question.title as question_title', 'selected_option.answer_text as selected_answer_text',
      ).orderBy('incoming.received_at', 'desc').limit(100), 'incoming.received_at'),
    applyResetBoundary(knex('campaign_incoming_messages as attribution')
      .join('incoming_messages as incoming', 'incoming.id', 'attribution.incoming_message_id')
      .where('attribution.campaign_id', campaign.id)
      .where('attribution.campaign_contact_id', contact.membership_id)
      .count({ total: '*' })
      .sum({ unread: knex.raw('CASE WHEN incoming.is_read = 0 THEN 1 ELSE 0 END') })
      .first(), 'incoming.received_at'),
    applyResetBoundary(knex('messages').where({ campaign_id: campaign.id, contact_id: contact.contact_id })
      .select('status').count({ count: '*' }).groupBy('status'), 'created_at'),
    applyResetBoundary(knex('messages').where({ campaign_id: campaign.id, contact_id: contact.contact_id })
      .select('body', 'status', 'sent_at', 'created_at').orderBy('id', 'desc').first(), 'created_at'),
  ]);
  contact = {
    ...contact,
    reported_fields: parseStoredReviewFields(contact.review_fields),
    reported_field_labels: reviewFieldLabels(contact.review_fields),
    review_fields: undefined,
    current_session_number: Number(contact.current_session_number || 0),
    reply_count: Number(replyStats?.total || 0),
    unread_count: Number(replyStats?.unread || 0),
    delivery: Object.fromEntries(deliveryRows.map((row) => [row.status, Number(row.count)])),
    latest_outbound: latestOutbound || null,
  };
  let safeReplies = replies;
  if (shouldMaskPersonalData(req)) {
    contact = {
      ...contact,
      name: '[MASKED]',
      phone_e164: maskPhone(contact.phone_e164),
      latest_outbound: contact.latest_outbound ? { ...contact.latest_outbound, body: '[MASKED]' } : null,
    };
    safeReplies = replies.map((reply) => ({ ...reply, body: reply.body ? '[MASKED]' : '' }));
  }
  return { contact, replies: safeReplies, history_limit: 100 };
}

async function markMonitoringMessageRead(req, publicId, incomingPublicId) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  const row = await knex('campaign_incoming_messages as attribution')
    .join('incoming_messages as incoming', 'incoming.id', 'attribution.incoming_message_id')
    .where('attribution.campaign_id', campaign.id)
    .where('incoming.public_id', incomingPublicId)
    .first('incoming.id');
  if (!row) throw httpError(404, 'Balasan Campaign tidak ditemukan', 'CAMPAIGN_REPLY_NOT_FOUND');
  await knex('incoming_messages').where({ id: row.id }).update({ is_read: true, updated_at: knex.fn.now(3) });
  return { public_id: incomingPublicId, is_read: true };
}

async function markMonitoringContactRepliesRead(req, publicId, membershipId) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  const membership = await knex('campaign_contacts as membership')
    .leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'membership.id')
    .where({
      'membership.campaign_id': campaign.id,
      'membership.id': z.coerce.number().int().positive().parse(membershipId),
    })
    .first('membership.id', 'progress.reset_at');
  if (!membership) throw httpError(404, 'Kontak monitoring Campaign tidak ditemukan', 'CAMPAIGN_MONITORING_CONTACT_NOT_FOUND');
  const incomingIds = knex('campaign_incoming_messages as attribution')
    .join('incoming_messages as incoming', 'incoming.id', 'attribution.incoming_message_id')
    .select('attribution.incoming_message_id')
    .where({ 'attribution.campaign_id': campaign.id, 'attribution.campaign_contact_id': membership.id });
  if (membership.reset_at) incomingIds.where('incoming.received_at', '>', membership.reset_at);
  const updated = await knex('incoming_messages').whereIn('id', incomingIds).where('is_read', false)
    .update({ is_read: true, updated_at: knex.fn.now(3) });
  return { membership_id: Number(membership.id), updated_count: Number(updated) };
}

function parseReviewCorrection(input) {
  const value = reviewCorrectionSchema.parse(input);
  return {
    name: value.name,
    phone_e164: normalizePhone(value.phone),
    email: normalizeEmail(value.email),
    entry_year: parseEntryYear(value.entry_year),
    study_program_group_id: Number(value.study_program_group_id),
  };
}

function reviewCorrectionChangedFields(current, correction) {
  const fieldMap = {
    name: [current.name, correction.name],
    phone: [current.phone_e164, correction.phone_e164],
    email: [current.email, correction.email],
    entry_year: [current.entry_year, correction.entry_year],
    study_program: [current.study_program_group_id, correction.study_program_group_id],
  };
  return Object.entries(fieldMap)
    .filter(([, [before, after]]) => String(before ?? '') !== String(after ?? ''))
    .map(([field]) => field);
}

function scopedStudyPrograms(database, campaign) {
  const query = database('contact_groups as program')
    .join('contact_groups as faculty', 'faculty.id', 'program.parent_id')
    .where({
      'program.type': 'study_program',
      'program.status': 'active',
      'faculty.type': 'faculty',
      'faculty.status': 'active',
      'faculty.parent_id': campaign.university_group_id,
    });
  if (campaign.faculty_group_id) query.where('faculty.id', campaign.faculty_group_id);
  if (campaign.study_program_group_id) query.where('program.id', campaign.study_program_group_id);
  return query;
}

async function listReviewCorrections(req, publicId, filters) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  const value = z.object({
    search: z.string().trim().max(180).optional().default(''),
    membership_id: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }).parse(filters);
  const base = () => {
    const query = knex('campaign_contacts as membership')
      .join('contacts as contact', 'contact.id', 'membership.contact_id')
      .join('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'membership.id')
      .join('contact_academic_profiles as profile', function joinAcademicProfile() {
        this.on('profile.contact_id', '=', 'contact.id')
          .andOn('profile.university_group_id', '=', knex.raw('?', [campaign.university_group_id]));
      })
      .join('contact_groups as program', 'program.id', 'profile.study_program_group_id')
      .join('contact_groups as faculty', 'faculty.id', 'profile.faculty_group_id')
      .where({
        'membership.campaign_id': campaign.id,
        'membership.status': 'active',
        'progress.status': 'needs_review',
      })
      .whereNull('contact.deleted_at');
    if (value.membership_id) query.where('membership.id', value.membership_id);
    if (value.search) {
      const term = `%${value.search}%`;
      query.where((builder) => builder.where('contact.name', 'like', term)
        .orWhere('contact.phone_e164', 'like', term)
        .orWhere('profile.student_number', 'like', term)
        .orWhere('profile.email', 'like', term));
    }
    return query;
  };
  const [countRows, programs] = await Promise.all([
    base().count({ count: '*' }),
    scopedStudyPrograms(knex, campaign)
      .select(
        'program.id', 'program.code', 'program.name',
        'faculty.id as faculty_id', 'faculty.code as faculty_code', 'faculty.name as faculty_name',
      )
      .orderBy('faculty.name').orderBy('program.name'),
  ]);
  let data = await base().select(
    'membership.id as membership_id', 'contact.name', 'contact.phone_e164',
    'profile.student_number', 'profile.entry_year', 'profile.email',
    'profile.study_program_group_id', 'program.name as study_program_name',
    'faculty.name as faculty_name', 'progress.review_fields', 'progress.updated_at as review_requested_at',
  ).orderBy('progress.updated_at').orderBy('membership.id')
    .limit(value.limit).offset((value.page - 1) * value.limit);
  data = data.map((row) => {
    const reportedFields = parseStoredReviewFields(row.review_fields);
    return {
      ...row,
      review_fields: undefined,
      reported_fields: reportedFields,
      reported_field_labels: reviewFieldLabels(reportedFields),
    };
  });
  return {
    data,
    study_programs: programs,
    pagination: {
      page: value.page,
      limit: value.limit,
      total: Number(countRows[0]?.count || 0),
      total_pages: Math.max(1, Math.ceil(Number(countRows[0]?.count || 0) / value.limit)),
    },
  };
}

async function correctReviewedContact(req, publicId, membershipId, input) {
  const actor = actorFromRequest(req);
  const parsedMembershipId = z.coerce.number().int().positive().parse(membershipId);
  const correction = parseReviewCorrection(input);
  const campaign = await findScopedCampaign(publicId, actor);
  const current = await knex('campaign_contacts as membership')
    .join('contacts as contact', 'contact.id', 'membership.contact_id')
    .join('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'membership.id')
    .join('contact_academic_profiles as profile', function joinAcademicProfile() {
      this.on('profile.contact_id', '=', 'contact.id')
        .andOn('profile.university_group_id', '=', knex.raw('?', [campaign.university_group_id]));
    })
    .where({
      'membership.id': parsedMembershipId,
      'membership.campaign_id': campaign.id,
      'progress.status': 'needs_review',
    })
    .whereNull('contact.deleted_at')
    .first(
      'contact.phone_e164', 'contact.name', 'profile.email', 'profile.entry_year',
      'profile.study_program_group_id',
    );
  if (!current) throw httpError(404, 'Data koreksi alumni tidak ditemukan', 'CAMPAIGN_REVIEW_CORRECTION_NOT_FOUND');

  const changedPhone = current.phone_e164 !== correction.phone_e164;
  let phoneCheckedAt = null;
  if (changedPhone) {
    const registered = await whatsappManager.checkNumberRegistered(correction.phone_e164);
    if (!registered) {
      throw httpError(422, 'Nomor baru tidak terdaftar di WhatsApp', 'CORRECTION_PHONE_NOT_REGISTERED');
    }
    phoneCheckedAt = new Date();
  }

  return knex.transaction(async (trx) => {
    const lockedCampaign = await findScopedCampaign(publicId, actor, trx, true);
    return resumeReviewedContactInTransaction(trx, lockedCampaign.id, parsedMembershipId, {
      beforeResume: async ({ membership, progress }) => {
        const profile = await trx('contact_academic_profiles')
          .where({ contact_id: membership.contact_id, university_group_id: lockedCampaign.university_group_id })
          .forUpdate().first();
        if (!profile) {
          throw httpError(409, 'Profil akademik alumni tidak ditemukan', 'CAMPAIGN_REVIEW_PROFILE_NOT_FOUND');
        }
        const program = await scopedStudyPrograms(trx, lockedCampaign)
          .where('program.id', correction.study_program_group_id)
          .first('program.id', 'program.parent_id as faculty_id');
        if (!program) {
          throw httpError(422, 'Program studi berada di luar scope Campaign atau sudah nonaktif', 'STUDY_PROGRAM_OUTSIDE_CAMPAIGN_SCOPE');
        }
        const changedFields = reviewCorrectionChangedFields({
          name: membership.name,
          phone_e164: membership.phone_e164,
          email: profile.email,
          entry_year: profile.entry_year,
          study_program_group_id: profile.study_program_group_id,
        }, correction);
        if (!changedFields.length) {
          throw httpError(422, 'Ubah minimal satu data sebelum menyelesaikan verifikasi', 'CAMPAIGN_REVIEW_CORRECTION_REQUIRED');
        }
        if (membership.phone_e164 !== correction.phone_e164) {
          const duplicate = await trx('contacts').where({ phone_e164: correction.phone_e164 })
            .whereNot('id', membership.contact_id).forUpdate().first('id');
          if (duplicate) throw httpError(409, 'Nomor WhatsApp sudah digunakan kontak lain', 'CONTACT_ALREADY_EXISTS');
          if (!phoneCheckedAt) {
            throw httpError(409, 'Nomor baru belum diverifikasi ke WhatsApp', 'CORRECTION_PHONE_CHECK_REQUIRED');
          }
        }

        const contactUpdates = {
          name: correction.name,
          phone_e164: correction.phone_e164,
          updated_at: trx.fn.now(3),
        };
        if (membership.phone_e164 !== correction.phone_e164) {
          contactUpdates.wa_registration_status = 'registered';
          contactUpdates.wa_registration_checked_at = phoneCheckedAt;
        }
        await trx('contacts').where({ id: membership.contact_id }).update(contactUpdates);
        await trx('contact_academic_profiles').where({ id: profile.id }).update({
          faculty_group_id: program.faculty_id,
          study_program_group_id: program.id,
          entry_year: correction.entry_year,
          email: correction.email,
          updated_at: trx.fn.now(3),
        });
        if (Number(profile.study_program_group_id) !== Number(program.id)) {
          if (profile.study_program_group_id) {
            await trx('contact_group_members').where({
              contact_id: membership.contact_id,
              contact_group_id: profile.study_program_group_id,
            }).del();
          }
          await trx('contact_group_members').insert({
            contact_id: membership.contact_id,
            contact_group_id: program.id,
          }).onConflict(['contact_group_id', 'contact_id']).ignore();
        }
        return {
          contact: { name: correction.name, phone_e164: correction.phone_e164 },
          result: {
            changed_fields: changedFields,
            reported_fields: parseStoredReviewFields(progress.review_fields),
          },
        };
      },
    });
  });
}

async function resumeReviewedContact(req, publicId, membershipId) {
  const actor = actorFromRequest(req);
  await findScopedCampaign(publicId, actor);
  z.coerce.number().int().positive().parse(membershipId);
  throw httpError(
    409,
    'Gunakan halaman Perbaikan Data dan ubah minimal satu data sebelum melanjutkan questionnaire',
    'CAMPAIGN_REVIEW_CORRECTION_REQUIRED',
  );
}

async function resetCampaignProgress(req, publicId, input) {
  const actor = actorFromRequest(req);
  if (!['development', 'test'].includes(env.nodeEnv)) {
    throw httpError(404, 'Endpoint tidak ditemukan', 'NOT_FOUND');
  }
  if (!hasGlobalAccess(actor)) throw httpError(403, 'Hanya pengelola Campaign yang dapat mereset seluruh progres', 'FORBIDDEN');
  z.object({ confirmation: z.literal('RESET SEMUA') }).parse(input);

  return knex.transaction(async (trx) => {
    const campaign = await findScopedCampaign(publicId, actor, trx, true);
    if (['completed', 'archived'].includes(campaign.status)) {
      throw httpError(409, 'Progres pada Campaign selesai atau diarsipkan tidak dapat direset', 'CAMPAIGN_PROGRESS_RESET_LOCKED');
    }
    const memberships = await trx('campaign_contacts').where({ campaign_id: campaign.id })
      .select('id').forUpdate();
    const membershipIds = memberships.map((membership) => Number(membership.id));
    const progressRows = membershipIds.length
      ? await trx('campaign_contact_progress').whereIn('campaign_contact_id', membershipIds).select('*').forUpdate()
      : [];
    const jobRows = await trx('message_jobs as job')
      .join('messages as message', 'message.id', 'job.message_id')
      .where('message.campaign_id', campaign.id)
      .where((builder) => builder.whereIn('job.status', ['pending', 'reserved', 'processing'])
        .orWhere('message.status', 'processing'))
      .select('job.id', 'job.message_id', 'job.status', 'message.status as message_status').forUpdate();
    if (jobRows.some((job) => job.status === 'processing' || job.message_status === 'processing')) {
      throw httpError(409, 'Reset ditolak karena masih ada pesan yang sedang dikirim. Tunggu status final lalu coba lagi.', 'CAMPAIGN_PROGRESS_RESET_MESSAGE_IN_FLIGHT');
    }

    const cancellableMessages = await trx('messages')
      .where({ campaign_id: campaign.id })
      .whereIn('status', ['draft', 'queued'])
      .select('id', 'broadcast_id').forUpdate();
    const messageIds = cancellableMessages.map((message) => Number(message.id));
    const jobIds = jobRows.map((job) => Number(job.id));
    if (jobIds.length) {
      await trx('message_jobs').whereIn('id', jobIds).whereIn('status', ['pending', 'reserved']).update({
        status: 'cancelled', locked_at: null, locked_by: null,
        last_error_code: 'CAMPAIGN_PROGRESS_RESET', updated_at: trx.fn.now(3),
      });
    }
    if (messageIds.length) {
      await trx('messages').whereIn('id', messageIds).whereIn('status', ['draft', 'queued'])
        .update({ status: 'cancelled', updated_at: trx.fn.now(3) });
      for (let index = 0; index < messageIds.length; index += 1000) {
        await trx('message_events').insert(messageIds.slice(index, index + 1000).map((messageId) => ({
          message_id: messageId,
          event_type: 'cancelled',
          error_code: 'CAMPAIGN_PROGRESS_RESET',
        })));
      }
      await trx('broadcast_recipients').whereIn('message_id', messageIds).whereIn('status', ['pending', 'queued'])
        .update({ status: 'skipped', skip_reason: 'CAMPAIGN_PROGRESS_RESET' });
    }

    const broadcastIds = [...new Set(cancellableMessages.map((message) => Number(message.broadcast_id)).filter(Boolean))];
    for (const broadcastId of broadcastIds) {
      const recipientRows = await trx('broadcast_recipients').where({ broadcast_id: broadcastId })
        .select('status').count({ count: '*' }).groupBy('status');
      const counts = Object.fromEntries(recipientRows.map((row) => [row.status, Number(row.count)]));
      const updates = {
        sent_count: counts.sent || 0,
        failed_count: counts.failed || 0,
        skipped_count: counts.skipped || 0,
        updated_at: trx.fn.now(3),
      };
      if ((counts.pending || 0) + (counts.queued || 0) === 0) {
        updates.status = counts.failed ? 'partially_failed' : 'completed';
        updates.completed_at = trx.fn.now(3);
      }
      await trx('broadcasts').where({ id: broadcastId }).whereNot('status', 'cancelled').update(updates);
    }

    const resetAt = new Date();
    if (progressRows.length) {
      await trx('campaign_contact_progress').whereIn('id', progressRows.map((progress) => Number(progress.id))).update({
        current_session_number: 0,
        current_question_id: null,
        status: 'not_started',
        review_fields: null,
        last_incoming_message_id: null,
        last_outbound_message_id: null,
        started_at: null,
        completed_at: null,
        reset_at: resetAt,
        reset_count: trx.raw('reset_count + 1'),
        updated_at: trx.fn.now(3),
      });
    }
    const existingMembershipIds = new Set(progressRows.map((progress) => Number(progress.campaign_contact_id)));
    const missingMembershipIds = membershipIds.filter((id) => !existingMembershipIds.has(id));
    for (let index = 0; index < missingMembershipIds.length; index += 1000) {
      await trx('campaign_contact_progress').insert(missingMembershipIds.slice(index, index + 1000).map((campaignContactId) => ({
        campaign_contact_id: campaignContactId,
        current_session_number: 0,
        current_question_id: null,
        status: 'not_started',
        reset_at: resetAt,
        reset_count: 1,
      })));
    }
    const previousStatuses = progressRows.reduce((counts, progress) => {
      counts[progress.status] = (counts[progress.status] || 0) + 1;
      return counts;
    }, {});
    return {
      campaign_public_id: campaign.public_id,
      reset_at: resetAt,
      membership_count: membershipIds.length,
      existing_progress_count: progressRows.length,
      created_progress_count: missingMembershipIds.length,
      previous_statuses: previousStatuses,
      cancelled_message_count: messageIds.length,
      cancelled_job_count: jobIds.length,
    };
  });
}

async function monitoringRecipients(req, publicId, filters) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  const status = filters.status && ['queued', 'processing', 'sent', 'failed', 'cancelled'].includes(filters.status) ? filters.status : null;
  const limit = Math.min(100, Math.max(1, Number(filters.limit) || 50));
  let query = knex('messages').leftJoin('contacts', 'contacts.id', 'messages.contact_id')
    .where('messages.campaign_id', campaign.id)
    .select('messages.public_id', 'messages.recipient_phone_e164', 'messages.status', 'messages.sent_at', 'messages.failed_at', 'messages.created_at', 'contacts.name as contact_name')
    .orderBy('messages.id', 'desc').limit(limit);
  if (status) query = query.where('messages.status', status);
  let rows = await query;
  if (shouldMaskPersonalData(req)) rows = rows.map((row) => ({ ...row, recipient_phone_e164: maskPhone(row.recipient_phone_e164), contact_name: row.contact_name ? '[MASKED]' : null }));
  return rows;
}

async function monitoringReplies(req, publicId) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  let rows = await currentCampaignReplyQuery(knex, campaign.id)
    .leftJoin('contacts', 'contacts.id', 'incoming.contact_id')
    .select(
      'incoming.public_id', 'incoming.from_phone', 'incoming.from_name', 'incoming.body', 'incoming.session_number', 'incoming.received_at',
      'attribution.attribution_method', 'contacts.name as contact_name',
    ).orderBy('incoming.received_at', 'desc').limit(200);
  if (shouldMaskPersonalData(req)) rows = rows.map((row) => ({ ...row, from_phone: maskPhone(row.from_phone), from_name: row.from_name ? '[MASKED]' : null, contact_name: row.contact_name ? '[MASKED]' : null, body: row.body ? '[MASKED]' : '' }));
  return rows;
}

async function monitoringUnattributed(req, publicId) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  let rows = await knex('incoming_messages as incoming')
    .join('campaign_contacts as cc', 'cc.contact_id', 'incoming.contact_id')
    .leftJoin('campaign_incoming_messages as attribution', 'attribution.incoming_message_id', 'incoming.id')
    .leftJoin('contacts', 'contacts.id', 'incoming.contact_id')
    .where('cc.campaign_id', campaign.id)
    .whereNull('attribution.id')
    .select('incoming.public_id', 'incoming.from_phone', 'incoming.from_name', 'incoming.body', 'incoming.received_at', 'contacts.name as contact_name')
    .orderBy('incoming.received_at', 'desc')
    .limit(100);
  if (shouldMaskPersonalData(req)) rows = rows.map((row) => ({ ...row, from_phone: maskPhone(row.from_phone), from_name: row.from_name ? '[MASKED]' : null, contact_name: row.contact_name ? '[MASKED]' : null, body: row.body ? '[MASKED]' : '' }));
  return rows;
}

async function attributeReply(req, publicId, incomingPublicId) {
  const actor = actorFromRequest(req);
  const campaign = await findScopedCampaign(publicId, actor);
  const incoming = await knex('incoming_messages').where({ public_id: incomingPublicId }).first();
  if (!incoming) throw httpError(404, 'Balasan tidak ditemukan', 'INCOMING_MESSAGE_NOT_FOUND');
  if (!incoming.contact_id) throw httpError(409, 'Balasan belum terhubung ke master kontak', 'INCOMING_CONTACT_UNRESOLVED');
  const membership = await knex('campaign_contacts').where({ campaign_id: campaign.id, contact_id: incoming.contact_id }).first('id');
  if (!membership) throw httpError(409, 'Kontak balasan bukan anggota campaign', 'CONTACT_NOT_IN_CAMPAIGN');
  const result = await attributeAndAdvance(incoming, {
    campaignId: campaign.id,
    attributionMethod: 'manual',
    attributedBy: actor.id,
  });
  if (result.duplicate) {
    throw httpError(409, 'Balasan sudah teratribusi; koreksi lintas campaign memerlukan review manual', 'REPLY_ALREADY_ATTRIBUTED');
  }
  return result;
}

module.exports = {
  CAMPAIGN_TRANSITIONS,
  canAccessCampaign,
  canTransitionCampaign,
  canHardDeleteCampaign,
  validateCampaignDeleteConfirmation,
  actorFromRequest,
  applyScope,
  findScopedCampaign,
  list,
  getDetail,
  create,
  listQuestions,
  listQuestionSources,
  importQuestionsFromCampaign,
  createQuestion,
  updateQuestion,
  removeQuestion,
  update,
  setStatus,
  remove,
  metadata,
  listContacts,
  excludeContact,
  reactivateContact,
  previewBlast,
  createBlast,
  previewReblast,
  previewReblastTarget,
  createReblast,
  listReblastTargets,
  listBlasts,
  setBlastStatus,
  monitoringSummary,
  monitoringContacts,
  exportMonitoringAnswers,
  monitoringContactDetail,
  markMonitoringMessageRead,
  markMonitoringContactRepliesRead,
  listReviewCorrections,
  correctReviewedContact,
  parseReviewCorrection,
  reviewCorrectionChangedFields,
  resumeReviewedContact,
  resetCampaignProgress,
  monitoringRecipients,
  monitoringReplies,
  monitoringUnattributed,
  attributeReply,
};
