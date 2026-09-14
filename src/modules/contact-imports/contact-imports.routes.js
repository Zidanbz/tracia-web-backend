const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const multer = require('multer');
const ExcelJS = require('exceljs');
const knex = require('../../database/knex');
const env = require('../../config/env');
const asyncHandler = require('../../shared/async-handler');
const { requirePermission } = require('../../middleware/auth');
const { normalizePhone } = require('../../shared/phone');
const { writeRequestAudit } = require('../audit/audit.repository');
const { manager } = require('../whatsapp/whatsapp-client-manager');
const contactVerificationWorker = require('./contact-verification-worker');
const { IMPORTED_CONTACT_CONSENT, buildImportedConsent, isLatestCampaignImport } = require('./contact-import-policy');
const { resolveSelectedGrouping } = require('../contact-groups/group-hierarchy');
const campaignsService = require('../campaigns/campaigns.service');
const {
  detectImportFormat,
  isValidEmail,
  normalizeEmail,
  normalizeGraduationPeriod,
  normalizeStudentNumber,
  parseEntryYear,
  resolveRowGrouping,
  validateAcademicValues,
} = require('./academic-import-format');
const {
  EXPORT_TYPES,
  IMPORT_PREVIEW_CATEGORIES,
  applyExportFilter,
  applyImportPreviewCategory,
  buildRestorableImportState,
  getVerificationSummary,
  isVerificationFinished,
} = require('./contact-verification');

const router = express.Router();
const importLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `session:${req.session?.user?.id || ipKeyGenerator(req.ip)}`,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Batas import kontak terlampaui' } },
});
const importDirectory = path.resolve(__dirname, '../../../storage/imports');
const upload = multer({
  storage: multer.diskStorage({
    destination: importDirectory,
    filename: (req, file, callback) => callback(null, `contacts-${Date.now()}-${process.pid}.xlsx`),
  }),
  limits: { fileSize: env.uploadMaxBytes, files: 1 },
  fileFilter: (req, file, callback) => {
    const extensionOk = path.extname(file.originalname).toLowerCase() === '.xlsx';
    const mimeOk = new Set([
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream',
    ]).has(file.mimetype);
    if (!extensionOk || !mimeOk) {
      const error = new Error('File harus berupa Excel .xlsx'); error.status = 422; return callback(error);
    }
    return callback(null, true);
  },
});

async function assertXlsxSignature(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const bytes = Buffer.alloc(4);
    await handle.read(bytes, 0, 4, 0);
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      const error = new Error('Signature file bukan XLSX/ZIP yang valid'); error.status = 422; throw error;
    }
  } finally {
    await handle.close();
  }
}

function chunk(values, size = 500) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function getGroupingSummary(importId, database = knex) {
  const rows = await database('contact_import_rows')
    .where({ contact_import_id: importId })
    .select('grouping_status')
    .count({ count: '*' })
    .groupBy('grouping_status');
  const summary = { valid: 0, invalid: 0, not_applicable: 0 };
  rows.forEach((row) => { summary[row.grouping_status] = Number(row.count); });
  return summary;
}

async function getCampaignContext(req, publicId, database = knex, allowReadOnly = false) {
  if (!publicId) return null;
  if (!(req.session?.permissions || []).includes('campaigns.operate')) {
    const error = new Error('Anda tidak memiliki izin operasi Campaign');
    error.status = 403;
    throw error;
  }
  const campaign = await campaignsService.findScopedCampaign(
    publicId,
    campaignsService.actorFromRequest(req),
    database,
  );
  if (!allowReadOnly && ['completed', 'archived'].includes(campaign.status)) {
    const error = new Error('Campaign completed/archived tidak menerima import baru');
    error.status = 409;
    error.code = 'CAMPAIGN_READ_ONLY';
    throw error;
  }
  return campaign;
}

async function campaignRequiresProfileEmail(campaignId, database = knex) {
  if (!campaignId) return false;
  const rows = await database('campaign_questions as question')
    .join('campaign_questionnaires as questionnaire', 'questionnaire.id', 'question.questionnaire_id')
    .where({
      'question.campaign_id': campaignId,
      'questionnaire.is_current': true,
      'question.is_active': true,
    })
    .select('question.question_text');
  return rows.some((row) => /{{\s*email(?:_masked)?\s*}}/i.test(String(row.question_text || '')));
}

async function assertImportAccess(req, record, database = knex, allowReadOnly = true) {
  if (!record.campaign_id) return null;
  const campaign = await database('campaigns').where({ id: record.campaign_id }).first();
  if (!campaign) {
    const error = new Error('Campaign import tidak ditemukan');
    error.status = 404;
    throw error;
  }
  return getCampaignContext(req, campaign.public_id, database, allowReadOnly);
}

async function assertLatestCampaignImport(record, database = knex) {
  if (!record.campaign_id) return;
  const latestRecord = await database('contact_imports')
    .where({ campaign_id: record.campaign_id })
    .orderBy('id', 'desc')
    .select('id')
    .first();
  if (!isLatestCampaignImport(record, latestRecord)) {
    const error = new Error('Import ini sudah digantikan oleh preview yang lebih baru');
    error.status = 409;
    error.code = 'IMPORT_SUPERSEDED';
    throw error;
  }
}

