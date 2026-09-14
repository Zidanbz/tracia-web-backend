const crypto = require('crypto');

const TRACER_STUDY_QUESTIONS = Object.freeze([
  {
    position: 1,
    title: 'Konfirmasi Identitas Alumni',
    questionText: 'Apakah data berikut sudah sesuai dengan identitas Anda?\n\nNama: {{nama}}\nNIM/Stambuk: {{nim}}\nTahun Masuk: {{tahun_masuk}}\nFakultas: {{fakultas}}\nJurusan: {{jurusan}}\n\nSilakan konfirmasi kebenaran data tersebut.',
    options: [
      { text: 'Ya', action: 'next' },
      { text: 'Tidak', action: 'review' },
    ],
  },
  {
    position: 2,
    title: 'Aktivitas Utama Saat Ini',
    questionText: 'Apa aktivitas utama Anda saat ini?',
    options: [
      { text: 'Bekerja', action: 'goto', targetPosition: 3 },
      { text: 'Wirausaha', action: 'goto', targetPosition: 7 },
      { text: 'Melanjutkan pendidikan', action: 'goto', targetPosition: 9 },
      { text: 'Belum bekerja dan sedang mencari pekerjaan', action: 'goto', targetPosition: 10 },
      { text: 'Belum bekerja dan tidak sedang mencari pekerjaan', action: 'goto', targetPosition: 10 },
    ],
  },
  {
    position: 3,
    title: 'Waktu Memperoleh Pekerjaan',
    questionText: 'Berapa lama waktu yang Anda perlukan untuk memperoleh pekerjaan pertama?',
    options: [
      { text: 'Sudah bekerja sebelum lulus', action: 'next' },
      { text: 'Kurang dari 3 bulan', action: 'next' },
      { text: '3–6 bulan', action: 'next' },
      { text: '7–12 bulan', action: 'next' },
      { text: 'Lebih dari 12 bulan', action: 'next' },
    ],
  },
  {
    position: 4,
    title: 'Jenis Instansi Tempat Bekerja',
    questionText: 'Apa jenis instansi tempat Anda bekerja saat ini?',
    options: [
      { text: 'Instansi pemerintah', action: 'next' },
      { text: 'BUMN atau BUMD', action: 'next' },
      { text: 'Perusahaan swasta', action: 'next' },
      { text: 'Organisasi nirlaba', action: 'next' },
      { text: 'Lembaga internasional', action: 'next' },
      { text: 'Lainnya', action: 'next' },
    ],
  },
  {
    position: 5,
    title: 'Kesesuaian Bidang Pekerjaan',
    questionText: 'Seberapa sesuai pekerjaan Anda dengan bidang studi saat kuliah?',
    options: [
      { text: 'Sangat sesuai', action: 'next' },
      { text: 'Sesuai', action: 'next' },
      { text: 'Cukup sesuai', action: 'next' },
      { text: 'Kurang sesuai', action: 'next' },
      { text: 'Tidak sesuai', action: 'next' },
    ],
  },
  {
    position: 6,
    title: 'Pendapatan Bulanan',
    questionText: 'Berapa kisaran pendapatan Anda per bulan?',
    options: [
      { text: 'Kurang dari Rp3.000.000', action: 'goto', targetPosition: 11 },
      { text: 'Rp3.000.000–Rp5.000.000', action: 'goto', targetPosition: 11 },
      { text: 'Rp5.000.001–Rp10.000.000', action: 'goto', targetPosition: 11 },
      { text: 'Lebih dari Rp10.000.000', action: 'goto', targetPosition: 11 },
      { text: 'Memilih tidak menjawab', action: 'goto', targetPosition: 11 },
    ],
  },
  {
    position: 7,
    title: 'Bidang Usaha',
    questionText: 'Apa bidang utama usaha yang sedang Anda jalankan?',
    options: [
      { text: 'Teknologi informasi', action: 'next' },
      { text: 'Perdagangan', action: 'next' },
      { text: 'Jasa', action: 'next' },
      { text: 'Industri atau manufaktur', action: 'next' },
      { text: 'Pertanian atau perikanan', action: 'next' },
      { text: 'Industri kreatif', action: 'next' },
      { text: 'Lainnya', action: 'next' },
    ],
  },
  {
    position: 8,
    title: 'Waktu Memulai Usaha',
    questionText: 'Kapan Anda mulai menjalankan usaha tersebut?',
    options: [
      { text: 'Sebelum lulus', action: 'goto', targetPosition: 11 },
      { text: 'Kurang dari 6 bulan setelah lulus', action: 'goto', targetPosition: 11 },
      { text: '6–12 bulan setelah lulus', action: 'goto', targetPosition: 11 },
      { text: 'Lebih dari 12 bulan setelah lulus', action: 'goto', targetPosition: 11 },
    ],
  },
  {
    position: 9,
    title: 'Pendidikan Lanjutan',
    questionText: 'Jenjang pendidikan apa yang sedang Anda tempuh?',
    options: [
      { text: 'Profesi', action: 'goto', targetPosition: 11 },
      { text: 'Sarjana', action: 'goto', targetPosition: 11 },
      { text: 'Magister', action: 'goto', targetPosition: 11 },
      { text: 'Doktor', action: 'goto', targetPosition: 11 },
      { text: 'Pendidikan lainnya', action: 'goto', targetPosition: 11 },
    ],
  },
  {
    position: 10,
    title: 'Kendala Memperoleh Pekerjaan',
    questionText: 'Apa kendala utama yang Anda alami dalam memperoleh pekerjaan?',
    options: [
      { text: 'Lowongan yang sesuai masih terbatas', action: 'goto', targetPosition: 11 },
      { text: 'Kurang pengalaman kerja', action: 'goto', targetPosition: 11 },
      { text: 'Perlu meningkatkan keterampilan', action: 'goto', targetPosition: 11 },
      { text: 'Lokasi pekerjaan tidak sesuai', action: 'goto', targetPosition: 11 },
      { text: 'Kendala pribadi atau keluarga', action: 'goto', targetPosition: 11 },
      { text: 'Belum berencana mencari pekerjaan', action: 'goto', targetPosition: 11 },
      { text: 'Lainnya', action: 'goto', targetPosition: 11 },
    ],
  },
  {
    position: 11,
    title: 'Dukungan yang Dibutuhkan',
    questionText: 'Dukungan apa yang paling Anda butuhkan dari kampus setelah lulus?',
    options: [
      { text: 'Informasi lowongan kerja', action: 'next' },
      { text: 'Pelatihan keterampilan', action: 'next' },
      { text: 'Sertifikasi profesi', action: 'next' },
      { text: 'Jejaring alumni dan industri', action: 'next' },
      { text: 'Pendampingan usaha', action: 'next' },
      { text: 'Tidak membutuhkan dukungan saat ini', action: 'next' },
    ],
  },
  {
    position: 12,
    title: 'Saran untuk Kampus',
    questionText: 'Silakan tuliskan saran atau masukan Anda untuk pengembangan pendidikan dan layanan alumni di kampus.',
    answerType: 'free_text',
    options: [],
  },
]);

