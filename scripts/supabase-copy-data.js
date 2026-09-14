#!/usr/bin/env node

const path = require('path');
const knexFactory = require('knex');
const sourceDatabase = require('../src/database/knex');
const {
  CRITICAL_TABLES,
  assessSourceReadiness,
  collectDatabaseSnapshot,
  compareSnapshots,
} = require('./lib/cutover-audit');
const { targetConnection } = require('./supabase-apply-baseline');

const COPY_CONFIRMATION = 'COPY_TO_SUPABASE';
const CHUNK_SIZE = 500;
const DRY_RUN_ROLLBACK = Symbol('DRY_RUN_ROLLBACK');

const COPY_ORDER = Object.freeze([
  'roles',
  'permissions',
  'users',
  'role_permissions',
  'user_roles',
  'sessions',
  'login_attempts',
  'password_reset_tokens',
  'audit_logs',
  'whatsapp_accounts',
  'whatsapp_connection_events',
  'contacts',
  'contact_groups',
  'contact_group_members',
  'campaigns',
  'contact_imports',
  'contact_import_rows',
  'contact_academic_profiles',
  'media_assets',
  'message_templates',
  'broadcasts',
  'messages',
  'broadcast_recipients',
  'message_events',
  'message_jobs',
  'incoming_messages',
  'api_keys',
  'webhooks',
  'webhook_deliveries',
  'api_request_logs',
  'qa_session_questions',
  'campaign_contacts',
  'campaign_questionnaires',
  'campaign_questions',
  'campaign_question_options',
  'campaign_contact_progress',
  'campaign_incoming_messages',
  'application_settings',
]);

const DEFERRED_SELF_REFERENCES = Object.freeze({
  contact_groups: ['parent_id'],
  campaign_questions: ['next_question_id'],
});

function parseMode(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== '--commit');
  if (unknown.length) throw new Error(`Argument tidak dikenal: ${unknown.join(', ')}`);
  return argv.includes('--commit') ? 'commit' : 'dry_run';
}

function assertCopyOrder(copyOrder = COPY_ORDER) {
  const expected = new Set(CRITICAL_TABLES);
  const actual = new Set(copyOrder);
  if (actual.size !== copyOrder.length) throw new Error('COPY_ORDER_DUPLICATE_TABLE');
  const missing = CRITICAL_TABLES.filter((table) => !actual.has(table));
  const extra = copyOrder.filter((table) => !expected.has(table));
  if (missing.length || extra.length) {
    throw new Error(`COPY_ORDER_MISMATCH: missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`);
  }
}

function assertCommitAllowed(mode, env = process.env) {
  if (mode !== 'commit') return;
  if (env.CUTOVER_WRITES_FROZEN !== 'true') {
    throw new Error('FINAL_COPY_BLOCKED: CUTOVER_WRITES_FROZEN harus true setelah seluruh writer benar-benar dihentikan');
  }
  if (env.CUTOVER_COPY_CONFIRM !== COPY_CONFIRMATION) {
    throw new Error(`FINAL_COPY_BLOCKED: CUTOVER_COPY_CONFIRM harus ${COPY_CONFIRMATION}`);
  }
}

function createReadOnlySourceDatabase() {
  const sourceConnection = sourceDatabase.client.config.connection;
  return knexFactory({
    client: 'mysql2',
    connection: {
      host: sourceConnection.host,
      port: sourceConnection.port,
      user: sourceConnection.user,
      password: sourceConnection.password,
      database: sourceConnection.database,
      timezone: sourceConnection.timezone,
      charset: sourceConnection.charset,
    },
    pool: {
      min: 0,
      max: 1,
      afterCreate(connection, done) {
        connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ', (isolationError) => {
          if (isolationError) return done(isolationError, connection);
          connection.query('SET SESSION TRANSACTION READ ONLY', (readOnlyError) => {
            done(readOnlyError, connection);
          });
        });
      },
    },
    acquireConnectionTimeout: 10000,
  });
}

