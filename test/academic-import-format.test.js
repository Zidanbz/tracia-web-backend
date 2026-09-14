const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COMPLETE_HEADERS,
  IDENTITY_HEADERS,
  detectImportFormat,
  isValidEmail,
  normalizeEmail,
  normalizeGraduationPeriod,
  normalizeStudentNumber,
  parseEntryYear,
  validateHeaderValues,
  resolveRowGrouping,
  validateAcademicValues,
} = require('../src/modules/contact-imports/academic-import-format');

const groups = [
  { id: 1, parent_id: null, type: 'university', code: 'UMI', name: 'Universitas Muslim Indonesia', status: 'active' },
  { id: 2, parent_id: 1, type: 'faculty', code: 'FIKOM', name: 'Fakultas Ilmu Komputer', status: 'active' },
  { id: 3, parent_id: 2, type: 'study_program', code: 'TI', name: 'Teknik Informatika', status: 'active' },
  { id: 4, parent_id: 1, type: 'faculty', code: 'FEB', name: 'Fakultas Ekonomi', status: 'active' },
];

test('format import akademik mewajibkan enam header dalam urutan yang benar', () => {
  assert.equal(validateHeaderValues(['Nama', 'No Telpon', 'NIM', 'Tahun Masuk', 'Fakultas', 'Jurusan']).valid, true);
  assert.equal(validateHeaderValues(['Nama', 'NIM', 'No Telpon', 'Tahun Masuk', 'Fakultas', 'Jurusan']).valid, false);
});

test('format import mendukung identitas 8 kolom dan file lengkap 13 kolom secara eksak', () => {
  assert.equal(detectImportFormat(IDENTITY_HEADERS).format, 'identity');
  assert.equal(detectImportFormat(COMPLETE_HEADERS).format, 'complete');
  assert.equal(detectImportFormat([...COMPLETE_HEADERS].reverse()).valid, false);
  assert.equal(normalizeEmail(' Alumni@Example.COM '), 'alumni@example.com');
  assert.equal(isValidEmail('alumni@example.com'), true);
  assert.equal(isValidEmail('alamat-tidak-valid'), false);
  assert.equal(normalizeGraduationPeriod('2026-2'), '2026 - 2');
  assert.equal(normalizeGraduationPeriod('semester depan'), null);
});

test('NIM dipertahankan sebagai teks dan tahun masuk dibatasi ke tahun masuk akal', () => {
  assert.equal(normalizeStudentNumber(' 0012-ti '), '0012-TI');
  assert.equal(parseEntryYear('2024', 2026), 2024);
  assert.equal(parseEntryYear('24', 2026), null);
  assert.equal(parseEntryYear('2030', 2026), null);
  assert.equal(validateAcademicValues({ name: 'Alumni', studentNumber: '0012-TI', entryYear: 2024 }), null);
});

test('fakultas dan jurusan dapat dicocokkan lewat kode atau nama serta dibatasi scope campaign', () => {
  const selectedGrouping = { university: groups[0], faculty: groups[1], studyProgram: groups[2] };
  const resolved = resolveRowGrouping({ facultyValue: 'FIKOM', studyProgramValue: 'Teknik Informatika', selectedGrouping, groups });
  assert.equal(resolved.valid, true);
  assert.equal(resolved.studyProgram.id, 3);
  assert.equal(resolveRowGrouping({ facultyValue: 'FEB', studyProgramValue: 'TI', selectedGrouping, groups }).errorCode, 'FACULTY_OUTSIDE_CAMPAIGN_SCOPE');
});