const FIKOM_2025_REVISED_QUESTIONS = Object.freeze([
  {
    position: 1,
    title: 'Nama Alumni',
    questionText: 'Halo, Kak 👋 Untuk memulai, boleh tuliskan nama lengkap Kakak beserta gelar?',
    answerType: 'free_text',
    options: [],
  },
  {
    position: 2,
    title: 'Program Studi',
    questionText: 'Terima kasih, Kak. Selanjutnya, program studi Kakak yang mana ya?',
    options: [
      { text: 'Teknik Informatika', action: 'next' },
      { text: 'Sistem Informasi', action: 'next' },
    ],
  },
  {
    position: 3,
    title: 'Email',
    questionText: 'Supaya kami tetap bisa terhubung, boleh tuliskan alamat email aktif Kakak?',
    answerType: 'free_text',
    options: [],
  },
  {
    position: 4,
    title: 'Nomor HP/WhatsApp',
    questionText: 'Boleh tuliskan nomor HP atau WhatsApp aktif yang paling mudah dihubungi?',
    answerType: 'free_text',
    options: [],
  },
  {
    position: 5,
    title: 'Tahun Masuk',
    questionText: 'Sedikit lagi untuk data awal ya, Kak 😊 Tahun berapa Kakak mulai kuliah? Contohnya: 2021.',
    answerType: 'free_text',
    options: [],
  },
  {
    position: 6,
    title: 'Tanggal Lulus',
    questionText: 'Terima kasih, Kak. Kita lanjut pelan-pelan ya 😊 Kapan Kakak dinyatakan lulus atau mengikuti yudisium? Silakan tulis dengan format DD/MM/YYYY, contohnya 25/08/2025. Jika belum ingat tanggalnya, balas SKIP untuk melewati pertanyaan ini.',
    answerType: 'free_text',
    options: [],
  },
  {
    position: 7,
    title: 'Aktivitas Saat Ini',
    questionText: 'Baik, terima kasih 😊 Sekarang kami ingin mengetahui kesibukan Kakak. Manakah yang paling sesuai dengan aktivitas utama Kakak saat ini?',
    options: [
      { text: 'Bekerja', action: 'goto', targetPosition: 8 },
      { text: 'Belum Bekerja', action: 'goto', targetPosition: 23 },
      { text: 'Studi Lanjut', action: 'goto', targetPosition: 19 },
      { text: 'Magang', action: 'goto', targetPosition: 21 },
    ],
  },
  {
    position: 8,
    title: 'Tanggal Mulai Bekerja',
    questionText: 'Semoga pekerjaannya berjalan lancar ya, Kak 🙌 Kapan Kakak mulai bekerja? Silakan tulis dengan format DD/MM/YYYY, contohnya 01/06/2025.',
    answerType: 'free_text',
    options: [],
  },
  {
    position: 9,
    title: 'Masa Tunggu Mendapatkan Pekerjaan',
    questionText: 'Setiap alumni punya perjalanan yang berbeda. Kira-kira berapa lama waktu yang Kakak perlukan untuk mendapatkan pekerjaan setelah lulus?',
    options: [
      { text: 'Kurang dari 3 bulan', action: 'next' },
      { text: '3–6 bulan', action: 'next' },
      { text: '6–12 bulan', action: 'next' },
      { text: 'Lebih dari 12 bulan', action: 'next' },
    ],
  },
  {
    position: 10,
    title: 'Cakupan Perusahaan',
    questionText: 'Selanjutnya, boleh kami tahu cakupan perusahaan atau instansi tempat Kakak bekerja saat ini?',
    options: [
      { text: 'Multinasional/Internasional', action: 'next' },
      { text: 'Nasional', action: 'next' },
      { text: 'Lokal', action: 'next' },
    ],
  },
  {
    position: 11,
    title: 'Nama Perusahaan/Instansi',
    questionText: 'Baik, Kak. Boleh tuliskan nama perusahaan atau instansi tempat Kakak bekerja?',
    answerType: 'free_text',
    options: [],
  },
  {
    position: 12,
    title: 'Bidang Perusahaan/Instansi',
    questionText: 'Untuk membantu kami memahami keterkaitan dunia kerja dengan bidang studi, perusahaan atau instansi Kakak bergerak di bidang Infokom atau Non Infokom?',
    options: [
      { text: 'Infokom', action: 'next' },
      { text: 'Non Infokom', action: 'next' },
    ],
  },
  {
    position: 13,
    title: 'Kesesuaian Pekerjaan dengan Program Studi',
    questionText: 'Kalau dibandingkan dengan ilmu yang dipelajari saat kuliah, seberapa erat pekerjaan Kakak saat ini dengan program studi yang ditempuh?',
    options: [
      { text: 'Tidak sama sekali', action: 'next' },
      { text: 'Kurang erat', action: 'next' },
      { text: 'Erat', action: 'next' },
      { text: 'Sangat erat', action: 'next' },
    ],
  },
  {
    position: 14,
    title: 'Pendapatan Per Bulan',
    questionText: 'Kami memahami pertanyaan ini cukup pribadi, Kak. Untuk kebutuhan evaluasi, boleh pilih kisaran pendapatan per bulan yang paling mendekati kondisi Kakak saat ini?',
    options: [
      { text: 'Kurang dari Rp2.000.000', action: 'next' },
      { text: 'Rp2.000.000–Rp4.000.000', action: 'next' },
      { text: 'Rp4.000.001–Rp6.000.000', action: 'next' },
      { text: 'Lebih dari Rp6.000.000', action: 'next' },
      { text: 'Belum berpenghasilan', action: 'next' },
    ],
  },
  {
    position: 15,
    title: 'Pentingnya Kontribusi Alumni',
    questionText: 'Menurut Kakak, seberapa penting kontribusi alumni bagi pengembangan Fakultas atau Program Studi? Silakan pilih skala 1–5, dengan 1 berarti tidak penting dan 5 berarti sangat penting.',
    options: [
      { text: '1', action: 'next' },
      { text: '2', action: 'next' },
      { text: '3', action: 'next' },
      { text: '4', action: 'next' },
      { text: '5', action: 'next' },
    ],
  },
  {
    position: 16,
    title: 'Kesediaan Memberikan Saran',
    questionText: 'Pengalaman alumni sangat berarti bagi kami. Ke depannya, apakah Kakak bersedia memberikan saran atau masukan untuk pengembangan Fakultas dan Program Studi?',
    options: [
      { text: 'Ya', action: 'next' },
      { text: 'Tidak', action: 'next' },
    ],
  },
  {
    position: 17,
    title: 'Nama Atasan Langsung',
    questionText: 'Jika berkenan, boleh tuliskan nama atasan langsung Kakak di tempat kerja? Jika tidak berkenan membagikannya, cukup balas dengan tanda -.',
    answerType: 'free_text',
    options: [],
  },
  {
    position: 18,
    title: 'Jabatan Atasan Langsung',
    questionText: 'Terima kasih, Kak. Apa jabatan atasan langsung tersebut? Jika tidak berkenan membagikannya, cukup balas dengan tanda -.',
    answerType: 'free_text',
    nextPosition: 23,
    options: [],
  },
  {
    position: 19,
    title: 'Nama Perguruan Tinggi Studi Lanjut',
    questionText: 'Wah, semangat untuk studi lanjutnya ya, Kak 📚 Boleh tuliskan nama perguruan tinggi tempat Kakak melanjutkan studi?',
    answerType: 'free_text',
    options: [],
  },
  {
    position: 20,
    title: 'Nama Program Studi Lanjut',
    questionText: 'Program studi apa yang sedang Kakak tempuh di perguruan tinggi tersebut?',
    answerType: 'free_text',
    nextPosition: 23,
    options: [],
  },
  {
    position: 21,
    title: 'Nama Perusahaan/Instansi Magang',
    questionText: 'Semoga kegiatan magangnya lancar ya, Kak 🙌 Boleh tuliskan nama perusahaan atau instansi tempat Kakak magang?',
    answerType: 'free_text',
    options: [],
  },
  {
    position: 22,
    title: 'Nama Program Magang',
    questionText: 'Baik, Kak. Apa nama program magang yang sedang Kakak ikuti?',
    answerType: 'free_text',
    nextPosition: 23,
    options: [],
  },
  {
    position: 23,
    title: 'Saran untuk Program Studi',
    questionText: 'Terima kasih sudah berbagi cerita sampai sejauh ini, Kak 😊 Sebelum kita akhiri, adakah saran atau masukan untuk membantu Fakultas dan Program Studi menjadi lebih baik? Jika belum ada, cukup balas dengan tanda -.',
    answerType: 'free_text',
    options: [],
  },
]);