async function sendWorkbook(res, workbook, filename) {
  const buffer = await workbook.xlsx.writeBuffer();
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(Buffer.from(buffer));
}

router.get('/template', requirePermission('contacts.manage'), asyncHandler(async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'WA Service';
  const contactsSheet = workbook.addWorksheet('Kontak');
  contactsSheet.columns = [
    { header: 'Nama', key: 'name', width: 30 },
    { header: 'No Telpon', key: 'phone', width: 24 },
    { header: 'NIM', key: 'student_number', width: 22 },
    { header: 'Tahun Masuk', key: 'entry_year', width: 16 },
    { header: 'Fakultas', key: 'faculty', width: 32 },
    { header: 'Jurusan', key: 'study_program', width: 32 },
    { header: 'Email', key: 'email', width: 34 },
    { header: 'Periode Wisuda', key: 'graduation_period', width: 20 },
  ];
  contactsSheet.getRow(1).font = { bold: true };
  contactsSheet.views = [{ state: 'frozen', ySplit: 1 }];
  contactsSheet.getColumn('phone').numFmt = '@';
  contactsSheet.getColumn('student_number').numFmt = '@';
  contactsSheet.autoFilter = 'A1:H1';
  await sendWorkbook(res, workbook, 'template-import-kontak.xlsx');
}));

