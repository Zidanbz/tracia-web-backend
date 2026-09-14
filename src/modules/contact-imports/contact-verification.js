const knex = require('../../database/knex');

const EXPORT_TYPES = Object.freeze({
  VALID: 'valid',
  INVALID: 'invalid',
  NOT_REGISTERED: 'not_registered',
  GROUPING_INVALID: 'grouping_invalid',
});

const IMPORT_PREVIEW_CATEGORIES = Object.freeze([
  'all',
  'registered',
  'not_registered',
  'invalid',
  'duplicate',
  'pending',
  'check_failed',
]);

function applyImportPreviewCategory(query, category) {
  if (!IMPORT_PREVIEW_CATEGORIES.includes(category)) {
    const error = new Error('Kategori preview import tidak valid');
    error.status = 422;
    error.code = 'INVALID_IMPORT_PREVIEW_CATEGORY';
    throw error;
  }
  if (category === 'all') return query;
  if (category === 'registered') {
    return query
      .where({ status: 'valid', wa_registration_status: 'registered' })
      .whereIn('grouping_status', ['valid', 'not_applicable']);
  }
  if (category === 'not_registered') {
    return query.where({ status: 'valid', wa_registration_status: 'not_registered' });
  }
  if (category === 'invalid') {
    return query.where((builder) => builder.where({ status: 'invalid' }).orWhere({ grouping_status: 'invalid' }));
  }
  if (category === 'duplicate') return query.where({ status: 'duplicate' });
  if (category === 'pending') {
    return query.where({ status: 'valid' }).whereIn('wa_registration_status', ['pending', 'checking']);
  }
  return query.where({ status: 'valid', wa_registration_status: 'check_failed' });
}

function createEmptySummary() {
  return {
    registered: 0,
    not_registered: 0,
    check_failed: 0,
    pending: 0,
    checking: 0,
    invalid_format: 0,
    duplicate: 0,
    export_valid: 0,
    export_invalid: 0,
  };
}

function summarizeGroupedRows(groupedRows) {
  const summary = createEmptySummary();
  for (const row of groupedRows) {
    const count = Number(row.count || 0);
    if (row.status === 'invalid') summary.invalid_format += count;
    if (row.status === 'duplicate') summary.duplicate += count;
    if (Object.hasOwn(summary, row.wa_registration_status)) {
      summary[row.wa_registration_status] += count;
    }
    if (row.wa_registration_status === 'registered' && row.grouping_status !== 'invalid') {
      summary.export_valid += count;
    }
  }
  summary.export_invalid = summary.not_registered + summary.invalid_format;
  return summary;
}

async function getVerificationSummary(importId, database = knex) {
  const groupedRows = await database('contact_import_rows')
    .where({ contact_import_id: importId })
    .select('status', 'wa_registration_status', 'grouping_status')
    .count({ count: '*' })
    .groupBy('status', 'wa_registration_status', 'grouping_status');
  return summarizeGroupedRows(groupedRows);
}

function isVerificationFinished(summary) {
  return summary.pending === 0 && summary.checking === 0;
}

function buildRestorableImportState(record, verification, grouping, runtime = {}) {
  if (!record) return null;
  return {
    id: record.id,
    original_filename: record.original_filename,
    status: record.status,
    verification_status: record.verification_status,
    total_count: Number(record.total_count || 0),
    valid_count: Number(record.valid_count || 0),
    invalid_count: Number(record.invalid_count || 0),
    duplicate_count: Number(record.duplicate_count || 0),
    created_at: record.created_at,
    updated_at: record.updated_at,
    verification: {
      ...verification,
      whatsapp_ready: Boolean(runtime.whatsappReady),
      worker_running: Boolean(runtime.workerRunning),
    },
    grouping,
  };
}

function getFinalVerificationStatus(summary) {
  if (!isVerificationFinished(summary)) return 'running';
  return summary.check_failed > 0 ? 'completed_with_errors' : 'completed';
}

async function refreshImportVerificationStatus(importId, database = knex) {
  const summary = await getVerificationSummary(importId, database);
  const verificationStatus = getFinalVerificationStatus(summary);
  await database('contact_imports').where({ id: importId }).update({
    verification_status: verificationStatus,
    updated_at: database.fn.now(3),
  });
  return { verification_status: verificationStatus, ...summary };
}

function applyExportFilter(query, type) {
  if (type === EXPORT_TYPES.VALID) {
    return query
      .where({ status: 'valid', wa_registration_status: 'registered' })
      .whereIn('grouping_status', ['valid', 'not_applicable']);
  }
  if (type === EXPORT_TYPES.INVALID) {
    return query.where((builder) => builder
      .where({ status: 'invalid' })
      .orWhere({ status: 'valid', wa_registration_status: 'not_registered' }));
  }
  if (type === EXPORT_TYPES.NOT_REGISTERED) {
    return query.where({ status: 'valid', wa_registration_status: 'not_registered' });
  }
  if (type === EXPORT_TYPES.GROUPING_INVALID) {
    return query.where({ grouping_status: 'invalid' });
  }
  const error = new Error('Tipe export tidak valid');
  error.status = 422;
  error.code = 'INVALID_EXPORT_TYPE';
  throw error;
}

module.exports = {
  EXPORT_TYPES,
  IMPORT_PREVIEW_CATEGORIES,
  applyExportFilter,
  applyImportPreviewCategory,
  buildRestorableImportState,
  getFinalVerificationStatus,
  getVerificationSummary,
  isVerificationFinished,
  refreshImportVerificationStatus,
  summarizeGroupedRows,
};
