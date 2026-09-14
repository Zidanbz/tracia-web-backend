const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const importFile = require('../utils/importfile');

test('import Excel membaca enam kolom akademik dan menghapus temporary file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-import-test-'));
  const filePath = path.join(directory, 'contacts.xlsx');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Sheet1');
  worksheet.addRow(['Nama', 'No Telpon', 'NIM', 'Tahun Masuk', 'Fakultas', 'Jurusan']);
  worksheet.addRow(['Budi', '081234567890', '00123-TI', 2022, 'FIKOM', 'TI']);
  await workbook.xlsx.writeFile(filePath);

  const rows = await importFile({ file: { path: filePath } });
  assert.deepEqual(rows, [{
    name: 'Budi',
    phone: '081234567890',
    student_number: '00123-TI',
    entry_year: 2022,
    faculty: 'FIKOM',
    study_program: 'TI',
  }]);
  assert.equal(fs.existsSync(filePath), false);
  fs.rmSync(directory, { recursive: true, force: true });
});