router.post('/', requirePermission('contacts.manage'), importLimiter, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) { const error = new Error('File Excel wajib diunggah'); error.status = 422; throw error; }
  let importId;
  try {
    const campaign = await getCampaignContext(req, req.body.campaign_public_id);
    const hierarchyGroups = await knex('contact_groups')
      .whereIn('type', ['university', 'faculty', 'study_program'])
      .select('id', 'parent_id', 'type', 'code', 'name', 'status', 'path_key');
    const grouping = resolveSelectedGrouping({
      universityId: campaign?.university_group_id || req.body.university_group_id,
      facultyId: campaign?.faculty_group_id || req.body.faculty_group_id,
      studyProgramId: campaign?.study_program_group_id || req.body.study_program_group_id,
    }, hierarchyGroups);
    if (!grouping.valid) {
      const messages = {
        UNIVERSITY_REQUIRED: 'Universitas wajib dipilih sebelum import',
        UNIVERSITY_NOT_FOUND_OR_INACTIVE: 'Universitas tidak ditemukan atau sudah nonaktif',
        FACULTY_NOT_FOUND_OR_INACTIVE: 'Fakultas tidak ditemukan atau sudah nonaktif',
        FACULTY_UNIVERSITY_MISMATCH: 'Fakultas yang dipilih bukan bagian dari universitas tersebut',
        STUDY_PROGRAM_REQUIRES_FACULTY: 'Program studi membutuhkan fakultas',
        STUDY_PROGRAM_NOT_FOUND_OR_INACTIVE: 'Program studi tidak ditemukan atau sudah nonaktif',
        STUDY_PROGRAM_FACULTY_MISMATCH: 'Program studi bukan bagian dari fakultas tersebut',
      };
      const error = new Error(messages[grouping.errorCode] || 'Pilihan pengelompokan tidak valid');
      error.status = 422;
      error.code = grouping.errorCode;
      throw error;
    }
    await assertXlsxSignature(req.file.path);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) { const error = new Error('Worksheet tidak ditemukan'); error.status = 422; throw error; }

    const headerRow = worksheet.getRow(1);
    const headerValues = Array.from(
      { length: headerRow.cellCount },
      (_, index) => headerRow.getCell(index + 1).text,
    );
    const header = detectImportFormat(headerValues);
    if (!header.valid) {
      const error = new Error('Header Excel harus memakai format 6 kolom lama, 8 kolom identitas, atau 13 kolom lengkap sesuai template');
      error.status = 422;
      error.code = 'INVALID_IMPORT_HEADERS';
      throw error;
    }
    if (header.format === 'legacy' && await campaignRequiresProfileEmail(campaign?.id)) {
      const error = new Error('Campaign ini membutuhkan Email untuk konfirmasi identitas. Gunakan template 8 kolom atau file lengkap 13 kolom');
      error.status = 422;
      error.code = 'CAMPAIGN_EMAIL_REQUIRED';
      throw error;
    }
    const headerIndex = new Map(header.actual.map((value, index) => [value, index + 1]));
    const cellText = (row, label) => {
      const column = headerIndex.get(label);
      return column ? String(row.getCell(column).text || '').trim() : '';
    };

    const rawRows = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const values = header.actual.map((label) => cellText(row, label));
      if (!values.some(Boolean)) return;
      rawRows.push({
        rowNumber,
        name: cellText(row, 'nama'),
        rawPhone: cellText(row, 'no telpon'),
        studentNumber: normalizeStudentNumber(cellText(row, 'nim')),
        entryYear: parseEntryYear(cellText(row, 'tahun masuk')),
        rawFaculty: cellText(row, 'fakultas'),
        rawStudyProgram: cellText(row, 'jurusan'),
        email: normalizeEmail(cellText(row, 'email')),
        rawGraduationPeriod: cellText(row, 'periode wisuda'),
        graduationPeriod: normalizeGraduationPeriod(cellText(row, 'periode wisuda')),
      });
    });
    if (!rawRows.length) { const error = new Error('Tidak ada data kontak setelah baris header'); error.status = 422; throw error; }
    if (rawRows.length > 10000) { const error = new Error('Maksimal 10.000 baris per import'); error.status = 422; throw error; }

    const normalizedCandidates = [];
    for (const row of rawRows) {
      try { normalizedCandidates.push(normalizePhone(row.rawPhone)); } catch (error) { /* ditandai invalid di bawah */ }
    }
    const existingRows = normalizedCandidates.length
      ? await knex('contacts').whereIn('phone_e164', [...new Set(normalizedCandidates)])
        .select('id', 'phone_e164', 'status', 'consent_status', 'wa_registration_status', 'wa_registration_checked_at')
      : [];
    const existing = new Map(existingRows.map((row) => [row.phone_e164, row]));
    const existingProfiles = rawRows.length
      ? await knex('contact_academic_profiles')
        .where({ university_group_id: grouping.university.id })
        .whereIn('student_number', [...new Set(rawRows
          .map((row) => row.studentNumber)
          .filter((value) => value && value.length <= 64))])
        .select('contact_id', 'student_number')
      : [];
    const profileByStudentNumber = new Map(existingProfiles.map((row) => [row.student_number, Number(row.contact_id)]));
    const existingCampaignContactIds = campaign && existingRows.length
      ? new Set((await knex('campaign_contacts')
        .where({ campaign_id: campaign.id })
        .whereIn('contact_id', existingRows.map((row) => row.id))
        .pluck('contact_id')).map(Number))
      : new Set();
    const cacheCutoff = new Date(Date.now() - (env.contactVerificationWorker.cacheTtlSeconds * 1000));
    const cachedRows = normalizedCandidates.length
      ? await knex('contact_import_rows')
        .whereIn('normalized_phone', [...new Set(normalizedCandidates)])
        .whereIn('wa_registration_status', ['registered', 'not_registered'])
        .where('wa_checked_at', '>=', cacheCutoff)
        .select('normalized_phone', 'wa_registration_status', 'wa_checked_at')
        .orderBy('wa_checked_at', 'desc')
      : [];
    const cachedChecks = new Map();
    cachedRows.forEach((row) => {
      if (!cachedChecks.has(row.normalized_phone)) cachedChecks.set(row.normalized_phone, row);
    });
    const seenPhones = new Set();
    const seenStudentNumbers = new Set();
    const previewRows = rawRows.map((row) => {
      const rowGrouping = resolveRowGrouping({
        facultyValue: row.rawFaculty,
        studyProgramValue: row.rawStudyProgram,
        selectedGrouping: grouping,
        groups: hierarchyGroups,
      });
      const groupingFields = {
        groupingStatus: rowGrouping.valid ? 'valid' : 'invalid',
        groupingErrorCode: rowGrouping.errorCode,
        universityGroupId: grouping.university.id,
        facultyGroupId: rowGrouping.faculty?.id || null,
        studyProgramGroupId: rowGrouping.studyProgram?.id || null,
        universityCode: grouping.university.code,
        facultyCode: rowGrouping.faculty?.code || null,
        studyProgramCode: rowGrouping.studyProgram?.code || null,
        universityName: grouping.university.name,
        facultyName: rowGrouping.faculty?.name || row.rawFaculty || null,
        studyProgramName: rowGrouping.studyProgram?.name || row.rawStudyProgram || null,
      };
      const academicError = validateAcademicValues(row)
        || (header.format !== 'legacy' && !isValidEmail(row.email) ? 'INVALID_EMAIL' : null)
        || (header.format !== 'legacy' && !row.graduationPeriod ? 'INVALID_GRADUATION_PERIOD' : null);
      if (academicError || !rowGrouping.valid) {
        return {
          ...row,
          ...groupingFields,
          phone: null,
          status: 'invalid',
          reason: academicError || rowGrouping.errorCode,
          waRegistrationStatus: 'not_applicable',
          waCheckedAt: null,
        };
      }
      try {
        const phone = normalizePhone(row.rawPhone);
        const existingContact = existing.get(phone);
        const profileContactId = profileByStudentNumber.get(row.studentNumber);
        if (profileContactId && Number(existingContact?.id) !== profileContactId) {
          return { ...row, ...groupingFields, phone, status: 'invalid', reason: 'NIM_ALREADY_ASSIGNED', waRegistrationStatus: 'not_applicable' };
        }
        if (existingContact && !campaign) return { ...row, ...groupingFields, phone, status: 'duplicate', reason: 'ALREADY_EXISTS', waRegistrationStatus: 'not_applicable' };
        if (existingContact && existingCampaignContactIds.has(Number(existingContact.id))) {
          return { ...row, ...groupingFields, phone, status: 'duplicate', reason: 'ALREADY_IN_CAMPAIGN', waRegistrationStatus: 'not_applicable' };
        }
        if (seenPhones.has(phone)) return { ...row, ...groupingFields, phone, status: 'duplicate', reason: 'DUPLICATE_PHONE_IN_FILE', waRegistrationStatus: 'not_applicable' };
        if (seenStudentNumbers.has(row.studentNumber)) return { ...row, ...groupingFields, phone, status: 'duplicate', reason: 'DUPLICATE_NIM_IN_FILE', waRegistrationStatus: 'not_applicable' };
        seenPhones.add(phone);
        seenStudentNumbers.add(row.studentNumber);
        const cached = cachedChecks.get(phone);
        const existingRegistration = existingContact?.wa_registration_status === 'registered'
          ? { wa_registration_status: 'registered', wa_checked_at: existingContact.wa_registration_checked_at }
          : null;
        return {
          ...row,
          ...groupingFields,
          phone,
          status: 'valid',
          reason: null,
          waRegistrationStatus: existingRegistration?.wa_registration_status || cached?.wa_registration_status || 'pending',
          waCheckedAt: existingRegistration?.wa_checked_at || cached?.wa_checked_at || null,
        };
      } catch (error) {
        return { ...row, ...groupingFields, phone: null, status: 'invalid', reason: 'INVALID_PHONE', waRegistrationStatus: 'not_applicable' };
      }
    });
    const counts = Object.fromEntries(['valid', 'invalid', 'duplicate'].map((status) => [status, previewRows.filter((row) => row.status === status).length]));
    const verificationCounts = {
      registered: previewRows.filter((row) => row.waRegistrationStatus === 'registered').length,
      not_registered: previewRows.filter((row) => row.waRegistrationStatus === 'not_registered').length,
      pending: previewRows.filter((row) => row.waRegistrationStatus === 'pending').length,
    };
    const verificationStatus = verificationCounts.pending ? 'pending' : 'completed';
    const groupingCounts = {
      valid: previewRows.filter((row) => row.groupingStatus === 'valid').length,
      invalid: previewRows.filter((row) => row.groupingStatus === 'invalid').length,
      not_applicable: previewRows.filter((row) => row.groupingStatus === 'not_applicable').length,
    };

    await knex.transaction(async (trx) => {
      [importId] = await trx('contact_imports').insert({
        campaign_id: campaign?.id || null,
        original_filename: path.basename(req.file.originalname), status: 'previewed',
        verification_status: verificationStatus, total_count: previewRows.length,
        valid_count: counts.valid, invalid_count: counts.invalid, duplicate_count: counts.duplicate,
        created_by: req.session.user.id,
      });
      for (const rows of chunk(previewRows)) {
        await trx('contact_import_rows').insert(rows.map((row) => ({
          contact_import_id: importId,
          row_number: row.rowNumber,
          name: row.name.slice(0, 150) || null,
          raw_phone: row.rawPhone.slice(0, 100) || null,
          normalized_phone: row.phone,
          student_number: row.studentNumber.slice(0, 64) || null,
          entry_year: row.entryYear,
          raw_faculty: row.rawFaculty.slice(0, 150) || null,
          raw_study_program: row.rawStudyProgram.slice(0, 150) || null,
          email: row.email || null,
          graduation_period: row.graduationPeriod || null,
          university_group_id: row.universityGroupId,
          faculty_group_id: row.facultyGroupId,
          study_program_group_id: row.studyProgramGroupId,
          university_code: row.universityCode,
          faculty_code: row.facultyCode,
          study_program_code: row.studyProgramCode,
          university_name_snapshot: row.universityName,
          faculty_name_snapshot: row.facultyName,
          study_program_name_snapshot: row.studyProgramName,
          status: row.status,
          grouping_status: row.groupingStatus,
          grouping_error_code: row.groupingErrorCode,
          reason: row.reason,
          wa_registration_status: row.status === 'valid' ? row.waRegistrationStatus : 'not_applicable',
          wa_check_available_at: row.waRegistrationStatus === 'pending' ? trx.fn.now(3) : null,
          wa_checked_at: row.waCheckedAt,
        })));
      }
    });
    contactVerificationWorker.wake();
    await writeRequestAudit(req, { action: 'contact_import.previewed', entityType: 'contact_import', entityId: String(importId) });
    res.status(201).json({
      success: true,
      data: {
        id: importId,
        campaign_public_id: campaign?.public_id || null,
        status: 'previewed',
        verification_status: verificationStatus,
        total: previewRows.length,
        ...counts,
        verification: {
          registered: verificationCounts.registered,
          not_registered: verificationCounts.not_registered,
          check_failed: 0,
          pending: verificationCounts.pending,
          checking: 0,
          invalid_format: counts.invalid,
          duplicate: counts.duplicate,
          export_valid: previewRows.filter((row) => row.waRegistrationStatus === 'registered').length,
          export_invalid: counts.invalid + verificationCounts.not_registered,
          whatsapp_ready: manager.getStatus().ready,
          worker_running: contactVerificationWorker.getStatus().running,
        },
        grouping: groupingCounts,
      },
    });
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
  }
}));

