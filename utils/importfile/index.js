const fs = require('fs/promises');
const exceljs = require('exceljs');
const {
  REQUIRED_HEADERS,
  normalizeStudentNumber,
  parseEntryYear,
  validateHeaderValues,
} = require('../../src/modules/contact-imports/academic-import-format');

async function importFile(req) {
  if (!req.file?.path) {
    const error = new Error('File Excel wajib diunggah');
    error.status = 422;
    throw error;
  }

  try {
    const workbook = new exceljs.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      const error = new Error('Worksheet tidak ditemukan');
      error.status = 422;
      throw error;
    }
    const header = validateHeaderValues(REQUIRED_HEADERS.map((_, index) => worksheet.getRow(1).getCell(index + 1).text));
    if (!header.valid) {
      const error = new Error('Header Excel tidak sesuai format import kontak');
      error.status = 422;
      throw error;
    }

    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= 1) return;
      const values = Array.from({ length: REQUIRED_HEADERS.length }, (_, index) => row.getCell(index + 1).text.trim());
      if (!values.some(Boolean)) return;
      rows.push({
        name: values[0],
        phone: values[1],
        student_number: normalizeStudentNumber(values[2]),
        entry_year: parseEntryYear(values[3]),
        faculty: values[4],
        study_program: values[5],
      });
    });
    return rows;
  } finally {
    await fs.unlink(req.file.path).catch(() => undefined);
  }
}

module.exports = importFile;
