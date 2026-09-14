const OLD_FINAL_TITLE = 'Pesan Penutup & Terima Kasih (Sesi 10)';
const OLD_FINAL_TEXT = 'Terima kasih banyak atas waktu dan partisipasi Anda dalam mengisi seluruh Sesi Tanya Jawab Tracer Study Alumni! Seluruh jawaban Anda telah kami terima dengan baik.';
const FINAL_QUESTION_TITLE = 'Pertanyaan Sesi 10';
const FINAL_QUESTION_TEXT = 'Halo, ini adalah pesan pertanyaan untuk Sesi 10. Silakan berikan balasan Anda.';

exports.up = async function up(knex) {
  // Hanya ubah seed bawaan lama. Konten Sesi 10 yang sudah dikustomisasi admin tidak disentuh.
  await knex('qa_session_questions')
    .where({ session_number: 10, title: OLD_FINAL_TITLE, question_text: OLD_FINAL_TEXT })
    .update({
      title: FINAL_QUESTION_TITLE,
      question_text: FINAL_QUESTION_TEXT,
      updated_at: knex.fn.now(3),
    });
};

exports.down = async function down(knex) {
  await knex('qa_session_questions')
    .where({ session_number: 10, title: FINAL_QUESTION_TITLE, question_text: FINAL_QUESTION_TEXT })
    .update({
      title: OLD_FINAL_TITLE,
      question_text: OLD_FINAL_TEXT,
      updated_at: knex.fn.now(3),
    });
};