router.get('/latest', requirePermission('contacts.manage'), asyncHandler(async (req, res) => {
  const campaignPublicId = String(req.query.campaign_public_id || '').trim();
  if (!campaignPublicId) {
    const error = new Error('Campaign wajib dipilih');
    error.status = 422;
    error.code = 'CAMPAIGN_REQUIRED';
    throw error;
  }
  const campaign = await getCampaignContext(req, campaignPublicId, knex, true);
  const record = await knex('contact_imports')
    .where({ campaign_id: campaign.id })
    .orderBy('id', 'desc')
    .first();
  res.set('Cache-Control', 'private, no-store');
  if (!record) return res.json({ success: true, data: null });

  const [verification, grouping] = await Promise.all([
    getVerificationSummary(record.id),
    getGroupingSummary(record.id),
  ]);
  return res.json({
    success: true,
    data: buildRestorableImportState(record, verification, grouping, {
      whatsappReady: manager.getStatus().ready,
      workerRunning: contactVerificationWorker.getStatus().running,
    }),
  });
}));

router.get('/:id/rows', requirePermission('contacts.manage'), asyncHandler(async (req, res) => {
  const record = await knex('contact_imports').where({ id: req.params.id }).first();
  if (!record) { const error = new Error('Import tidak ditemukan'); error.status = 404; throw error; }
  await assertImportAccess(req, record);

  const category = String(req.query.category || 'all').trim();
  if (!IMPORT_PREVIEW_CATEGORIES.includes(category)) {
    const error = new Error('Kategori preview import tidak valid');
    error.status = 422;
    error.code = 'INVALID_IMPORT_PREVIEW_CATEGORY';
    throw error;
  }
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const search = String(req.query.search || '').trim();
  if (search.length > 100) {
    const error = new Error('Pencarian maksimal 100 karakter');
    error.status = 422;
    error.code = 'IMPORT_PREVIEW_SEARCH_TOO_LONG';
    throw error;
  }

  const baseQuery = applyImportPreviewCategory(
    knex('contact_import_rows').where({ contact_import_id: record.id }),
    category,
  );
  if (search) {
    const pattern = `%${search}%`;
    baseQuery.where((builder) => builder
      .where('name', 'like', pattern)
      .orWhere('raw_phone', 'like', pattern)
      .orWhere('normalized_phone', 'like', pattern)
      .orWhere('student_number', 'like', pattern));
  }
  const [{ total }] = await baseQuery.clone().clearSelect().count({ total: '*' });
  const totalCount = Number(total || 0);
  const pages = Math.max(1, Math.ceil(totalCount / limit));
  const safePage = Math.min(page, pages);
  const rows = await baseQuery.clone()
    .select(
      'row_number', 'name', 'raw_phone', 'normalized_phone', 'student_number', 'entry_year',
      'raw_faculty', 'raw_study_program', 'email', 'graduation_period',
      'faculty_name_snapshot', 'study_program_name_snapshot',
      'status', 'reason', 'grouping_status', 'grouping_error_code',
      'wa_registration_status', 'wa_error_code',
    )
    .orderBy('row_number')
    .limit(limit)
    .offset((safePage - 1) * limit);
  res.set('Cache-Control', 'private, no-store');
  res.json({
    success: true,
    data: { category, page: safePage, limit, total: totalCount, pages, rows },
  });
}));