function transformValue(value, column, context = {}) {
  if (value === null || value === undefined) return null;
  if (column.data_type === 'boolean') {
    if ([true, 1, '1'].includes(value)) return true;
    if ([false, 0, '0'].includes(value)) return false;
    throw new Error(`INVALID_BOOLEAN: ${context.table}.${column.column_name}`);
  }
  if (['json', 'jsonb'].includes(column.data_type)) {
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      return JSON.stringify(parsed);
    } catch {
      throw new Error(`INVALID_JSON: ${context.table}.${column.column_name} source_id=${context.sourceId ?? '-'}`);
    }
  }
  return value;
}

function transformRow(table, row, columns, deferredUpdates) {
  const deferredColumns = new Set(DEFERRED_SELF_REFERENCES[table] || []);
  const transformed = {};
  for (const column of columns) {
    const value = row[column.column_name];
    if (deferredColumns.has(column.column_name) && value !== null && value !== undefined) {
      deferredUpdates.push({
        table,
        id: row.id,
        column: column.column_name,
        value,
      });
      transformed[column.column_name] = null;
      continue;
    }
    transformed[column.column_name] = transformValue(value, column, {
      table,
      sourceId: row.id,
    });
  }
  return transformed;
}

async function targetColumnMap(transaction) {
  const rows = await transaction('information_schema.columns')
    .select('table_name', 'column_name', 'data_type', 'ordinal_position')
    .where({ table_schema: 'public' })
    .whereIn('table_name', CRITICAL_TABLES)
    .orderBy(['table_name', 'ordinal_position']);
  const columns = new Map();
  for (const row of rows) {
    if (!columns.has(row.table_name)) columns.set(row.table_name, []);
    columns.get(row.table_name).push(row);
  }
  return columns;
}

async function assertTargetDataEmpty(database) {
  const occupied = [];
  for (const table of COPY_ORDER) {
    const result = await database(table).count({ count: '*' }).first();
    const count = Number(result.count || 0);
    if (count > 0) occupied.push({ table, count });
  }
  if (occupied.length) {
    throw new Error(`TARGET_DATA_NOT_EMPTY: ${occupied.map(({ table, count }) => `${table}=${count}`).join(', ')}`);
  }
}

async function copyTable(source, target, table, columns, deferredUpdates) {
  const rows = await source(table).select(columns.map((column) => column.column_name));
  if (!rows.length) return 0;
  const transformed = rows.map((row) => transformRow(table, row, columns, deferredUpdates));
  await target.batchInsert(table, transformed, CHUNK_SIZE);
  return transformed.length;
}

async function applyDeferredUpdates(target, deferredUpdates) {
  for (const update of deferredUpdates) {
    const changed = await target(update.table)
      .where({ id: update.id })
      .update({ [update.column]: update.value });
    if (changed !== 1) {
      throw new Error(`DEFERRED_REFERENCE_UPDATE_FAILED: ${update.table}.${update.column} source_id=${update.id}`);
    }
  }
}

async function resetIdentitySequences(target) {
  const identityColumns = await target('information_schema.columns')
    .select('table_name', 'column_name')
    .where({ table_schema: 'public', is_identity: 'YES' })
    .whereIn('table_name', CRITICAL_TABLES);

  for (const identity of identityColumns) {
    const maximum = await target(identity.table_name).max({ maximum: identity.column_name }).first();
    const sequenceResult = await target.raw('SELECT pg_get_serial_sequence(?, ?) AS sequence_name', [
      `public.${identity.table_name}`,
      identity.column_name,
    ]);
    const sequenceName = sequenceResult.rows[0]?.sequence_name;
    if (!sequenceName) throw new Error(`IDENTITY_SEQUENCE_NOT_FOUND: ${identity.table_name}.${identity.column_name}`);
    const hasRows = maximum.maximum !== null && maximum.maximum !== undefined;
    await target.raw('SELECT setval(?::regclass, ?, ?)', [
      sequenceName,
      hasRows ? maximum.maximum : 1,
      hasRows,
    ]);
  }
  return identityColumns.length;
}

