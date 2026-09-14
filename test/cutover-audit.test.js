const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assessSourceReadiness,
  compareSnapshots,
  distributionsMatch,
} = require('../scripts/lib/cutover-audit');

function snapshot(overrides = {}) {
  return {
    missing_tables: [],
    table_counts: {},
    status_counts: {},
    integrity: {},
    ...overrides,
  };
}

test('preflight menolak cutover ketika job outbound masih berjalan', () => {
  const result = assessSourceReadiness(snapshot({
    operational: {
      contact_verification_claimable_pending: 0,
      contact_verification_checking: 0,
    },
    status_counts: {
      message_jobs: { status: { pending: 2, reserved: 1, processing: 1 } },
    },
  }), [], { writesFrozen: true });
  assert.equal(result.ready_for_final_copy, false);
  assert.deepEqual(result.blockers.map((item) => item.code), [
    'OUTBOUND_IN_FLIGHT',
    'OUTBOUND_QUEUE_PENDING',
  ]);
});

test('preflight mengabaikan pending verifikasi historis yang tidak lagi claimable', () => {
  const result = assessSourceReadiness(snapshot({
    operational: {
      contact_verification_claimable_pending: 0,
      contact_verification_checking: 0,
    },
    status_counts: {
      contact_import_rows: { wa_registration_status: { pending: 770 } },
    },
  }), [], { writesFrozen: true });
  assert.equal(result.ready_for_final_copy, true);
  assert.equal(result.warnings[0].code, 'HISTORICAL_CONTACT_VERIFICATION_PENDING');
  assert.equal(result.observed.historical_contact_verification_pending, 770);
});

test('preflight menolak source schema yang belum lengkap', () => {
  const result = assessSourceReadiness(
    snapshot({ missing_tables: ['message_jobs'] }),
    [],
    { writesFrozen: true },
  );
  assert.equal(result.ready_for_final_copy, false);
  assert.equal(result.blockers[0].code, 'SOURCE_SCHEMA_INCOMPLETE');
});

test('campaign aktif menjadi warning jika queue sudah tenang', () => {
  const result = assessSourceReadiness(snapshot({
    status_counts: {
      campaigns: { status: { active: 1 } },
      campaign_contact_progress: { status: { in_progress: 3, completed: 2 } },
    },
  }), [], { writesFrozen: true });
  assert.equal(result.ready_for_final_copy, true);
  assert.equal(result.warnings[0].code, 'CAMPAIGN_STATE_MUST_BE_MIGRATED');
  assert.equal(result.warnings[0].unfinished_progress, 3);
});

test('preflight tanpa write-freeze hanya menyatakan siap masuk maintenance window', () => {
  const result = assessSourceReadiness(snapshot());
  assert.equal(result.ready_for_maintenance_window, true);
  assert.equal(result.ready_for_final_copy, false);
  assert.equal(result.blockers[0].code, 'WRITE_FREEZE_NOT_CONFIRMED');
});

test('validator mendeteksi perbedaan jumlah dan distribusi status', () => {
  const source = snapshot({
    table_counts: { messages: 3 },
    status_counts: { messages: { status: { queued: 1, sent: 2 } } },
  });
  const target = snapshot({
    table_counts: { messages: 2 },
    status_counts: { messages: { status: { sent: 2 } } },
  });
  const result = compareSnapshots(source, target);
  assert.equal(result.matches, false);
  assert.ok(result.differences.some((item) => item.type === 'row_count' && item.table === 'messages'));
  assert.ok(result.differences.some((item) => item.type === 'status_distribution' && item.table === 'messages'));
});

test('validator lulus ketika snapshot source dan target sama', () => {
  const source = snapshot();
  const target = snapshot();
  assert.equal(compareSnapshots(source, target).matches, true);
});

test('validator mengabaikan perbedaan urutan key distribusi antar-engine', () => {
  assert.equal(
    distributionsMatch(
      { unknown: 2, registered: 15 },
      { registered: '15', unknown: '2' },
    ),
    true,
  );
});