router.get('/:id/export', requirePermission('contacts.manage'), asyncHandler(async (req, res) => {
  const type = req.query.type;
  if (!Object.values(EXPORT_TYPES).includes(type)) {
    const error = new Error('Tipe export tidak valid');
    error.status = 422;
    error.code = 'INVALID_EXPORT_TYPE';
    throw error;
  }
  const record = await knex('contact_imports').where({ id: req.params.id }).first();
  if (!record) { const error = new Error('Import tidak ditemukan'); error.status = 404; throw error; }
  await assertImportAccess(req, record);

  const rows = await applyExportFilter(
    knex('contact_import_rows').where({ contact_import_id: record.id }),
    type,
  ).select(
    'row_number', 'name', 'raw_phone', 'normalized_phone', 'student_number', 'entry_year',
    'raw_faculty', 'raw_study_program', 'email', 'graduation_period', 'status', 'reason',
    'wa_registration_status', 'university_code', 'university_name_snapshot',
    'faculty_code', 'faculty_name_snapshot', 'grouping_status', 'grouping_error_code',
    'study_program_code', 'study_program_name_snapshot',
  )
    .orderBy('row_number');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'WA Service';
  workbook.created = new Date();
  const sheetNames = {
    [EXPORT_TYPES.VALID]: 'Data Valid',
    [EXPORT_TYPES.INVALID]: 'Data Tidak Valid',
    [EXPORT_TYPES.NOT_REGISTERED]: 'Tidak Terdaftar WhatsApp',
    [EXPORT_TYPES.GROUPING_INVALID]: 'Grouping Bermasalah',
  };
  const worksheet = workbook.addWorksheet(sheetNames[type]);
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  worksheet.columns = [
    { header: 'Baris Excel', key: 'row_number', width: 14 },
    { header: 'Nama', key: 'name', width: 30 },
    { header: 'Nomor Input', key: 'raw_phone', width: 24 },
    { header: 'Nomor Normalisasi', key: 'normalized_phone', width: 24 },
    { header: 'NIM', key: 'student_number', width: 22 },
    { header: 'Tahun Masuk', key: 'entry_year', width: 16 },
    { header: 'Fakultas Input', key: 'raw_faculty', width: 30 },
    { header: 'Jurusan Input', key: 'raw_study_program', width: 30 },
    { header: 'Email', key: 'email', width: 34 },
    { header: 'Periode Wisuda', key: 'graduation_period', width: 20 },
    { header: 'Kode Universitas', key: 'university_code', width: 22 },
    { header: 'Nama Universitas', key: 'university_name', width: 30 },
    { header: 'Kode Fakultas', key: 'faculty_code', width: 20 },
    { header: 'Nama Fakultas', key: 'faculty_name', width: 30 },
    { header: 'Kode Program Studi', key: 'study_program_code', width: 22 },
    { header: 'Nama Program Studi', key: 'study_program_name', width: 30 },
    { header: 'Hasil Verifikasi', key: 'verification_result', width: 28 },
    { header: 'Alasan', key: 'reason', width: 28 },
  ];
  worksheet.getRow(1).font = { bold: true };
  rows.forEach((row) => worksheet.addRow({
    row_number: row.row_number,
    name: row.name || '',
    raw_phone: row.raw_phone || '',
    normalized_phone: row.normalized_phone || '',
    student_number: row.student_number || '',
    entry_year: row.entry_year || '',
    raw_faculty: row.raw_faculty || '',
    raw_study_program: row.raw_study_program || '',
    email: row.email || '',
    graduation_period: row.graduation_period || '',
    university_code: row.university_code || '',
    university_name: row.university_name_snapshot || '',
    faculty_code: row.faculty_code || '',
    faculty_name: row.faculty_name_snapshot || '',
    study_program_code: row.study_program_code || '',
    study_program_name: row.study_program_name_snapshot || '',
    verification_result: row.grouping_status === 'invalid'
      ? 'GROUPING_INVALID'
      : row.wa_registration_status === 'registered'
      ? 'TERDAFTAR_WHATSAPP'
      : row.status === 'invalid' ? 'DATA_INVALID' : 'TIDAK_TERDAFTAR_WHATSAPP',
    reason: row.grouping_error_code || row.reason || (row.wa_registration_status === 'not_registered' ? 'NOT_REGISTERED_ON_WHATSAPP' : ''),
  }));
  worksheet.autoFilter = 'A1:R1';

  await writeRequestAudit(req, {
    action: 'contact_import.exported',
    entityType: 'contact_import',
    entityId: String(record.id),
    afterData: { type, row_count: rows.length },
  });
  await sendWorkbook(res, workbook, `contact-import-${record.id}-${type}.xlsx`);
}));

