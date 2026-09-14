const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { CRITICAL_TABLES } = require('../scripts/lib/cutover-audit');
const {
  assertExactCount,
  assertTargetEmpty,
  migrationNames,
} = require('../scripts/supabase-apply-baseline');

const baseline = fs.readFileSync(path.resolve(__dirname, '../supabase/baseline.sql'), 'utf8');

test('baseline defines all 38 application tables exactly once', () => {
  for (const table of CRITICAL_TABLES) {
    const matches = baseline.match(new RegExp(`CREATE TABLE public\\.${table} \\(`, 'g')) || [];
    assert.equal(matches.length, 1, table);
  }
  assert.equal(CRITICAL_TABLES.length, 38);
});

test('baseline enables RLS for every application table', () => {
  for (const table of CRITICAL_TABLES) {
    assert.match(baseline, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`));
  }
});

test('baseline has final FK and secondary-index inventory', () => {
  assert.equal((baseline.match(/ADD CONSTRAINT .* FOREIGN KEY/g) || []).length, 72);
  assert.equal((baseline.match(/^CREATE (?:UNIQUE )?INDEX /gm) || []).length, 124);
});

test('baseline avoids MySQL-only column types', () => {
  assert.doesNotMatch(baseline, /\b(?:TINYINT|MEDIUMTEXT|LONGTEXT|UNSIGNED|ENUM\s*\()/i);
  assert.match(baseline, /TIMESTAMPTZ\(3\)/);
  assert.match(baseline, /JSONB/);
});

test('target-empty guard refuses any existing public relation', () => {
  assert.doesNotThrow(() => assertTargetEmpty([]));
  assert.throws(
    () => assertTargetEmpty([{ name: 'contacts', kind: 'r' }]),
    /TARGET_SCHEMA_NOT_EMPTY.*contacts/,
  );
});

test('exact-count guard fails closed', () => {
  assert.doesNotThrow(() => assertExactCount('TABLES', 38, 38));
  assert.throws(() => assertExactCount('TABLES', 37, 38), /expected=38, actual=37/);
});

test('baseline records every existing migration filename', () => {
  const names = migrationNames();
  assert.equal(names.length, 26);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((name) => /^\d+_.+\.js$/.test(name)));
});
