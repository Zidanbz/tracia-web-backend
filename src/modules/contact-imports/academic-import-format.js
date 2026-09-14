const REQUIRED_HEADERS = Object.freeze([
  'nama',
  'no telpon',
  'nim',
  'tahun masuk',
  'fakultas',
  'jurusan',
]);

const COMPLETE_HEADERS = Object.freeze([
  'nama',
  'no telpon',
  'nim',
  'tahun masuk',
  'fakultas',
  'jurusan',
  'tempat lahir',
  'tanggal lahir',
  'jenis kelamin',
  'nik',
  'alamat lengkap',
  'email',
  'periode wisuda',
]);

const IDENTITY_HEADERS = Object.freeze([
  ...REQUIRED_HEADERS,
  'email',
  'periode wisuda',
]);

const STUDENT_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{1,63}$/;

function normalizeLabel(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('id-ID');
}

function normalizeStudentNumber(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function parseEntryYear(value, currentYear = new Date().getFullYear()) {
  const normalized = String(value || '').trim();
  if (!/^\d{4}$/.test(normalized)) return null;
  const year = Number(normalized);
  return year >= 1900 && year <= currentYear + 1 ? year : null;
}

function normalizeEmail(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('id-ID');
}

function isValidEmail(value) {
  const email = normalizeEmail(value);
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeGraduationPeriod(value) {
  const normalized = String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  const match = normalized.match(/^(\d{4})\s*-\s*([12])$/);
  return match ? `${match[1]} - ${match[2]}` : null;
}

function validateHeaderValues(values) {
  const actual = REQUIRED_HEADERS.map((_, index) => normalizeLabel(values[index]));
  const valid = REQUIRED_HEADERS.every((header, index) => actual[index] === header);
  return { valid, expected: REQUIRED_HEADERS, actual };
}

function detectImportFormat(values) {
  const actual = values.map(normalizeLabel);
  const matches = (expected) => expected.length === actual.length
    && expected.every((header, index) => actual[index] === header);
  if (matches(REQUIRED_HEADERS)) return { valid: true, format: 'legacy', expected: REQUIRED_HEADERS, actual };
  if (matches(IDENTITY_HEADERS)) return { valid: true, format: 'identity', expected: IDENTITY_HEADERS, actual };
  if (matches(COMPLETE_HEADERS)) return { valid: true, format: 'complete', expected: COMPLETE_HEADERS, actual };
  return { valid: false, format: null, expected: [REQUIRED_HEADERS, IDENTITY_HEADERS, COMPLETE_HEADERS], actual };
}

function findUniqueGroup(groups, type, parentId, value) {
  const normalized = normalizeLabel(value);
  if (!normalized) return { group: null, errorCode: `${type.toUpperCase()}_REQUIRED` };
  const matches = groups.filter((group) => group.type === type
    && group.status === 'active'
    && Number(group.parent_id) === Number(parentId)
    && [group.code, group.name].some((candidate) => normalizeLabel(candidate) === normalized));
  if (matches.length === 1) return { group: matches[0], errorCode: null };
  return { group: null, errorCode: matches.length > 1 ? `${type.toUpperCase()}_AMBIGUOUS` : `${type.toUpperCase()}_NOT_FOUND` };
}

function resolveRowGrouping({ facultyValue, studyProgramValue, selectedGrouping, groups }) {
  const facultyResult = findUniqueGroup(groups, 'faculty', selectedGrouping.university.id, facultyValue);
  if (!facultyResult.group) return { valid: false, errorCode: facultyResult.errorCode };
  if (selectedGrouping.faculty && Number(facultyResult.group.id) !== Number(selectedGrouping.faculty.id)) {
    return { valid: false, errorCode: 'FACULTY_OUTSIDE_CAMPAIGN_SCOPE' };
  }

  const studyProgramResult = findUniqueGroup(groups, 'study_program', facultyResult.group.id, studyProgramValue);
  if (!studyProgramResult.group) return { valid: false, errorCode: studyProgramResult.errorCode };
  if (selectedGrouping.studyProgram && Number(studyProgramResult.group.id) !== Number(selectedGrouping.studyProgram.id)) {
    return { valid: false, errorCode: 'STUDY_PROGRAM_OUTSIDE_CAMPAIGN_SCOPE' };
  }

  return {
    valid: true,
    errorCode: null,
    university: selectedGrouping.university,
    faculty: facultyResult.group,
    studyProgram: studyProgramResult.group,
  };
}

function validateAcademicValues({ name, studentNumber, entryYear }) {
  if (!String(name || '').trim()) return 'NAME_REQUIRED';
  if (String(name).trim().length > 150) return 'NAME_TOO_LONG';
  if (!STUDENT_NUMBER_PATTERN.test(studentNumber)) return 'INVALID_NIM';
  if (!entryYear) return 'INVALID_ENTRY_YEAR';
  return null;
}

module.exports = {
  COMPLETE_HEADERS,
  IDENTITY_HEADERS,
  REQUIRED_HEADERS,
  STUDENT_NUMBER_PATTERN,
  detectImportFormat,
  isValidEmail,
  normalizeLabel,
  normalizeEmail,
  normalizeGraduationPeriod,
  normalizeStudentNumber,
  parseEntryYear,
  resolveRowGrouping,
  validateAcademicValues,
  validateHeaderValues,
};
