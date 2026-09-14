const assert = require('node:assert/strict');
const test = require('node:test');
const { CRITICAL_TABLES } = require('../scripts/lib/cutover-audit');
const {
  COPY_CONFIRMATION,
  COPY_ORDER,
  assertCommitAllowed,
  assertCopyOrder,
  parseMode,
  transformRow,
  transformValue,
} = require('../scripts/supabase-copy-data');

test('copy order contains all 38 application tables once', () => {
  assert.doesNotThrow(() => assertCopyOrder());
  assert.equal(COPY_ORDER.length, CRITICAL_TABLES.length);
  assert.throws(() => assertCopyOrder([...COPY_ORDER, 'contacts']), /COPY_ORDER_DUPLICATE_TABLE/);
});

test('copy order places parent tables before dependent data', () => {
  const before = (parent, child) => assert.ok(COPY_ORDER.indexOf(parent) < COPY_ORDER.indexOf(child), `${parent} -> ${child}`);
  before('users', 'campaigns');
  before('contact_groups', 'campaigns');
  before('campaigns', 'contact_imports');
  before('contact_imports', 'campaign_contacts');
  before('broadcasts', 'messages');
  before('messages', 'broadcast_recipients');
  before('campaign_questions', 'campaign_contact_progress');
  before('incoming_messages', 'campaign_incoming_messages');
});

test('mode defaults to dry-run and rejects unknown arguments', () => {
  assert.equal(parseMode([]), 'dry_run');
  assert.equal(parseMode(['--commit']), 'commit');
  assert.throws(() => parseMode(['--force']), /Argument tidak dikenal/);
});

test('commit requires write-freeze and an exact explicit confirmation', () => {
  assert.doesNotThrow(() => assertCommitAllowed('dry_run', {}));
  assert.throws(() => assertCommitAllowed('commit', {}), /CUTOVER_WRITES_FROZEN/);
  assert.throws(
    () => assertCommitAllowed('commit', { CUTOVER_WRITES_FROZEN: 'true' }),
    /CUTOVER_COPY_CONFIRM/,
  );
  assert.doesNotThrow(() => assertCommitAllowed('commit', {
    CUTOVER_WRITES_FROZEN: 'true',
    CUTOVER_COPY_CONFIRM: COPY_CONFIRMATION,
  }));
});

test('MySQL booleans and JSON are converted to PostgreSQL-native values', () => {
  assert.equal(transformValue(1, { data_type: 'boolean', column_name: 'enabled' }), true);
  assert.equal(transformValue('0', { data_type: 'boolean', column_name: 'enabled' }), false);
  assert.equal(
    transformValue('{"fields":["email"]}', { data_type: 'jsonb', column_name: 'review_fields' }),
    '{"fields":["email"]}',
  );
  assert.equal(
    transformValue(['nama', 'email'], { data_type: 'jsonb', column_name: 'review_fields' }),
    '["nama","email"]',
  );
  assert.throws(
    () => transformValue('not-json', { data_type: 'jsonb', column_name: 'metadata' }, { table: 'audit_logs' }),
    /INVALID_JSON/,
  );
});

test('self references are deferred without discarding their values', () => {
  const deferred = [];
  const row = transformRow('contact_groups', { id: 2, parent_id: 1, name: 'FIKOM' }, [
    { column_name: 'id', data_type: 'bigint' },
    { column_name: 'parent_id', data_type: 'bigint' },
    { column_name: 'name', data_type: 'character varying' },
  ], deferred);
  assert.deepEqual(row, { id: 2, parent_id: null, name: 'FIKOM' });
  assert.deepEqual(deferred, [{ table: 'contact_groups', id: 2, column: 'parent_id', value: 1 }]);
});
