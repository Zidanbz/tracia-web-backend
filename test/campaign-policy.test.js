const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_STORE = 'memory';

const {
  canAccessCampaign,
  canHardDeleteCampaign,
  canTransitionCampaign,
  parseReviewCorrection,
  reviewCorrectionChangedFields,
  validateCampaignDeleteConfirmation,
} = require('../src/modules/campaigns/campaigns.service');
const {
  buildReviewReconfirmationPlan,
  calculateCampaignMessageAvailability,
  isCampaignCompletionThankYou,
  isCampaignReviewAcknowledgement,
  isCampaignReviewDetailRequest,
  isReblastConfirmationMessage,
  isCampaignStartCommand,
  isUnquotedCampaignProgressEligible,
  nextReblastConfirmationState,
  selectLatestReblastCampaignCandidate,
  selectLatestOutboundCampaignCandidate,
  selectReviewDetailCampaignCandidate,
  selectStartCampaignCandidate,
  selectUnquotedCampaignCandidate,
} = require('../src/modules/campaigns/campaign-attribution');
const {
  REVIEW_DETAIL_PROMPT,
  buildReviewDetailReply,
  formatReviewAcknowledgement,
  parseReviewFieldSelection,
  parseStoredReviewFields,
} = require('../src/modules/campaigns/campaign-review-fields');
const {
  formatQuestionMessage,
  matchQuestionOption,
  normalizeAnswer,
  renderQuestionVariables,
  resolveQuestionRoute,
} = require('../src/modules/campaigns/campaign-questions');
const {
  FIKOM_2025_IMPORT_CONFIRMATION_QUESTIONS,
  FIKOM_2025_REVISED_QUESTIONS,
  TRACER_STUDY_QUESTIONS,
  validateQuestionnaireDefinitions,
} = require('../src/modules/campaigns/tracer-questionnaire');
const {
  REBLAST_CONFIRMATION_PROMPT,
  parseReblastConfirmation,
  parseReblastTarget,
  withReblastConfirmationPrompt,
} = require('../src/modules/campaigns/campaign-reblast');

test('operator hanya dapat mengakses campaign yang ditugaskan', () => {
  const campaign = { operator_user_id: 7 };
  assert.equal(canAccessCampaign(campaign, { id: 7, roles: ['operator'], permissions: ['campaigns.view'] }), true);
  assert.equal(canAccessCampaign(campaign, { id: 8, roles: ['operator'], permissions: ['campaigns.view'] }), false);
  assert.equal(canAccessCampaign(campaign, { id: 8, roles: ['super_admin'], permissions: [] }), true);
});

test('state machine campaign menolak transisi yang melompati lifecycle', () => {
  assert.equal(canTransitionCampaign('draft', 'active'), true);
  assert.equal(canTransitionCampaign('active', 'paused'), true);
  assert.equal(canTransitionCampaign('paused', 'active'), true);
  assert.equal(canTransitionCampaign('completed', 'active'), false);
  assert.equal(canTransitionCampaign('archived', 'restore'), true);
  assert.equal(canTransitionCampaign('draft', 'completed'), false);
});

test('hard delete Campaign hanya diizinkan ketika belum ada aktivitas bisnis', () => {
  assert.equal(canHardDeleteCampaign(0), true);
  assert.equal(canHardDeleteCampaign('0'), true);
  assert.equal(canHardDeleteCampaign(1), false);
  assert.equal(canHardDeleteCampaign(12), false);
});

test('hard delete Campaign mewajibkan konfirmasi eksplisit yang eksak', () => {
  assert.deepEqual(validateCampaignDeleteConfirmation({ confirmation: 'HAPUS' }), { confirmation: 'HAPUS' });
  assert.throws(() => validateCampaignDeleteConfirmation({}), /confirmation/);
  assert.throws(() => validateCampaignDeleteConfirmation({ confirmation: 'hapus' }), /confirmation/);
  assert.throws(
    () => validateCampaignDeleteConfirmation({ confirmation: 'HAPUS', bypass: true }),
    /Unrecognized key/,
  );
});

