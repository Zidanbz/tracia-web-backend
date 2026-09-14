const ExcelJS = require('exceljs');

const EXCEL_CELL_TEXT_LIMIT = 30000;
const PIVOT_QUESTION_LIMIT = 500;

function spreadsheetText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\u0000/g, '');
  return /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function splitCellText(value) {
  const text = value === null || value === undefined ? '' : String(value).replace(/\u0000/g, '');
  if (!text) return [''];
  const parts = [];
  for (let offset = 0; offset < text.length; offset += EXCEL_CELL_TEXT_LIMIT) {
    parts.push(spreadsheetText(text.slice(offset, offset + EXCEL_CELL_TEXT_LIMIT)));
  }
  return parts;
}

function formatDateTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return spreadsheetText(value);
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Makassar',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date).replace(/\./g, ':');
}

function progressLabel(status) {
  return {
    not_started: 'Belum Mulai',
    in_progress: 'Dalam Proses',
    review_pending_details: 'Menunggu Detail Data Tidak Sesuai',
    completed: 'Selesai',
    stopped: 'Dihentikan',
    needs_review: 'Perlu Verifikasi',
  }[status] || spreadsheetText(status);
}

function isValidAnswer(answer) {
  if (answer.answer_type === 'choice') return Boolean(answer.selected_answer_text);
  return Boolean(String(answer.raw_answer || '').trim());
}

function answerDisplayValue(answer) {
  if (isValidAnswer(answer)) {
    return spreadsheetText(answer.selected_answer_text || answer.raw_answer);
  }
  return `[Tidak valid] ${spreadsheetText(answer.raw_answer) || '(kosong)'}`;
}

function styleWorksheet(worksheet, { autoFilter = true } = {}) {
  const header = worksheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F4C81' } };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 34;
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (autoFilter && worksheet.columnCount) {
    worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: worksheet.columnCount } };
  }
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.alignment = { vertical: 'top', wrapText: true };
  });
}

function questionHeader(answer) {
  const version = Number(answer.questionnaire_version || 0);
  const position = Number(answer.question_position || answer.session_number || 0);
  return `V${version || '-'} P${position || '-'} - ${spreadsheetText(answer.question_title || 'Pertanyaan')}`;
}