router.get('/:id', requirePermission('contacts.manage'), asyncHandler(async (req, res) => {
  const record = await knex('contact_imports').where({ id: req.params.id }).first();
  if (!record) { const error = new Error('Import tidak ditemukan'); error.status = 404; throw error; }
  await assertImportAccess(req, record);
  let rows = [];
  if (req.query.include_rows !== 'false') {
    const status = ['valid', 'invalid', 'duplicate'].includes(req.query.status) ? req.query.status : null;
    const query = knex('contact_import_rows').where({ contact_import_id: record.id });
    if (status) query.where({ status });
    rows = await query.select(
      'row_number', 'name', 'raw_phone', 'normalized_phone', 'student_number', 'entry_year',
      'raw_faculty', 'raw_study_program', 'email', 'graduation_period', 'status', 'reason',
      'wa_registration_status', 'wa_check_attempts', 'wa_checked_at', 'wa_error_code',
      'university_code', 'university_name_snapshot', 'faculty_code', 'faculty_name_snapshot',
      'study_program_code', 'study_program_name_snapshot',
      'grouping_status', 'grouping_error_code',
    ).orderBy('row_number').limit(1000);
  }
  const verification = await getVerificationSummary(record.id);
  const grouping = await getGroupingSummary(record.id);
  res.json({
    success: true,
    data: {
      ...record,
      rows,
      verification: {
        ...verification,
        whatsapp_ready: manager.getStatus().ready,
        worker_running: contactVerificationWorker.getStatus().running,
      },
      grouping,
    },
  });
}));