function remapRevisedPosition(position) {
  return Number(position) >= 6 ? Number(position) - 4 : Number(position);
}

const FIKOM_2025_IMPORT_CONFIRMATION_QUESTIONS = Object.freeze([
  {
    position: 1,
    title: 'Konfirmasi Data Alumni',
    questionText: 'Terima kasih sudah bersedia meluangkan waktu, Kak 😊\n\nSebelum lanjut, boleh bantu periksa apakah data berikut sudah sesuai?\n\nNama: {{nama}}\nProgram Studi: {{jurusan}}\nEmail: {{email_masked}}\nNo. HP/WhatsApp: {{nomor_masked}}\nTahun Masuk: {{tahun_masuk}}\n\nJika semuanya sudah sesuai, pilih Betul. Jika ada yang keliru, pilih Tidak ya—tim kami akan membantu memperbaikinya.',
    options: [
      { text: 'Betul', action: 'next' },
      { text: 'Tidak', action: 'review' },
    ],
  },
  ...FIKOM_2025_REVISED_QUESTIONS.filter((definition) => definition.position >= 6).map((definition) => ({
    ...definition,
    position: remapRevisedPosition(definition.position),
    nextPosition: definition.nextPosition ? remapRevisedPosition(definition.nextPosition) : undefined,
    options: definition.options.map((option) => ({
      ...option,
      targetPosition: option.targetPosition ? remapRevisedPosition(option.targetPosition) : undefined,
    })),
  })),
]);

