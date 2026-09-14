const repository = require('./qa-session.repository');
const { writeRequestAudit } = require('../audit/audit.repository');
const logger = require('../../config/logger');

async function listQuestions() {
  return repository.listSessionQuestions();
}

async function getQuestion(sessionNumber) {
  const num = parseInt(sessionNumber, 10);
  if (isNaN(num) || num < 1 || num > 10) {
    const error = new Error('Nomor sesi tidak valid (harus 1 - 10)');
    error.status = 400;
    throw error;
  }
  const question = await repository.getQuestionBySession(num);
  if (!question) {
    const error = new Error(`Pertanyaan untuk Sesi ${num} tidak ditemukan`);
    error.status = 404;
    throw error;
  }
  return question;
}

async function updateQuestion(req, sessionNumber, data) {
  const num = parseInt(sessionNumber, 10);
  if (isNaN(num) || num < 1 || num > 10) {
    const error = new Error('Nomor sesi tidak valid (harus 1 - 10)');
    error.status = 400;
    throw error;
  }

  const updated = await repository.updateSessionQuestion(num, data);

  if (req) {
    await writeRequestAudit(req, {
      action: 'qa_session.update',
      entityType: 'qa_session_question',
      entityId: String(num),
      afterData: updated,
    }).catch((err) => logger.warn({ err }, 'Audit write failed for updateQuestion'));
  }

  return updated;
}

module.exports = {
  listQuestions,
  getQuestion,
  updateQuestion,
};