test('koreksi data review menormalisasi identitas dan menolak input tidak valid', () => {
  assert.deepEqual(parseReviewCorrection({
    name: '  Alumni Uji  ',
    phone: '0812-3456-7890',
    email: ' Alumni.Uji@Example.COM ',
    entry_year: '2022',
    study_program_group_id: '10',
  }), {
    name: 'Alumni Uji',
    phone_e164: '6281234567890',
    email: 'alumni.uji@example.com',
    entry_year: 2022,
    study_program_group_id: 10,
  });
  assert.throws(() => parseReviewCorrection({
    name: 'Alumni Uji', phone: '081234567890', email: 'invalid',
    entry_year: '2022', study_program_group_id: 10,
  }), /Format email tidak valid/);
});

test('koreksi review menghitung hanya field yang benar-benar berubah', () => {
  assert.deepEqual(reviewCorrectionChangedFields({
    name: 'Alumni Uji', phone_e164: '6281234567890', email: 'lama@example.com',
    entry_year: 2022, study_program_group_id: 10,
  }, {
    name: 'Alumni Uji', phone_e164: '6281234567890', email: 'baru@example.com',
    entry_year: 2022, study_program_group_id: 11,
  }), ['email', 'study_program']);
});

test('koreksi review mengirim ulang konfirmasi yang sama dengan data terbaru', () => {
  const plan = buildReviewReconfirmationPlan({
    id: 16,
    last_incoming_message_id: 240,
  }, {
    id: 139,
    position: 1,
    answer_type: 'choice',
    question_text: 'Nama: {{nama}}\nEmail: {{email_masked}}',
    options: [
      { answer_text: 'Betul', is_active: true },
      { answer_text: 'Tidak', is_active: true },
    ],
  }, {
    nama: 'Data Terbaru',
    email_masked: 'b***u@example.com',
  });

  assert.equal(plan.progress_update.status, 'in_progress');
  assert.equal(plan.progress_update.current_question_id, 139);
  assert.equal(plan.progress_update.current_session_number, 1);
  assert.equal(plan.progress_update.review_fields, null);
  assert.equal(plan.idempotency_key, 'campaign-review:16:reconfirm:240:139');
  assert.match(plan.body, /Nama: Data Terbaru/);
  assert.match(plan.body, /1\. Betul/);
  assert.doesNotMatch(plan.body, /Tanggal Lulus/);
});

test('detail koreksi menerima satu, beberapa, atau semua field secara ketat', () => {
  assert.deepEqual(parseReviewFieldSelection('1'), { valid: true, fields: ['name'], all: false });
  assert.deepEqual(parseReviewFieldSelection('1, 3 dan 5'), {
    valid: true, fields: ['name', 'email', 'entry_year'], all: false,
  });
  assert.deepEqual(parseReviewFieldSelection('nama dan email'), {
    valid: true, fields: ['name', 'email'], all: false,
  });
  assert.deepEqual(parseReviewFieldSelection('SEMUA'), {
    valid: true,
    fields: ['name', 'study_program', 'email', 'phone', 'entry_year'],
    all: true,
  });
  assert.equal(parseReviewFieldSelection('semuanya tidak sesuai').all, true);
  assert.deepEqual(parseReviewFieldSelection('no. hp/WhatsApp').fields, ['phone']);
  assert.equal(parseReviewFieldSelection('1,9').valid, false);
  assert.equal(parseReviewFieldSelection('kayaknya ada yang salah').valid, false);
  assert.deepEqual(parseStoredReviewFields('["email","name","invalid"]'), ['email', 'name']);
  assert.match(REVIEW_DETAIL_PROMPT, /satu atau beberapa nomor/);
  assert.match(formatReviewAcknowledgement(['email', 'name']), /Nama, Email/);
  assert.deepEqual(buildReviewDetailReply('2,4').progress_update, {
    status: 'needs_review',
    review_fields: '["study_program","phone"]',
  });
  assert.deepEqual(buildReviewDetailReply('tidak tahu').progress_update, {});
});

test('pesan penyelesaian Campaign dikenali secara idempoten tanpa bergantung nomor sesi tetap', () => {
  assert.equal(isCampaignCompletionThankYou({
    source: 'campaign', idempotency_key: 'campaign-reply:123:thank_you',
  }), true);
  assert.equal(isCampaignCompletionThankYou({
    source: 'campaign', idempotency_key: 'campaign-reply:123:question',
  }), false);
  assert.equal(isCampaignCompletionThankYou({
    source: 'broadcast', idempotency_key: 'campaign-reply:123:thank_you',
  }), false);
});