function questionMatchKey(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function contactExportGroup(contact, answersByMembership) {
  if (contact.progress_status === 'completed') return 'completed';
  const answers = answersByMembership.get(Number(contact.membership_id)) || [];
  return answers.length ? 'in_progress' : 'not_responded';
}

function buildCampaignMonitoringWorkbook({ campaign, contacts, answers, filters = {}, canonicalQuestions = null, generatedAt = new Date() }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'WA Service';
  workbook.company = 'WA Service';
  workbook.created = generatedAt;
  workbook.modified = generatedAt;
  workbook.subject = `Export jawaban Campaign ${spreadsheetText(campaign.title)}`;

  const answersByMembership = new Map();
  const questions = new Map();
  answers.forEach((answer) => {
    const membershipId = Number(answer.membership_id);
    if (!answersByMembership.has(membershipId)) answersByMembership.set(membershipId, []);
    answersByMembership.get(membershipId).push(answer);
    if (answer.question_public_id && !questions.has(answer.question_public_id)) {
      questions.set(answer.question_public_id, {
        publicId: answer.question_public_id,
        questionnaireVersion: Number(answer.questionnaire_version || 0),
        position: Number(answer.question_position || answer.session_number || 0),
        header: questionHeader(answer),
      });
    }
  });
  const discoveredQuestions = [...questions.values()].sort((left, right) => (
    left.questionnaireVersion - right.questionnaireVersion || left.position - right.position
  ));
  const allOrderedQuestions = canonicalQuestions || discoveredQuestions;
  const orderedQuestions = allOrderedQuestions.slice(0, PIVOT_QUESTION_LIMIT);

  const baseColumns = [
    { header: 'Nama', key: 'name', width: 28 },
    { header: 'Nomor WhatsApp', key: 'phone', width: 21 },
    { header: 'NIM', key: 'student_number', width: 20 },
    { header: 'Tahun Masuk', key: 'entry_year', width: 14 },
    { header: 'Universitas', key: 'university', width: 28 },
    { header: 'Fakultas', key: 'faculty', width: 28 },
    { header: 'Program Studi', key: 'study_program', width: 28 },
    { header: 'Status Progres', key: 'progress', width: 20 },
    { header: 'Pertanyaan Saat Ini', key: 'current_question', width: 30 },
    { header: 'Jawaban Valid', key: 'valid_count', width: 15 },
    { header: 'Jawaban Tidak Valid', key: 'invalid_count', width: 19 },
    { header: 'Total Input Jawaban', key: 'answer_count', width: 19 },
    { header: 'Mulai Mengisi', key: 'started_at', width: 22 },
    { header: 'Selesai Mengisi', key: 'completed_at', width: 22 },
    { header: 'Campaign', key: 'campaign_title', width: 30 },
  ];
  const contactGroups = {
    completed: [],
    in_progress: [],
    not_responded: [],
  };
  contacts.forEach((contact) => {
    contactGroups[contactExportGroup(contact, answersByMembership)].push(contact);
  });

  const contactSheetColumns = [
    ...baseColumns,
    ...orderedQuestions.map((question) => ({
      header: question.header,
      key: `question_${question.publicId}`,
      width: 34,
    })),
  ];
  function addContactSheet(name, groupContacts) {
    const worksheet = workbook.addWorksheet(name, { properties: { defaultRowHeight: 20 } });
    worksheet.columns = contactSheetColumns;
    worksheet.getColumn('phone').numFmt = '@';
    worksheet.getColumn('student_number').numFmt = '@';
    groupContacts.forEach((contact) => {
      const contactAnswers = answersByMembership.get(Number(contact.membership_id)) || [];
      const validCount = contactAnswers.filter(isValidAnswer).length;
      const row = {
        name: spreadsheetText(contact.name),
        phone: spreadsheetText(contact.phone_e164),
        student_number: spreadsheetText(contact.student_number),
        entry_year: contact.entry_year || '',
        university: spreadsheetText(contact.university_name),
        faculty: spreadsheetText(contact.faculty_name),
        study_program: spreadsheetText(contact.study_program_name),
        progress: progressLabel(contact.progress_status),
        current_question: spreadsheetText(contact.current_question_title),
        valid_count: validCount,
        invalid_count: contactAnswers.length - validCount,
        answer_count: contactAnswers.length,
        started_at: formatDateTime(contact.started_at),
        completed_at: formatDateTime(contact.completed_at),
        campaign_title: spreadsheetText(contact.campaign_title),
      };
      orderedQuestions.forEach((question) => {
        const values = contactAnswers
        .filter((answer) => canonicalQuestions
          ? questionMatchKey(answer.question_title) === question.matchKey
          : answer.question_public_id === question.publicId)
          .map(answerDisplayValue);
        const combined = values.join('\n');
        row[`question_${question.publicId}`] = combined.length <= EXCEL_CELL_TEXT_LIMIT
          ? combined
          : `${combined.slice(0, EXCEL_CELL_TEXT_LIMIT - 64)}\n[Lihat isi lengkap pada sheet Histori Jawaban]`;
      });
      worksheet.addRow(row);
    });
    styleWorksheet(worksheet);
  }
  addContactSheet('Selesai Menjawab', contactGroups.completed);
  addContactSheet('Dalam Proses', contactGroups.in_progress);
  addContactSheet('Belum Menjawab', contactGroups.not_responded);

  const historySheet = workbook.addWorksheet('Histori Jawaban', {
    properties: { defaultRowHeight: 20 },
  });
  historySheet.columns = [
    { header: 'Nama', key: 'name', width: 28 },
    { header: 'Nomor WhatsApp', key: 'phone', width: 21 },
    { header: 'NIM', key: 'student_number', width: 20 },
    { header: 'Questionnaire', key: 'questionnaire', width: 30 },
    { header: 'Versi', key: 'version', width: 10 },
    { header: 'No. Pertanyaan', key: 'position', width: 15 },
    { header: 'Judul Pertanyaan', key: 'title', width: 30 },
    { header: 'Teks Pertanyaan', key: 'question_text', width: 48 },
    { header: 'Jenis Jawaban', key: 'answer_type', width: 18 },
    { header: 'Input User', key: 'raw_answer', width: 48 },
    { header: 'Jawaban Tervalidasi', key: 'selected_answer', width: 32 },
    { header: 'Validasi', key: 'validation', width: 16 },
    { header: 'Bagian', key: 'part', width: 10 },
    { header: 'Diterima (WITA)', key: 'received_at', width: 23 },
  ];
  historySheet.getColumn('phone').numFmt = '@';
  historySheet.getColumn('student_number').numFmt = '@';
  answers.forEach((answer) => {
    const parts = splitCellText(answer.raw_answer);
    parts.forEach((part, index) => {
      historySheet.addRow({
        name: spreadsheetText(answer.name),
        phone: spreadsheetText(answer.phone_e164),
        student_number: spreadsheetText(answer.student_number),
        questionnaire: spreadsheetText(answer.questionnaire_name),
        version: answer.questionnaire_version || '',
        position: answer.question_position || answer.session_number || '',
        title: spreadsheetText(answer.question_title),
        question_text: spreadsheetText(answer.question_text),
        answer_type: answer.answer_type === 'choice' ? 'Pilihan' : 'Teks Bebas',
        raw_answer: part,
        selected_answer: spreadsheetText(answer.selected_answer_text),
        validation: isValidAnswer(answer) ? 'Valid' : 'Tidak Valid',
        part: parts.length > 1 ? `${index + 1}/${parts.length}` : '1/1',
        received_at: formatDateTime(answer.received_at),
      });
    });
  });
  styleWorksheet(historySheet);

  const infoSheet = workbook.addWorksheet('Informasi Export');
  infoSheet.columns = [{ key: 'label', width: 28 }, { key: 'value', width: 72 }];
  [
    ['Campaign', spreadsheetText(campaign.title)],
    ['Waktu export (WITA)', formatDateTime(generatedAt)],
    ['Jumlah alumni', contacts.length],
    ['Alumni selesai menjawab', contactGroups.completed.length],
    ['Alumni dalam proses', contactGroups.in_progress.length],
    ['Alumni belum menjawab', contactGroups.not_responded.length],
    ['Jumlah input jawaban', answers.length],
    ['Filter pencarian', filters.search ? 'Aktif' : 'Tidak digunakan'],
    ['Filter status progres', progressLabel(filters.progress_status) || 'Semua'],
    ['Filter pertanyaan saat ini', filters.session_number || 'Semua'],
    ['Kolom pertanyaan per alumni', allOrderedQuestions.length > PIVOT_QUESTION_LIMIT
      ? `${PIVOT_QUESTION_LIMIT} dari ${allOrderedQuestions.length}; seluruh jawaban tetap tersedia pada Histori Jawaban`
      : allOrderedQuestions.length],
    ['Catatan', 'Hanya jawaban questionnaire pada cycle aktif. Selesai = status completed; Dalam Proses = memiliki minimal satu jawaban tetapi belum completed; Belum Menjawab = belum memiliki jawaban questionnaire. Konfirmasi Reblast tidak disertakan.'],
  ].forEach(([label, value]) => infoSheet.addRow({ label, value }));
  infoSheet.getColumn(1).font = { bold: true };
  infoSheet.eachRow((row) => { row.alignment = { vertical: 'top', wrapText: true }; });

  return workbook;
}

module.exports = {
  EXCEL_CELL_TEXT_LIMIT,
  PIVOT_QUESTION_LIMIT,
  spreadsheetText,
  isValidAnswer,
  contactExportGroup,
  questionMatchKey,
  buildCampaignMonitoringWorkbook,
};
