#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const knexFactory = require('knex');
const { CRITICAL_TABLES } = require('./lib/cutover-audit');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const BASELINE_PATH = path.resolve(__dirname, '../supabase/baseline.sql');
const MIGRATION_DIRECTORY = path.resolve(__dirname, '../src/database/migrations');
const EXPECTED_FOREIGN_KEYS = 72;
const EXPECTED_SECONDARY_INDEXES = 124;

function targetConnection() {
  const connectionString = process.env.CUTOVER_TARGET_DATABASE_URL;
  if (!connectionString) throw new Error('CUTOVER_TARGET_DATABASE_URL wajib diisi melalui environment lokal');

  const parsed = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('CUTOVER_TARGET_DATABASE_URL harus memakai protokol PostgreSQL');
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) throw new Error('Nama database target tidak ditemukan pada connection string');

  const ssl = { rejectUnauthorized: true };
  if (process.env.CUTOVER_TARGET_SSL_CA_PATH) {
    ssl.ca = fs.readFileSync(path.resolve(process.env.CUTOVER_TARGET_SSL_CA_PATH), 'utf8');
  }

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    ssl,
  };
}

function migrationNames() {
  return fs.readdirSync(MIGRATION_DIRECTORY)
    .filter((name) => name.endsWith('.js'))
    .sort();
}

function assertTargetEmpty(relations) {
  if (!relations.length) return;
  const names = relations.map((relation) => relation.name).sort();
  throw new Error(`TARGET_SCHEMA_NOT_EMPTY: public memiliki relation: ${names.join(', ')}`);
}

function assertExactCount(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected=${expected}, actual=${actual}`);
  }
}

async function publicRelations(transaction) {
  const result = await transaction.raw(`
    SELECT c.relname AS name, c.relkind AS kind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    ORDER BY c.relname
  `);
  return result.rows;
}

async function verifyBaseline(transaction, migrations) {
  const tables = await transaction('information_schema.tables')
    .select('table_name')
    .where({ table_schema: 'public', table_type: 'BASE TABLE' });
  const tableNames = new Set(tables.map((row) => row.table_name));
  const missingTables = CRITICAL_TABLES.filter((table) => !tableNames.has(table));
  if (missingTables.length) throw new Error(`BASELINE_TABLES_MISSING: ${missingTables.join(', ')}`);

  assertExactCount('APPLICATION_TABLE_COUNT', CRITICAL_TABLES.filter((table) => tableNames.has(table)).length, CRITICAL_TABLES.length);
  assertExactCount('FRAMEWORK_TABLE_COUNT', ['knex_migrations', 'knex_migrations_lock'].filter((table) => tableNames.has(table)).length, 2);

  const foreignKeysResult = await transaction.raw(`
    SELECT COUNT(*)::integer AS count
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = ANY(?::text[])
      AND constraint_type = 'FOREIGN KEY'
  `, [CRITICAL_TABLES]);
  assertExactCount('FOREIGN_KEY_COUNT', foreignKeysResult.rows[0].count, EXPECTED_FOREIGN_KEYS);

  const indexesResult = await transaction.raw(`
    SELECT COUNT(*)::integer AS count
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = ANY(?::text[])
      AND NOT i.indisprimary
  `, [CRITICAL_TABLES]);
  assertExactCount('SECONDARY_INDEX_COUNT', indexesResult.rows[0].count, EXPECTED_SECONDARY_INDEXES);

  const rlsResult = await transaction.raw(`
    SELECT COUNT(*)::integer AS count
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = ANY(?::text[])
      AND c.relrowsecurity = TRUE
  `, [CRITICAL_TABLES]);
  assertExactCount('RLS_TABLE_COUNT', rlsResult.rows[0].count, CRITICAL_TABLES.length);

  const migrationCount = await transaction('knex_migrations').count('* AS count').first();
  assertExactCount('MIGRATION_HISTORY_COUNT', Number(migrationCount.count), migrations.length);

  return {
    application_tables: CRITICAL_TABLES.length,
    framework_tables: 2,
    foreign_keys: foreignKeysResult.rows[0].count,
    secondary_indexes: indexesResult.rows[0].count,
    rls_enabled_tables: rlsResult.rows[0].count,
    migration_history_rows: Number(migrationCount.count),
  };
}

async function main() {
  const baselineSql = fs.readFileSync(BASELINE_PATH, 'utf8');
  const migrations = migrationNames();
  const targetDatabase = knexFactory({
    client: 'pg',
    connection: targetConnection(),
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: 10000,
  });

  try {
    const verification = await targetDatabase.transaction(async (transaction) => {
      await transaction.raw("SELECT set_config('statement_timeout', ?, true)", ['120s']);
      await transaction.raw("SELECT set_config('lock_timeout', ?, true)", ['10s']);
      await transaction.raw('SELECT pg_advisory_xact_lock(?)', [90820260901]);

      assertTargetEmpty(await publicRelations(transaction));
      await transaction.raw(baselineSql);

      const migrationTime = new Date();
      await transaction('knex_migrations').insert(migrations.map((name) => ({
        name,
        batch: 1,
        migration_time: migrationTime,
      })));

      return verifyBaseline(transaction, migrations);
    });

    process.stdout.write(`${JSON.stringify({
      status: 'schema_applied',
      target: 'supabase_postgresql',
      transaction: 'committed',
      data_copied: false,
      runtime_switched: false,
      verification,
    }, null, 2)}\n`);
  } finally {
    await targetDatabase.destroy();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertExactCount,
  assertTargetEmpty,
  migrationNames,
  targetConnection,
};
