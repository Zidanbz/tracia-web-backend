function normalizeAnswer(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('id-ID')
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:]+$/g, '');
}

function isActive(value) {
  return value === true || Number(value) === 1;
}

const QUESTION_VARIABLES = Object.freeze([
  'nama', 'nomor', 'nomor_masked', 'email', 'email_masked',
  'nim', 'tahun_masuk', 'fakultas', 'jurusan', 'periode_wisuda',
]);

function renderQuestionVariables(template, variables = {}) {
  return String(template || '').replace(/{{\s*([a-z_]+)\s*}}/gi, (match, key) => {
    const normalizedKey = key.toLocaleLowerCase('id-ID');
    if (!QUESTION_VARIABLES.includes(normalizedKey)) return match;
    const value = variables[normalizedKey];
    return value === null || value === undefined || value === '' ? '-' : String(value);
  });
}

function formatQuestionMessage(question, variables = {}) {
  const text = renderQuestionVariables(question?.question_text, variables).trim();
  const options = Array.isArray(question?.options) ? question.options.filter((option) => isActive(option.is_active)) : [];
  if (question?.answer_type !== 'choice' || options.length === 0) return text;
  const choices = options.map((option, index) => `${index + 1}. ${option.answer_text}`).join('\n');
  return `${text}\n\nPilihan jawaban:\n${choices}\n\nKakak bisa membalas dengan nomor, huruf, atau teks pilihannya ya.`;
}

function formatInvalidAnswerMessage(question, variables = {}) {
  if (question?.answer_type !== 'choice') {
    return `Maaf, Kak, jawabannya belum terbaca sebagai teks. Boleh kirim ulang jawaban tertulis untuk pertanyaan berikut ya.\n\n${formatQuestionMessage(question, variables)}`;
  }
  return `Maaf, Kak, jawabannya belum cocok dengan pilihan yang tersedia. Boleh pilih salah satu jawaban berikut ya.\n\n${formatQuestionMessage(question, variables)}`;
}

function matchQuestionOption(question, incomingBody) {
  if (question?.answer_type !== 'choice') {
    return { valid: Boolean(normalizeAnswer(incomingBody)), option: null };
  }
  const options = (question.options || []).filter((option) => isActive(option.is_active));
  const answer = normalizeAnswer(incomingBody);
  if (!answer) return { valid: false, option: null };

  const numericMatch = answer.match(/^(?:pilihan\s*)?(\d+)$/);
  if (numericMatch) {
    const option = options[Number(numericMatch[1]) - 1];
    return { valid: Boolean(option), option: option || null };
  }
  if (/^[a-z]$/.test(answer)) {
    const option = options[answer.charCodeAt(0) - 97];
    return { valid: Boolean(option), option: option || null };
  }
  const option = options.find((item) => normalizeAnswer(item.answer_text) === answer) || null;
  return { valid: Boolean(option), option };
}

function resolveQuestionRoute(question, option = null) {
  if (option) {
    return {
      action: option.action_type || 'next',
      targetQuestionId: option.next_question_id || null,
    };
  }
  return {
    action: question?.next_question_id ? 'goto' : 'next',
    targetQuestionId: question?.next_question_id || null,
  };
}

async function hydrateQuestions(database, rows) {
  if (!rows.length) return [];
  const questionTargetIds = rows.map((row) => row.next_question_id).filter(Boolean);
  const [options, questionTargets] = await Promise.all([
    database('campaign_question_options as option_item')
      .leftJoin('campaign_questions as target_question', 'target_question.id', 'option_item.next_question_id')
      .whereIn('campaign_question_id', rows.map((row) => row.id))
      .select(
        'option_item.*',
        'target_question.public_id as next_question_public_id',
        'target_question.position as next_question_position',
        'target_question.title as next_question_title',
      )
      .orderBy('option_item.position'),
    questionTargetIds.length
      ? database('campaign_questions').whereIn('id', questionTargetIds)
        .select('id', 'public_id', 'position', 'title')
      : [],
  ]);
  const grouped = new Map();
  const questionTargetsById = new Map(questionTargets.map((target) => [Number(target.id), target]));
  options.forEach((option) => {
    if (!grouped.has(Number(option.campaign_question_id))) grouped.set(Number(option.campaign_question_id), []);
    grouped.get(Number(option.campaign_question_id)).push(option);
  });
  return rows.map((row) => {
    const target = questionTargetsById.get(Number(row.next_question_id));
    return {
      ...row,
      next_question_public_id: target?.public_id || null,
      next_question_position: target?.position || null,
      next_question_title: target?.title || null,
      options: grouped.get(Number(row.id)) || [],
    };
  });
}

async function getQuestion(database, campaignId, selector = {}, activeOnly = true) {
  const query = database('campaign_questions').where({ campaign_id: campaignId });
  if (selector.questionnaireId) query.where('questionnaire_id', selector.questionnaireId);
  if (selector.id) query.where('id', selector.id);
  if (selector.publicId) query.where('public_id', selector.publicId);
  if (selector.position) query.where('position', selector.position);
  if (selector.afterPosition !== undefined) query.where('position', '>', selector.afterPosition).orderBy('position');
  if (activeOnly) query.where('is_active', true);
  const row = await query.first();
  if (!row) return null;
  return (await hydrateQuestions(database, [row]))[0];
}

async function getCurrentQuestionnaire(database, campaignId) {
  return database('campaign_questionnaires')
    .where({ campaign_id: campaignId, is_current: true })
    .orderBy('version', 'desc').first();
}

async function getCurrentQuestion(database, campaignId, selector = {}) {
  const questionnaire = await getCurrentQuestionnaire(database, campaignId);
  if (!questionnaire) return null;
  return getQuestion(database, campaignId, { ...selector, questionnaireId: questionnaire.id });
}

module.exports = {
  formatInvalidAnswerMessage,
  formatQuestionMessage,
  getCurrentQuestion,
  getCurrentQuestionnaire,
  getQuestion,
  hydrateQuestions,
  matchQuestionOption,
  normalizeAnswer,
  QUESTION_VARIABLES,
  renderQuestionVariables,
  resolveQuestionRoute,
};
