const knex = require('../../database/knex');

async function listSessionQuestions() {
  return knex('qa_session_questions')
    .select('id', 'session_number', 'title', 'question_text', 'is_active', 'created_at', 'updated_at')
    .orderBy('session_number', 'asc');
}

async function getQuestionBySession(sessionNumber) {
  const num = parseInt(sessionNumber, 10);
  return knex('qa_session_questions')
    .select('id', 'session_number', 'title', 'question_text', 'is_active', 'created_at', 'updated_at')
    .where('session_number', num)
    .first();
}

async function updateSessionQuestion(sessionNumber, { title, questionText, isActive }) {
  const num = parseInt(sessionNumber, 10);
  const now = new Date();

  const updateData = { updated_at: now };
  if (title !== undefined) updateData.title = title;
  if (questionText !== undefined) updateData.question_text = questionText;
  if (isActive !== undefined) updateData.is_active = Boolean(isActive);

  const existing = await getQuestionBySession(num);

  if (!existing) {
    await knex('qa_session_questions').insert({
      session_number: num,
      title: title || `Pertanyaan Sesi ${num}`,
      question_text: questionText || '',
      is_active: isActive !== undefined ? Boolean(isActive) : true,
      created_at: now,
      updated_at: now,
    });
  } else {
    await knex('qa_session_questions')
      .where('session_number', num)
      .update(updateData);
  }

  return getQuestionBySession(num);
}

module.exports = {
  listSessionQuestions,
  getQuestionBySession,
  updateSessionQuestion,
};
