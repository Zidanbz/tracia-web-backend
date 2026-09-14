const service = require('./qa-session.service');
const asyncHandler = require('../../shared/async-handler');

const listQuestions = asyncHandler(async (req, res) => {
  const questions = await service.listQuestions();
  return res.json({
    status: 'success',
    data: questions,
  });
});

const getQuestion = asyncHandler(async (req, res) => {
  const { sessionNumber } = req.params;
  const question = await service.getQuestion(sessionNumber);
  return res.json({
    status: 'success',
    data: question,
  });
});

const updateQuestion = asyncHandler(async (req, res) => {
  const { sessionNumber } = req.params;
  const { title, question_text, is_active } = req.body;

  const updated = await service.updateQuestion(req, sessionNumber, {
    title,
    questionText: question_text,
    isActive: is_active,
  });

  return res.json({
    status: 'success',
    message: `Pertanyaan Sesi ${sessionNumber} berhasil diperbarui`,
    data: updated,
  });
});

module.exports = {
  listQuestions,
  getQuestion,
  updateQuestion,
};
