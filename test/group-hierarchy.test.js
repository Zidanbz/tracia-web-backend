const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPathKey,
  normalizeGroupCode,
  resolveSelectedGrouping,
} = require('../src/modules/contact-groups/group-hierarchy');

const universities = [
  { id: 1, type: 'university', code: 'UNUD', name: 'Universitas Udayana', status: 'active', path_key: 'university:UNUD' },
  { id: 2, type: 'university', code: 'UNHAS', name: 'Universitas Hasanuddin', status: 'active', path_key: 'university:UNHAS' },
];
const groups = [
  ...universities,
  { id: 3, parent_id: 1, type: 'faculty', code: 'FT', name: 'Fakultas Teknik UNUD', status: 'active', path_key: 'university:UNUD/faculty:FT' },
  { id: 4, parent_id: 2, type: 'faculty', code: 'FT', name: 'Fakultas Teknik UNHAS', status: 'active', path_key: 'university:UNHAS/faculty:FT' },
  { id: 5, parent_id: 1, type: 'faculty', code: 'FK', name: 'Fakultas Kedokteran', status: 'inactive', path_key: 'university:UNUD/faculty:FK' },
  { id: 6, parent_id: 3, type: 'study_program', code: 'TI', name: 'Teknik Informatika', status: 'active', path_key: 'university:UNUD/faculty:FT/study_program:TI' },
];

test('kode dinormalisasi dan path fakultas stabil terhadap nama tampilan', () => {
  assert.equal(normalizeGroupCode('  unud '), 'UNUD');
  assert.equal(buildPathKey({ type: 'faculty', code: 'ft', parent: universities[0] }), 'university:UNUD/faculty:FT');
});

test('program studi wajib menjadi child fakultas yang dipilih', () => {
  const valid = resolveSelectedGrouping({ universityId: 1, facultyId: 3, studyProgramId: 6 }, groups);
  assert.equal(valid.valid, true);
  assert.equal(valid.studyProgram.id, 6);
  assert.equal(resolveSelectedGrouping({ universityId: 2, facultyId: 4, studyProgramId: 6 }, groups).errorCode, 'STUDY_PROGRAM_FACULTY_MISMATCH');
  assert.equal(resolveSelectedGrouping({ universityId: 1, facultyId: '', studyProgramId: 6 }, groups).errorCode, 'STUDY_PROGRAM_REQUIRES_FACULTY');
});

test('kode fakultas yang sama dapat dipakai pada universitas berbeda', () => {
  const unud = resolveSelectedGrouping({ universityId: 1, facultyId: 3 }, groups);
  const unhas = resolveSelectedGrouping({ universityId: 2, facultyId: 4 }, groups);
  assert.equal(unud.valid, true);
  assert.equal(unud.faculty.id, 3);
  assert.equal(unhas.valid, true);
  assert.equal(unhas.faculty.id, 4);
});

test('pilihan admin menolak fakultas nonaktif atau fakultas milik universitas lain', () => {
  assert.equal(resolveSelectedGrouping({ universityId: 1, facultyId: 5 }, groups).errorCode, 'FACULTY_NOT_FOUND_OR_INACTIVE');
  assert.equal(resolveSelectedGrouping({ universityId: 1, facultyId: 4 }, groups).errorCode, 'FACULTY_UNIVERSITY_MISMATCH');
});

test('universitas wajib dipilih dan fakultas boleh dikosongkan', () => {
  assert.equal(resolveSelectedGrouping({ universityId: '', facultyId: '' }, groups).errorCode, 'UNIVERSITY_REQUIRED');
  const result = resolveSelectedGrouping({ universityId: 1, facultyId: '' }, groups);
  assert.equal(result.valid, true);
  assert.equal(result.university.id, 1);
  assert.equal(result.faculty, null);
});
