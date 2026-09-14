const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_STORE = 'memory';

const {
  EXPORT_TYPES,
  IMPORT_PREVIEW_CATEGORIES,
  applyExportFilter,
  applyImportPreviewCategory,
  buildRestorableImportState,
  getFinalVerificationStatus,
  summarizeGroupedRows,
} = require('../src/modules/contact-imports/contact-verification');
const knex = require('../src/database/knex');
const { manager, STATES } = require('../src/modules/whatsapp/whatsapp-client-manager');
const contactVerificationWorker = require('../src/modules/contact-imports/contact-verification-worker');

test('ringkasan verifikasi memisahkan hasil WA, format invalid, duplikat, dan error teknis', () => {
  const summary = summarizeGroupedRows([
    { status: 'valid', wa_registration_status: 'registered', count: '3' },
    { status: 'valid', wa_registration_status: 'registered', grouping_status: 'invalid', count: '1' },
    { status: 'valid', wa_registration_status: 'not_registered', count: '2' },
    { status: 'valid', wa_registration_status: 'check_failed', count: '1' },
    { status: 'invalid', wa_registration_status: 'not_applicable', count: '4' },
    { status: 'duplicate', wa_registration_status: 'not_applicable', count: '5' },
  ]);

  assert.equal(summary.export_valid, 3);
  assert.equal(summary.registered, 4);
  assert.equal(summary.export_invalid, 6);
  assert.equal(summary.check_failed, 1);
  assert.equal(summary.duplicate, 5);
  assert.equal(getFinalVerificationStatus(summary), 'completed_with_errors');
});

test('status verifikasi masih running selama ada nomor pending atau checking', () => {
  const summary = summarizeGroupedRows([
    { status: 'valid', wa_registration_status: 'pending', count: 1 },
    { status: 'valid', wa_registration_status: 'checking', count: 1 },
  ]);
  assert.equal(getFinalVerificationStatus(summary), 'running');
});

test('kategori preview import memiliki filter server-side yang tervalidasi', () => {
  assert.deepEqual(IMPORT_PREVIEW_CATEGORIES, [
    'all', 'registered', 'not_registered', 'invalid', 'duplicate', 'pending', 'check_failed',
  ]);
  assert.equal(applyImportPreviewCategory(knex('contact_import_rows'), 'all').toSQL().bindings.length, 0);
  const registered = applyImportPreviewCategory(knex('contact_import_rows'), 'registered').toSQL();
  assert.match(registered.sql, /wa_registration_status/);
  assert.ok(registered.bindings.includes('registered'));
  assert.throws(
    () => applyImportPreviewCategory(knex('contact_import_rows'), 'unknown'),
    /Kategori preview import tidak valid/,
  );
});

test('export tidak terdaftar hanya memilih nomor valid berstatus not_registered', () => {
  assert.equal(EXPORT_TYPES.NOT_REGISTERED, 'not_registered');
  const query = applyExportFilter(knex('contact_import_rows'), EXPORT_TYPES.NOT_REGISTERED).toSQL();
  assert.ok(query.bindings.includes('valid'));
  assert.ok(query.bindings.includes('not_registered'));
  assert.equal(query.bindings.includes('invalid'), false);
});

test('state import yang dipulihkan hanya membawa metadata aman dan ringkasan proses', () => {
  const state = buildRestorableImportState({
    id: 42,
    campaign_id: 9,
    original_filename: 'batch-1.xlsx',
    status: 'previewed',
    verification_status: 'running',
    total_count: '10',
    valid_count: '9',
    invalid_count: '1',
    duplicate_count: '0',
    created_by: 7,
    error_summary: { private: true },
    created_at: '2026-08-30T12:00:00.000Z',
    updated_at: '2026-08-30T12:01:00.000Z',
  }, { registered: 4, pending: 5 }, { valid: 9, invalid: 1 }, {
    whatsappReady: true,
    workerRunning: true,
  });

  assert.equal(state.total_count, 10);
  assert.equal(state.verification.whatsapp_ready, true);
  assert.equal(state.grouping.invalid, 1);
  assert.equal(Object.hasOwn(state, 'created_by'), false);
  assert.equal(Object.hasOwn(state, 'campaign_id'), false);
  assert.equal(Object.hasOwn(state, 'error_summary'), false);
});

test('manager mengecek nomor dalam format digit melalui client WhatsApp yang ready', async () => {
  const previousState = manager.state;
  const previousClient = manager.client;
  let checkedNumber;
  manager.state = STATES.READY;
  manager.client = {
    getNumberId: async (number) => {
      checkedNumber = number;
      return { user: number };
    },
  };
  try {
    assert.equal(await manager.checkNumberRegistered('+62 812-3456-7890'), true);
    assert.equal(checkedNumber, '6281234567890');
  } finally {
    manager.state = previousState;
    manager.client = previousClient;
  }
});

test('worker verifikasi tidak mengklaim row ketika WhatsApp belum ready', async () => {
  assert.equal(await contactVerificationWorker.claim(), null);
});

test('worker verifikasi dapat dibangunkan kembali tanpa membuat scheduler paralel', () => {
  contactVerificationWorker.stop();
  contactVerificationWorker.start();
  assert.equal(contactVerificationWorker.getStatus().running, true);
  assert.equal(contactVerificationWorker.getStatus().scheduled, true);
  assert.equal(contactVerificationWorker.wake(), true);
  assert.equal(contactVerificationWorker.getStatus().scheduled, true);
  contactVerificationWorker.stop();
  assert.equal(contactVerificationWorker.getStatus().running, false);
  assert.equal(contactVerificationWorker.getStatus().scheduled, false);
});