async function migrationState() {
  const migrationConfig = { directory: path.resolve(__dirname, '../src/database/migrations') };
  const [completed, pending] = await sourceDatabase.migrate.list(migrationConfig);
  return { completed: completed.length, pending };
}

async function runCopy(mode) {
  assertCopyOrder();
  assertCommitAllowed(mode);

  const targetDatabase = knexFactory({
    client: 'pg',
    connection: targetConnection(),
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: 10000,
  });
  const readOnlySourceDatabase = createReadOnlySourceDatabase();
  const migration = await migrationState();
  let report;

  try {
    try {
      await targetDatabase.transaction(async (target) => {
        await target.raw("SELECT set_config('statement_timeout', ?, true)", ['10min']);
        await target.raw("SELECT set_config('lock_timeout', ?, true)", ['10s']);
        await target.raw("SELECT set_config('TimeZone', ?, true)", ['UTC']);
        await target.raw('SELECT pg_advisory_xact_lock(?)', [90820260902]);
        await assertTargetDataEmpty(target);

        await readOnlySourceDatabase.transaction(async (source) => {
          const sourceSnapshot = await collectDatabaseSnapshot(source, 'source_mysql_consistent_snapshot');
          const readiness = assessSourceReadiness(sourceSnapshot, migration.pending, {
            writesFrozen: mode === 'commit' && process.env.CUTOVER_WRITES_FROZEN === 'true',
          });
          if (mode === 'commit' && !readiness.ready_for_final_copy) {
            throw new Error(`FINAL_COPY_BLOCKED_BY_PREFLIGHT: ${readiness.blockers.map((blocker) => blocker.code).join(', ')}`);
          }

          const columns = await targetColumnMap(target);
          const deferredUpdates = [];
          const copiedRows = {};
          for (const table of COPY_ORDER) {
            const tableColumns = columns.get(table);
            if (!tableColumns?.length) throw new Error(`TARGET_COLUMNS_MISSING: ${table}`);
            copiedRows[table] = await copyTable(source, target, table, tableColumns, deferredUpdates);
          }

          await applyDeferredUpdates(target, deferredUpdates);
          const resetSequences = await resetIdentitySequences(target);
          const targetSnapshot = await collectDatabaseSnapshot(target, 'target_postgresql_transaction');
          const comparison = compareSnapshots(sourceSnapshot, targetSnapshot);
          if (!comparison.matches) {
            throw new Error(`COPY_VALIDATION_FAILED: ${JSON.stringify(comparison.differences)}`);
          }

          report = {
            mode,
            source_snapshot: sourceSnapshot.generated_at,
            source_readiness: readiness,
            copied_rows: copiedRows,
            total_rows: Object.values(copiedRows).reduce((total, count) => total + count, 0),
            deferred_references: deferredUpdates.length,
            identity_sequences_reset: resetSequences,
            comparison,
          };
        });

        if (mode === 'dry_run') throw DRY_RUN_ROLLBACK;
      });
    } catch (error) {
      if (error !== DRY_RUN_ROLLBACK) throw error;
    }

    if (mode === 'dry_run') await assertTargetDataEmpty(targetDatabase);
    return report;
  } finally {
    await readOnlySourceDatabase.destroy();
    await targetDatabase.destroy();
  }
}

async function main() {
  const mode = parseMode();
  const report = await runCopy(mode);
  process.stdout.write(`${JSON.stringify({
    status: mode === 'commit' ? 'data_copy_committed' : 'data_copy_validated_and_rolled_back',
    target: 'supabase_postgresql',
    runtime_switched: false,
    ...report,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    })
    .finally(() => sourceDatabase.destroy());
}

module.exports = {
  COPY_CONFIRMATION,
  COPY_ORDER,
  assertCommitAllowed,
  assertCopyOrder,
  createReadOnlySourceDatabase,
  parseMode,
  transformRow,
  transformValue,
};
