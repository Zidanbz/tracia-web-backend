#!/usr/bin/env node

const path = require('path');
const knex = require('../src/database/knex');
const {
  assessSourceReadiness,
  collectDatabaseSnapshot,
} = require('./lib/cutover-audit');

async function main() {
  const migrationConfig = { directory: path.resolve(__dirname, '../src/database/migrations') };
  const [completedMigrations, pendingMigrations] = await knex.migrate.list(migrationConfig);
  const snapshot = await collectDatabaseSnapshot(knex, 'source_mysql');
  const readiness = assessSourceReadiness(snapshot, pendingMigrations);
  const report = {
    mode: 'read_only',
    database_engine: 'mysql',
    completed_migrations: completedMigrations.length,
    pending_migrations: pendingMigrations.map((migration) => migration.file),
    readiness,
    snapshot,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!readiness.ready_for_maintenance_window) process.exitCode = 2;
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => knex.destroy());