test('auto-reply Campaign dijadwalkan setelah jeda yang dikonfigurasi', () => {
  const now = Date.parse('2026-09-03T04:00:00.000Z');
  const alumniA = calculateCampaignMessageAvailability(65000, now);
  const alumniB = calculateCampaignMessageAvailability(65000, now, alumniA);
  const alumniC = calculateCampaignMessageAvailability(65000, now, alumniB);
  assert.equal(alumniA.toISOString(), '2026-09-03T04:01:05.000Z');
  assert.equal(alumniB.toISOString(), '2026-09-03T04:02:10.000Z');
  assert.equal(alumniC.toISOString(), '2026-09-03T04:03:15.000Z');
  assert.equal(
    calculateCampaignMessageAvailability(65000, now, '2026-09-03T03:59:00.000Z').toISOString(),
    '2026-09-03T04:01:05.000Z',
  );
  assert.equal(calculateCampaignMessageAvailability(0, now), null);
});

test('auto-reply Campaign memilih satu jeda acak yang tidak kurang dari 65 detik', () => {
  const now = Date.parse('2026-09-07T04:00:00.000Z');
  const choose78Seconds = (minimum, maximumExclusive) => {
    assert.equal(minimum, 65000);
    assert.equal(maximumExclusive, 120001);
    return 78000;
  };
  assert.equal(
    calculateCampaignMessageAvailability(65000, now, null, 120000, choose78Seconds).toISOString(),
    '2026-09-07T04:01:18.000Z',
  );
  assert.equal(
    calculateCampaignMessageAvailability(
      65000,
      now,
      '2026-09-07T04:02:00.000Z',
      120000,
      choose78Seconds,
    ).toISOString(),
    '2026-09-07T04:03:18.000Z',
  );
});

test('pilihan jawaban dikirim bernomor dan divalidasi secara ketat', () => {
  const question = {
    answer_type: 'choice',
    question_text: 'Apakah Anda sudah bekerja?',
    options: [
      { id: 11, answer_text: 'Sudah bekerja', is_active: true },
      { id: 12, answer_text: 'Belum bekerja', is_active: true },
    ],
  };
  assert.match(formatQuestionMessage(question), /1\. Sudah bekerja/);
  assert.match(formatQuestionMessage(question), /2\. Belum bekerja/);
  assert.equal(matchQuestionOption(question, '2').option.id, 12);
  assert.equal(matchQuestionOption(question, 'A').option.id, 11);
  assert.equal(matchQuestionOption(question, 'sudah bekerja!').option.id, 11);
  assert.equal(matchQuestionOption(question, 'mungkin').valid, false);
  assert.equal(normalizeAnswer('  Belum   bekerja. '), 'belum bekerja');
  assert.equal(matchQuestionOption({ answer_type: 'free_text' }, '').valid, false);
  assert.equal(matchQuestionOption({ answer_type: 'free_text' }, 'Saran saya').valid, true);
});

test('variable pertanyaan dirender dari profil alumni tanpa mengubah variable tidak dikenal', () => {
  assert.equal(renderQuestionVariables(
    'Nama {{nama}}, NIM {{nim}}, Tahun {{tahun_masuk}}, {{tidak_dikenal}}',
    { nama: 'Alumni', nim: '12345', tahun_masuk: 2022 },
  ), 'Nama Alumni, NIM 12345, Tahun 2022, {{tidak_dikenal}}');
  assert.equal(renderQuestionVariables('Fakultas {{fakultas}}', {}), 'Fakultas -');
});

test('jawaban teks dapat diarahkan ke pertanyaan lanjutan khusus tanpa mengalahkan routing pilihan', () => {
  assert.deepEqual(resolveQuestionRoute({ next_question_id: 23 }), { action: 'goto', targetQuestionId: 23 });
  assert.deepEqual(resolveQuestionRoute({ next_question_id: null }), { action: 'next', targetQuestionId: null });
  assert.deepEqual(resolveQuestionRoute(
    { next_question_id: 23 },
    { action_type: 'complete', next_question_id: null },
  ), { action: 'complete', targetQuestionId: null });
});