router.post('/:id/retry-verification', requirePermission('contacts.manage'), asyncHandler(async (req, res) => {
  const result = await knex.transaction(async (trx) => {
    const record = await trx('contact_imports').where({ id: req.params.id }).forUpdate().first();
    if (!record) { const error = new Error('Import tidak ditemukan'); error.status = 404; throw error; }
    await assertImportAccess(req, record, trx, false);
    await assertLatestCampaignImport(record, trx);
    if (record.status !== 'previewed') { const error = new Error('Import sudah di-commit atau gagal'); error.status = 409; throw error; }
    const retried = await trx('contact_import_rows')
      .where({ contact_import_id: record.id, wa_registration_status: 'check_failed' })
      .update({
        wa_registration_status: 'pending',
        wa_check_attempts: 0,
        wa_check_available_at: trx.fn.now(3),
        wa_checked_at: null,
        wa_error_code: null,
        wa_locked_at: null,
        wa_locked_by: null,
      });
    if (retried) {
      await trx('contact_imports').where({ id: record.id }).update({
        verification_status: 'pending',
        updated_at: trx.fn.now(3),
      });
    }
    return { id: record.id, retried };
  });
  await writeRequestAudit(req, {
    action: 'contact_import.verification_retried',
    entityType: 'contact_import',
    entityId: String(result.id),
    afterData: { retried: result.retried },
  });
  res.json({ success: true, data: result });
}));

