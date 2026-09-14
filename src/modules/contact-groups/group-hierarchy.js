const GROUP_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

function normalizeGroupCode(value) {
  return String(value || '').trim().toUpperCase();
}

function isValidGroupCode(value) {
  return GROUP_CODE_PATTERN.test(normalizeGroupCode(value));
}

function buildPathKey({ type, code, parent }) {
  const segment = `${type}:${normalizeGroupCode(code)}`;
  return parent ? `${parent.path_key}/${segment}` : segment;
}

function resolveSelectedGrouping({ universityId, facultyId, studyProgramId }, groups) {
  const normalizedUniversityId = Number(universityId);
  const normalizedFacultyId = facultyId === undefined || facultyId === null || facultyId === ''
    ? null
    : Number(facultyId);
  const normalizedStudyProgramId = studyProgramId === undefined || studyProgramId === null || studyProgramId === ''
    ? null
    : Number(studyProgramId);
  if (!Number.isInteger(normalizedUniversityId) || normalizedUniversityId <= 0) {
    return { valid: false, errorCode: 'UNIVERSITY_REQUIRED', university: null, faculty: null, studyProgram: null };
  }
  const university = groups.find((group) => Number(group.id) === normalizedUniversityId
    && group.type === 'university'
    && group.status === 'active');
  if (!university) {
    return { valid: false, errorCode: 'UNIVERSITY_NOT_FOUND_OR_INACTIVE', university: null, faculty: null, studyProgram: null };
  }
  if (normalizedFacultyId === null) {
    if (normalizedStudyProgramId !== null) {
      return { valid: false, errorCode: 'STUDY_PROGRAM_REQUIRES_FACULTY', university, faculty: null, studyProgram: null };
    }
    return { valid: true, errorCode: null, university, faculty: null, studyProgram: null };
  }
  if (!Number.isInteger(normalizedFacultyId) || normalizedFacultyId <= 0) {
    return { valid: false, errorCode: 'FACULTY_NOT_FOUND_OR_INACTIVE', university, faculty: null, studyProgram: null };
  }
  const faculty = groups.find((group) => Number(group.id) === normalizedFacultyId
    && group.type === 'faculty'
    && group.status === 'active');
  if (!faculty) {
    return { valid: false, errorCode: 'FACULTY_NOT_FOUND_OR_INACTIVE', university, faculty: null, studyProgram: null };
  }
  if (Number(faculty.parent_id) !== Number(university.id)) {
    return { valid: false, errorCode: 'FACULTY_UNIVERSITY_MISMATCH', university, faculty: null, studyProgram: null };
  }
  if (normalizedStudyProgramId === null) {
    return { valid: true, errorCode: null, university, faculty, studyProgram: null };
  }
  if (!Number.isInteger(normalizedStudyProgramId) || normalizedStudyProgramId <= 0) {
    return { valid: false, errorCode: 'STUDY_PROGRAM_NOT_FOUND_OR_INACTIVE', university, faculty, studyProgram: null };
  }
  const studyProgram = groups.find((group) => Number(group.id) === normalizedStudyProgramId
    && group.type === 'study_program'
    && group.status === 'active');
  if (!studyProgram) {
    return { valid: false, errorCode: 'STUDY_PROGRAM_NOT_FOUND_OR_INACTIVE', university, faculty, studyProgram: null };
  }
  if (Number(studyProgram.parent_id) !== Number(faculty.id)) {
    return { valid: false, errorCode: 'STUDY_PROGRAM_FACULTY_MISMATCH', university, faculty, studyProgram: null };
  }
  return { valid: true, errorCode: null, university, faculty, studyProgram };
}

module.exports = {
  GROUP_CODE_PATTERN,
  buildPathKey,
  isValidGroupCode,
  normalizeGroupCode,
  resolveSelectedGrouping,
};