test('preset Tracer Study memiliki cabang maju, review identitas, dan pertanyaan akhir teks bebas', () => {
  assert.equal(TRACER_STUDY_QUESTIONS.length, 12);
  assert.equal(TRACER_STUDY_QUESTIONS[0].options.find((option) => option.text === 'Tidak').action, 'review');
  assert.equal(TRACER_STUDY_QUESTIONS[1].options.find((option) => option.text === 'Wirausaha').targetPosition, 7);
  assert.equal(TRACER_STUDY_QUESTIONS.at(-1).answerType, 'free_text');
  TRACER_STUDY_QUESTIONS.forEach((question) => {
    question.options.forEach((option) => {
      assert.ok(['next', 'goto', 'review', 'complete'].includes(option.action));
      if (option.action === 'goto') assert.ok(option.targetPosition > question.position);
    });
  });
  assert.equal(isCampaignReviewAcknowledgement({
    source: 'campaign', idempotency_key: 'campaign-reply:123:needs_review',
  }), true);
  assert.equal(isCampaignReviewDetailRequest({
    source: 'campaign', idempotency_key: 'campaign-review:12:details:123',
  }), true);
  assert.equal(isCampaignReviewDetailRequest({
    source: 'campaign', idempotency_key: 'campaign-review:12:details-retry:124',
  }), true);
});

test('preset FIKOM 2025 revisi mengikuti empat jalur dan bergabung kembali pada Saran', () => {
  assert.equal(FIKOM_2025_REVISED_QUESTIONS.length, 23);
  assert.doesNotThrow(() => validateQuestionnaireDefinitions(FIKOM_2025_REVISED_QUESTIONS));
  const graduationDate = FIKOM_2025_REVISED_QUESTIONS.find((question) => question.title === 'Tanggal Lulus');
  assert.match(graduationDate.questionText, /balas SKIP untuk melewati pertanyaan ini/);
  assert.equal(matchQuestionOption({ answer_type: graduationDate.answerType }, 'SKIP').valid, true);
  const activity = FIKOM_2025_REVISED_QUESTIONS.find((question) => question.position === 7);
  assert.deepEqual(activity.options.map((option) => [option.text, option.targetPosition]), [
    ['Bekerja', 8],
    ['Belum Bekerja', 23],
    ['Studi Lanjut', 19],
    ['Magang', 21],
  ]);
  assert.equal(FIKOM_2025_REVISED_QUESTIONS.find((question) => question.position === 18).nextPosition, 23);
  assert.equal(FIKOM_2025_REVISED_QUESTIONS.find((question) => question.position === 20).nextPosition, 23);
  assert.equal(FIKOM_2025_REVISED_QUESTIONS.find((question) => question.position === 22).nextPosition, 23);
  assert.equal(FIKOM_2025_REVISED_QUESTIONS.at(-1).title, 'Saran untuk Program Studi');
});

test('preset FIKOM berbasis import menggabungkan lima pertanyaan identitas menjadi satu konfirmasi', () => {
  assert.equal(FIKOM_2025_IMPORT_CONFIRMATION_QUESTIONS.length, 19);
  assert.doesNotThrow(() => validateQuestionnaireDefinitions(FIKOM_2025_IMPORT_CONFIRMATION_QUESTIONS));
  const confirmation = FIKOM_2025_IMPORT_CONFIRMATION_QUESTIONS[0];
  assert.equal(confirmation.title, 'Konfirmasi Data Alumni');
  assert.match(confirmation.questionText, /{{email_masked}}/);
  assert.match(confirmation.questionText, /{{nomor_masked}}/);
  assert.deepEqual(confirmation.options.map((option) => [option.text, option.action]), [
    ['Betul', 'next'],
    ['Tidak', 'review'],
  ]);
  assert.equal(FIKOM_2025_IMPORT_CONFIRMATION_QUESTIONS[1].title, 'Tanggal Lulus');
  assert.equal(FIKOM_2025_IMPORT_CONFIRMATION_QUESTIONS.at(-1).position, 19);
  assert.match(confirmation.questionText, /Terima kasih sudah bersedia/);
  assert.match(FIKOM_2025_IMPORT_CONFIRMATION_QUESTIONS[1].questionText, /Kita lanjut pelan-pelan/);
  assert.match(FIKOM_2025_IMPORT_CONFIRMATION_QUESTIONS[1].questionText, /balas SKIP untuk melewati pertanyaan ini/);
  assert.match(FIKOM_2025_IMPORT_CONFIRMATION_QUESTIONS.at(-1).questionText, /Terima kasih sudah berbagi cerita/);
  assert.equal(FIKOM_2025_IMPORT_CONFIRMATION_QUESTIONS[10].title, 'Pentingnya Kontribusi Alumni');
});