router.post('/:id/commit', requirePermission('contacts.manage'), asyncHandler(async (req, res) => {
  const result = await knex.transaction(async (trx) => {
    const record = await trx('contact_imports').where({ id: req.params.id }).forUpdate().first();
    if (!record) { const error = new Error('Import tidak ditemukan'); error.status = 404; throw error; }
    const campaign = await assertImportAccess(req, record, trx, false);
    await assertLatestCampaignImport(record, trx);
    if (record.status !== 'previewed') { const error = new Error('Import sudah diproses atau gagal'); error.status = 409; throw error; }
    if (campaign && await campaignRequiresProfileEmail(campaign.id, trx)) {
      const missingEmail = await trx('contact_import_rows')
        .where({ contact_import_id: record.id })
        .where((builder) => builder.whereNull('email').orWhere('email', ''))
        .first('id');
      if (missingEmail) {
        const error = new Error('Preview lama tidak memiliki Email untuk konfirmasi identitas. Upload ulang memakai template 8 kolom atau file lengkap 13 kolom');
        error.status = 409;
        error.code = 'CAMPAIGN_EMAIL_REQUIRED';
        throw error;
      }
    }
    const verification = await getVerificationSummary(record.id, trx);
    if (!isVerificationFinished(verification)) {
      const error = new Error('Verifikasi WhatsApp belum selesai');
      error.status = 409;
      error.code = 'VERIFICATION_IN_PROGRESS';
      throw error;
    }
    const groupingRows = await trx('contact_import_rows')
      .where({ contact_import_id: record.id })
      .select('grouping_status', 'university_group_id', 'faculty_group_id', 'study_program_group_id')
      .where({ grouping_status: 'valid' })
      .distinct();
    for (const groupingRow of groupingRows) {
      const selectedGroupIds = [groupingRow.university_group_id, groupingRow.faculty_group_id, groupingRow.study_program_group_id].filter(Boolean);
      const selectedGroups = await trx('contact_groups')
        .whereIn('id', selectedGroupIds)
        .select('id', 'parent_id', 'type', 'code', 'name', 'status', 'path_key');
      const grouping = resolveSelectedGrouping({
        universityId: groupingRow.university_group_id,
        facultyId: groupingRow.faculty_group_id,
        studyProgramId: groupingRow.study_program_group_id,
      }, selectedGroups);
      if (!grouping.valid) {
        const error = new Error('Scope akademik pilihan import sudah berubah/nonaktif; aktifkan kembali atau buat preview baru');
        error.status = 409;
        error.code = 'IMPORT_GROUP_SELECTION_CHANGED';
        throw error;
      }
    }
    const rows = await trx('contact_import_rows').where({
      contact_import_id: record.id,
      status: 'valid',
      wa_registration_status: 'registered',
    }).whereIn('grouping_status', ['valid', 'not_applicable']).orderBy('row_number');
    let committed = 0;
    for (const rowsChunk of chunk(rows)) {
      const existingPhones = new Set(await trx('contacts').whereIn('phone_e164', rowsChunk.map((row) => row.normalized_phone)).pluck('phone_e164'));
      const rowsToInsert = rowsChunk.filter((row) => !existingPhones.has(row.normalized_phone));
      await trx('contacts').insert(rowsChunk.map((row) => ({
        name: row.name || `Kontak ${row.normalized_phone}`,
        phone_e164: row.normalized_phone,
        country_code: env.defaultCountryCode,
        wa_registration_status: 'registered',
        wa_registration_checked_at: row.wa_checked_at,
        updated_at: trx.fn.now(3),
        ...buildImportedConsent(trx.fn.now(3)),
      }))).onConflict('phone_e164').merge(['name', 'updated_at']);
      committed += rowsToInsert.length;
    }
    const committedContacts = rows.length
      ? await trx('contacts').whereIn('phone_e164', rows.map((row) => row.normalized_phone)).select('id', 'phone_e164')
      : [];
    const contactIdByPhone = new Map(committedContacts.map((contact) => [contact.phone_e164, contact.id]));
    if (rows.length) {
      const profileConflicts = await trx('contact_academic_profiles')
        .where({ university_group_id: rows[0].university_group_id })
        .whereIn('student_number', rows.map((row) => row.student_number))
        .select('contact_id', 'student_number')
        .forUpdate();
      const conflict = profileConflicts.find((profile) => {
        const importRow = rows.find((row) => row.student_number === profile.student_number);
        return Number(profile.contact_id) !== Number(contactIdByPhone.get(importRow.normalized_phone));
      });
      if (conflict) {
        const error = new Error('NIM sudah terhubung ke kontak lain; buat preview baru setelah data dikoreksi');
        error.status = 409;
        error.code = 'NIM_ALREADY_ASSIGNED';
        throw error;
      }

      for (const rowsChunk of chunk(rows)) {
        const hasProfileDetails = rowsChunk.some((row) => row.email || row.graduation_period);
        const profiles = rowsChunk.map((row) => ({
          contact_id: contactIdByPhone.get(row.normalized_phone),
          university_group_id: row.university_group_id,
          faculty_group_id: row.faculty_group_id,
          study_program_group_id: row.study_program_group_id,
          student_number: row.student_number,
          entry_year: row.entry_year,
          email: row.email,
          graduation_period: row.graduation_period,
          updated_at: trx.fn.now(3),
        }));
        await trx('contact_academic_profiles').insert(profiles)
          .onConflict(['contact_id', 'university_group_id'])
          .merge([
            'faculty_group_id', 'study_program_group_id', 'student_number', 'entry_year',
            ...(hasProfileDetails ? ['email', 'graduation_period'] : []),
            'updated_at',
          ]);
      }
    }
    const membershipKeys = new Set();
    const memberships = [];
    rows.forEach((row) => {
      const groupId = row.study_program_group_id || row.faculty_group_id || row.university_group_id;
      const contactId = contactIdByPhone.get(row.normalized_phone);
      if (!groupId || !contactId) return;
      const key = `${groupId}:${contactId}`;
      if (membershipKeys.has(key)) return;
      membershipKeys.add(key);
      memberships.push({ contact_group_id: groupId, contact_id: contactId });
    });
    if (memberships.length) {
      await trx('contact_group_members').insert(memberships)
        .onConflict(['contact_group_id', 'contact_id']).ignore();
    }
    let campaignMembershipsActive = 0;
    let campaignMembershipsExcluded = 0;
    if (campaign && committedContacts.length) {
      const contactsForCampaign = await trx('contacts')
        .whereIn('id', committedContacts.map((contact) => contact.id))
        .select('id', 'status', 'consent_status');
      const campaignMemberships = contactsForCampaign.map((contact) => {
        const eligible = contact.status === 'active' && contact.consent_status === 'granted';
        if (eligible) campaignMembershipsActive += 1;
        else campaignMembershipsExcluded += 1;
        return {
          campaign_id: campaign.id,
          contact_id: contact.id,
          source_import_id: record.id,
          status: eligible ? 'active' : 'excluded',
          exclusion_reason: eligible
            ? null
            : (contact.status === 'active' ? 'CONSENT_REQUIRED' : `CONTACT_${contact.status.toUpperCase()}`),
          added_by: req.session.user.id,
          excluded_at: eligible ? null : trx.fn.now(3),
        };
      });
      if (campaignMemberships.length) {
        await trx('campaign_contacts').insert(campaignMemberships)
          .onConflict(['campaign_id', 'contact_id']).ignore();
      }
    }
    await trx('contact_imports').where({ id: record.id }).update({ status: 'committed', updated_at: trx.fn.now(3) });
    return {
      id: record.id,
      status: 'committed',
      attempted: rows.length,
      committed,
      excluded_not_registered: verification.not_registered,
      excluded_invalid_format: verification.invalid_format,
      excluded_check_failed: verification.check_failed,
      excluded_grouping_invalid: (await getGroupingSummary(record.id, trx)).invalid,
      memberships_added: memberships.length,
      campaign_memberships_active: campaignMembershipsActive,
      campaign_memberships_excluded: campaignMembershipsExcluded,
    };
  });
  await writeRequestAudit(req, { action: 'contact_import.committed', entityType: 'contact_import', entityId: String(result.id), afterData: { committed: result.committed } });
  res.json({
    success: true,
    data: result,
    meta: {
      consent_status: IMPORTED_CONTACT_CONSENT.status,
      consent_source: IMPORTED_CONTACT_CONSENT.source,
      note: 'Consent granted diterapkan berdasarkan konfirmasi admin saat commit import.',
    },
  });
}));

module.exports = router;
