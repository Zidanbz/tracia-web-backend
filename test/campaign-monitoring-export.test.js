const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const {
  EXCEL_CELL_TEXT_LIMIT,
  spreadsheetText,
  isValidAnswer,
  contactExportGroup,
  buildCampaignMonitoringWorkbook,
} = require('../src/modules/campaigns/campaign-monitoring-export');

test('export Monitoring Campaign memisahkan alumni selesai, proses, dan belum menjawab', async () => {
  const contacts = [{
    membership_id: 10,
    name: '=Nama Berbahaya',
    phone_e164: '+628123456789',
    student_number: '00123',
    entry_year: 2022,
    university_name: 'Universitas Contoh',
    faculty_name: 'Fakultas Ilmu Komputer',
    study_program_name: 'Teknik Informatika',
    progress_status: 'in_progress',
    current_question_title: 'Saran Alumni',
    started_at: new Date('2026-08-28T01:00:00.000Z'),
    completed_at: null,
  }, {
    membership_id: 11,
    name: 'Alumni Selesai',
    phone_e164: '+628123456790',
    progress_status: 'completed',
    completed_at: new Date('2026-08-28T01:20:00.000Z'),
  }, {
    membership_id: 12,
    name: 'Alumni Belum Menjawab',
    phone_e164: '+628123456791',
    progress_status: 'not_started',
  }];
  const answers = [
    {
      membership_id: 10,
      name: '=Nama Berbahaya',
      phone_e164: '+628123456789',
      student_number: '00123',
      raw_answer: 'A',
      session_number: 1,
      received_at: new Date('2026-08-28T01:05:00.000Z'),
      question_public_id: 'question-1',
      question_position: 1,
      question_title: 'Status pekerjaan',
      question_text: 'Apakah Anda sudah bekerja?',
      answer_type: 'choice',
      selected_answer_text: 'Sudah bekerja',
      questionnaire_name: 'Tracer Study',
      questionnaire_version: 2,
    },
    {
      membership_id: 10,
      name: '=Nama Berbahaya',
      phone_e164: '+628123456789',
      student_number: '00123',
      raw_answer: '=HYPERLINK("https://example.test")',
      session_number: 2,
      received_at: new Date('2026-08-28T01:10:00.000Z'),
      question_public_id: 'question-2',
      question_position: 2,
      question_title: 'Saran Alumni',
      question_text: 'Apa saran Anda?',
      answer_type: 'free_text',
      selected_answer_text: null,
      questionnaire_name: 'Tracer Study',
      questionnaire_version: 2,
    },
  ];

  const workbook = buildCampaignMonitoringWorkbook({
    campaign: { title: 'Tracer Study 2026' },
    contacts,
    answers,
    generatedAt: new Date('2026-08-28T02:00:00.000Z'),
  });
  const completedSheet = workbook.getWorksheet('Selesai Menjawab');
  const progressSheet = workbook.getWorksheet('Dalam Proses');
  const notRespondedSheet = workbook.getWorksheet('Belum Menjawab');
  const historySheet = workbook.getWorksheet('Histori Jawaban');
  assert.ok(completedSheet);
  assert.ok(progressSheet);
  assert.ok(notRespondedSheet);
  assert.ok(historySheet);
  assert.equal(completedSheet.rowCount, 2);
  assert.equal(progressSheet.rowCount, 2);
  assert.equal(notRespondedSheet.rowCount, 2);
  assert.equal(historySheet.rowCount, 3);
  assert.equal(progressSheet.getRow(2).getCell(1).value, "'=Nama Berbahaya");
  assert.equal(progressSheet.getRow(2).getCell(10).value, 2);
  assert.equal(historySheet.getRow(3).getCell(10).value, "'=HYPERLINK(\"https://example.test\")");

  const serialized = await workbook.xlsx.writeBuffer();
  const parsed = new ExcelJS.Workbook();
  await parsed.xlsx.load(serialized);
  assert.equal(parsed.getWorksheet('Dalam Proses').getRow(2).getCell(1).formula, undefined);
  assert.equal(parsed.getWorksheet('Histori Jawaban').getRow(3).getCell(10).formula, undefined);
  const byMembership = new Map([[1, [{}]]]);
  assert.equal(contactExportGroup({ membership_id: 1, progress_status: 'not_started' }, byMembership), 'in_progress');
  assert.equal(contactExportGroup({ membership_id: 2, progress_status: 'not_started' }, byMembership), 'not_responded');
  assert.equal(contactExportGroup({ membership_id: 2, progress_status: 'completed' }, byMembership), 'completed');
});

test('export memecah jawaban yang melebihi batas aman satu cell tanpa kehilangan isi', () => {
  const longAnswer = `-${'a'.repeat(EXCEL_CELL_TEXT_LIMIT * 2)}`;
  const workbook = buildCampaignMonitoringWorkbook({
    campaign: { title: 'Campaign' },
    contacts: [{ membership_id: 1, name: 'Alumni', progress_status: 'in_progress' }],
    answers: [{
      membership_id: 1,
      name: 'Alumni',
      raw_answer: longAnswer,
      question_public_id: 'question-long',
      question_position: 1,
      question_title: 'Jawaban panjang',
      question_text: 'Tuliskan jawaban',
      answer_type: 'free_text',
      questionnaire_version: 1,
    }],
  });
  const history = workbook.getWorksheet('Histori Jawaban');
  assert.equal(history.rowCount, 4);
  const reconstructed = [2, 3, 4].map((row) => history.getRow(row).getCell(10).value).join('');
  assert.equal(reconstructed, spreadsheetText(longAnswer));
  assert.equal(isValidAnswer({ answer_type: 'choice', selected_answer_text: null }), false);
  assert.equal(isValidAnswer({ answer_type: 'free_text', raw_answer: 'isi' }), true);
});

test('export lintas Campaign memakai kolom pertanyaan acuan dan mengosongkan yang tidak sama', () => {
  const workbook = buildCampaignMonitoringWorkbook({
    campaign: { title: 'Monitoring Campaign' },
    contacts: [{ membership_id: 1, name: 'Alumni', progress_status: 'completed' }],
    answers: [{ membership_id: 1, name: 'Alumni', question_public_id: 'other', question_title: 'Pertanyaan Berbeda', raw_answer: 'isi', answer_type: 'free_text' }],
    canonicalQuestions: [{ publicId: 'wave-1-q', position: 1, header: 'P1 - Pertanyaan Wave 1', matchKey: 'pertanyaan wave 1' }],
  });
  const sheet = workbook.getWorksheet('Selesai Menjawab');
  assert.equal(sheet.getRow(1).getCell(16).value, 'P1 - Pertanyaan Wave 1');
  assert.equal(sheet.getRow(2).getCell(16).value, '');
});