test('balasan tanpa quote hanya diatribusikan jika kandidat Campaign tepat satu', () => {
  const onlyCampaign = { campaign_id: 10, status: 'active' };
  assert.deepEqual(selectUnquotedCampaignCandidate([onlyCampaign]), onlyCampaign);
  assert.equal(selectUnquotedCampaignCandidate([]), null);
  assert.equal(selectUnquotedCampaignCandidate([onlyCampaign, { campaign_id: 11, status: 'paused' }]), null);
});

test('balasan tanpa quote mengabaikan Campaign dengan progres kontak terminal', () => {
  assert.equal(isUnquotedCampaignProgressEligible(undefined), true);
  assert.equal(isUnquotedCampaignProgressEligible('not_started'), true);
  assert.equal(isUnquotedCampaignProgressEligible('in_progress'), true);
  assert.equal(isUnquotedCampaignProgressEligible('completed'), false);
  assert.equal(isUnquotedCampaignProgressEligible('stopped'), false);
  assert.equal(isUnquotedCampaignProgressEligible('needs_review'), false);
});

test('trigger mulai menerima variasi manusia tanpa menangkap kalimat jawaban biasa', () => {
  ['MULAI', 'mulaiii', 'Mulai!!!', 'mulai ya', 'ayo mulai dong', 'yuk mulai sekarang']
    .forEach((value) => assert.equal(isCampaignStartCommand(value), true, value));
  ['saya mulai bekerja', 'mulai bekerja 01/09/2026', 'belum mulai', 'ayo lanjut']
    .forEach((value) => assert.equal(isCampaignStartCommand(value), false, value));
});

test('trigger mulai memilih Campaign not_started dengan outbound terbaru', () => {
  const selected = selectStartCampaignCandidate([
    { campaign_id: 4, progress_status: 'in_progress', sent_at: '2026-09-01T03:30:00.000Z' },
    { campaign_id: 11, progress_status: 'not_started', sent_at: '2026-09-01T03:20:00.000Z' },
    { campaign_id: 13, progress_status: 'not_started', sent_at: '2026-09-01T03:25:00.000Z' },
  ]);
  assert.equal(selected.campaign_id, 13);
  assert.equal(selectStartCampaignCandidate([
    { campaign_id: 11, progress_status: 'not_started', sent_at: '2026-09-01T03:25:00.000Z' },
    { campaign_id: 13, progress_status: 'not_started', sent_at: '2026-09-01T03:25:00.000Z' },
  ]), null);
});

test('jawaban biasa multi-Campaign mengikuti outbound terbaru hanya jika timestamp unik', () => {
  const latest = { campaign_id: 21, sent_at: '2026-09-04T08:55:10.000Z' };
  const older = { campaign_id: 13, sent_at: '2026-09-04T08:54:00.000Z' };
  assert.deepEqual(selectLatestOutboundCampaignCandidate([latest, older]), latest);
  assert.equal(selectLatestOutboundCampaignCandidate([
    latest,
    { ...older, sent_at: latest.sent_at },
  ]), null);
  assert.equal(selectLatestOutboundCampaignCandidate([]), null);
});