function validateQuestionnaireDefinitions(definitions) {
  const positions = new Set(definitions.map((definition) => Number(definition.position)));
  if (!definitions.length || positions.size !== definitions.length) {
    throw new Error('Definisi questionnaire harus memiliki posisi yang unik');
  }
  for (const definition of definitions) {
    const targets = [definition.nextPosition, ...(definition.options || []).map((option) => option.targetPosition)]
      .filter(Boolean).map(Number);
    if (targets.some((target) => !positions.has(target) || target <= Number(definition.position))) {
      throw new Error(`Definisi routing pertanyaan posisi ${definition.position} tidak valid`);
    }
  }
}

async function createQuestionnaireFromDefinitions(database, campaignId, definitions, options = {}) {
  validateQuestionnaireDefinitions(definitions);
  const current = options.makeCurrent !== false;
  const [{ version }] = await database('campaign_questionnaires')
    .where({ campaign_id: campaignId }).max({ version: 'version' });
  const nextVersion = Number(version || 0) + 1;
  if (current) {
    await database('campaign_questionnaires').where({ campaign_id: campaignId, is_current: true })
      .update({ is_current: false, updated_at: database.fn.now(3) });
  }
  const [questionnaireId] = await database('campaign_questionnaires').insert({
    public_id: crypto.randomUUID(),
    campaign_id: campaignId,
    version: nextVersion,
    name: options.name || 'Tracer Study Alumni',
    is_current: current,
  });
  const questionIds = new Map();
  for (const definition of definitions) {
    const [questionId] = await database('campaign_questions').insert({
      public_id: crypto.randomUUID(),
      campaign_id: campaignId,
      questionnaire_id: questionnaireId,
      position: definition.position,
      title: definition.title,
      question_text: definition.questionText,
      answer_type: definition.answerType || 'choice',
      is_active: true,
    });
    questionIds.set(definition.position, questionId);
  }
  for (const definition of definitions) {
    if (definition.nextPosition) {
      await database('campaign_questions').where({ id: questionIds.get(definition.position) }).update({
        next_question_id: questionIds.get(definition.nextPosition),
      });
    }
    if (!definition.options.length) continue;
    await database('campaign_question_options').insert(definition.options.map((option, index) => ({
      public_id: crypto.randomUUID(),
      campaign_question_id: questionIds.get(definition.position),
      position: index + 1,
      answer_text: option.text,
      action_type: option.action || 'next',
      next_question_id: option.targetPosition ? questionIds.get(option.targetPosition) : null,
      is_active: true,
    })));
  }
  return database('campaign_questionnaires').where({ id: questionnaireId }).first();
}

