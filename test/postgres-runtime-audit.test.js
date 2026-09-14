const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { auditRuntime, summarize } = require('../scripts/postgres-runtime-audit');

test('audit runtime mendeteksi blocker MySQL tanpa menampilkan isi secret', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-postgres-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'sample.js'), `
    const store = require('express-mysql-session');
    const db = knex({ client: 'mysql2' });
    const [id] = await db('items').insert({ name: 'aman' });
    db.raw('DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)', [7]);
  `);

  const findings = auditRuntime(root);
  const counts = summarize(findings);

  assert.equal(counts.HARDCODED_MYSQL_CLIENT, 1);
  assert.equal(counts.MYSQL_SESSION_STORE, 1);
  assert.equal(counts.MYSQL_SQL_DIALECT, 1);
  assert.equal(counts.MYSQL_INSERT_RESULT, 1);
  assert.equal(JSON.stringify(findings).includes('password'), false);
});

test('audit runtime lulus untuk source PostgreSQL yang bersih', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-postgres-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'sample.js'), `
    const db = knex({ client: 'pg' });
    const [{ id }] = await db('items').insert({ name: 'aman' }).returning('id');
  `);

  assert.deepEqual(auditRuntime(root), []);
});

test('audit mengabaikan migration MySQL historis yang sudah direkam oleh baseline', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-postgres-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const migrationRoot = path.join(root, 'src', 'database', 'migrations');
  fs.mkdirSync(migrationRoot, { recursive: true });
  fs.writeFileSync(path.join(migrationRoot, 'legacy.js'), "knex.raw('UTC_TIMESTAMP()')");

  assert.deepEqual(auditRuntime(root), []);
});