test('balasan tanpa quote mengikuti konfirmasi Reblast terbaru secara ketat pada multi-Campaign', () => {
  const latest = {
    campaign_id: 4,
    progress_status: 'in_progress',
    sent_at: '2026-09-02T01:35:42.787Z',
  };
  const older = {
    campaign_id: 13,
    progress_status: 'in_progress',
    sent_at: '2026-09-01T04:54:10.283Z',
  };
  const reblastContext = { idempotency_key: 'campaign-reblast:215:confirm:308' };

  assert.deepEqual(selectLatestReblastCampaignCandidate([latest, older], reblastContext), latest);
  assert.equal(selectLatestReblastCampaignCandidate([latest, older], { idempotency_key: null }), null);
  assert.equal(selectLatestReblastCampaignCandidate([
    latest,
    { ...older, sent_at: latest.sent_at },
  ], reblastContext), null);
});

test('balasan detail koreksi diprioritaskan hanya jika tepat satu Campaign menunggu detail', () => {
  const pending = { campaign_id: 13, progress_status: 'review_pending_details' };
  assert.deepEqual(selectReviewDetailCampaignCandidate([
    { campaign_id: 4, progress_status: 'in_progress' }, pending,
  ]), pending);
  assert.equal(selectReviewDetailCampaignCandidate([
    pending, { campaign_id: 14, progress_status: 'review_pending_details' },
  ]), null);
});

test('target Reblast membedakan belum membalas dan berhenti di sesi manapun', () => {
  assert.deepEqual(parseReblastTarget({ mode: 'no_reply' }), {
    mode: 'no_reply', sessionNumber: null, deliveryType: 'reblast_no_reply',
  });
  assert.deepEqual(parseReblastTarget({ mode: 'stalled' }), {
    mode: 'stalled', sessionNumber: null, deliveryType: 'reblast_stalled',
  });
  assert.deepEqual(parseReblastTarget({ mode: 'stalled', session_number: 4 }), {
    mode: 'stalled', sessionNumber: null, deliveryType: 'reblast_stalled',
  });
});

test('balasan Reblast diperlakukan sebagai konfirmasi dan prompt tidak diduplikasi', () => {
  assert.equal(parseReblastConfirmation('Iya, saya bersedia melanjutkan'), 'accepted');
  assert.equal(parseReblastConfirmation('Tidak, saya ingin berhenti'), 'declined');
  assert.equal(parseReblastConfirmation('Nanti saya kabari'), 'invalid');
  const message = withReblastConfirmationPrompt('Halo {{nama}}, kami ingin mengingatkan Anda.');
  assert.match(message, /Balas YA untuk melanjutkan atau TIDAK jika belum bersedia saat ini\.$/);
  assert.equal(withReblastConfirmationPrompt(message), message);
  assert.ok(message.includes(REBLAST_CONFIRMATION_PROMPT));
  assert.equal(isReblastConfirmationMessage({ campaign_delivery_type: 'reblast_stalled' }), true);
  assert.equal(isReblastConfirmationMessage({
    source: 'campaign', idempotency_key: 'campaign-reblast:45:confirm:81',
  }), true);
  assert.equal(isReblastConfirmationMessage({
    source: 'campaign', idempotency_key: 'campaign-reblast:45:resume:2',
  }), false);
});

test('konfirmasi Reblast mempertahankan sesi yang sedang ditunggu', () => {
  assert.deepEqual(nextReblastConfirmationState(
    { status: 'in_progress', current_session_number: 2 }, 'accepted', true,
  ), {
    action: 'reblast_resumed',
    resumedSessionNumber: 2,
    updates: { current_session_number: 2, status: 'in_progress' },
  });
  assert.deepEqual(nextReblastConfirmationState(
    { status: 'not_started', current_session_number: 0 }, 'accepted', true,
  ), {
    action: 'reblast_resumed',
    resumedSessionNumber: 1,
    updates: { current_session_number: 1, status: 'in_progress' },
  });
  assert.equal(nextReblastConfirmationState(
    { status: 'in_progress', current_session_number: 2 }, 'declined', true,
  ).action, 'reblast_declined');
  assert.deepEqual(nextReblastConfirmationState(
    { status: 'in_progress', current_session_number: 2 }, 'declined', true,
  ).updates, {});
  assert.equal(nextReblastConfirmationState(
    { status: 'in_progress', current_session_number: 2 }, 'invalid', true,
  ).action, 'reblast_confirmation_required');
  assert.equal(nextReblastConfirmationState(
    { status: 'completed', current_session_number: 10 }, 'accepted', true,
  ).action, 'already_completed');
});