async function createTracerStudyQuestionnaire(database, campaignId, options = {}) {
  return createQuestionnaireFromDefinitions(database, campaignId, TRACER_STUDY_QUESTIONS, options);
}

async function createFikom2025RevisedQuestionnaire(database, campaignId, options = {}) {
  return createQuestionnaireFromDefinitions(database, campaignId, FIKOM_2025_REVISED_QUESTIONS, {
    name: 'Tracer Study FIKOM 2025 — Revisi',
    ...options,
  });
}

async function createFikom2025ImportConfirmationQuestionnaire(database, campaignId, options = {}) {
  return createQuestionnaireFromDefinitions(database, campaignId, FIKOM_2025_IMPORT_CONFIRMATION_QUESTIONS, {
    name: 'Tracer Study FIKOM 2025 — Konfirmasi Data Import',
    ...options,
  });
}

module.exports = {
  FIKOM_2025_IMPORT_CONFIRMATION_QUESTIONS,
  FIKOM_2025_REVISED_QUESTIONS,
  TRACER_STUDY_QUESTIONS,
  createFikom2025ImportConfirmationQuestionnaire,
  createFikom2025RevisedQuestionnaire,
  createQuestionnaireFromDefinitions,
  createTracerStudyQuestionnaire,
  validateQuestionnaireDefinitions,
};
