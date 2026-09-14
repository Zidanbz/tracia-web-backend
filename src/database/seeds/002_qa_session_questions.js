exports.seed = async function seed(knex) {
  const now = new Date();
  const defaultSessions = [];

  for (let i = 1; i <= 10; i++) {
    defaultSessions.push({
      session_number: i,
      title: `Pertanyaan Sesi ${i}`,
      question_text: `Halo, ini adalah pesan pertanyaan untuk Sesi ${i}. Silakan berikan balasan Anda.`,
      is_active: true,
      created_at: now,
      updated_at: now,
    });
  }

  for (const session of defaultSessions) {
    const existing = await knex('qa_session_questions')
      .where('session_number', session.session_number)
      .first();

    if (!existing) {
      await knex('qa_session_questions').insert(session);
    }
  }
};
