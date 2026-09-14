#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const knexFactory = require('knex');
const sourceDatabase = require('../src/database/knex');
const {
  assessSourceReadiness,
  collectDatabaseSnapshot,
  compareSnapshots,
} = require('./lib/cutover-audit');

function targetConnection() {
  const connectionString = process.env.CUTOVER_TARGET_DATABASE_URL;
  if (!connectionString) throw new Error('CUTOVER_TARGET_DATABASE_URL wajib diisi melalui environment lokal');
  const parsed = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('CUTOVER_TARGET_DATABASE_URL harus memakai protokol PostgreSQL');
  }
  const ssl = { rejectUnauthorized: true };
  if (process.env.CUTOVER_TARGET_SSL_CA_PATH) {
    ssl.ca = fs.readFileSync(process.env.CUTOVER_TARGET_SSL_CA_PATH, 'utf8');
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    ssl,
  };
}

async function main() {
  const targetDatabase = knexFactory({
    client: 'pg',
    connection: targetConnection(),
    pool: { min: 0, max: 2 },
    acquireConnectionTimeout: 10000,
  });
  try {
    const migrationConfig = { directory: path.resolve(__dirname, '../src/database/migrations') };
    const [, pendingMigrations] = await sourceDatabase.migrate.list(migrationConfig);
    const source = await collectDatabaseSnapshot(sourceDatabase, 'source_mysql');
    const sourceReadiness = assessSourceReadiness(source, pendingMigrations, {
      writesFrozen: process.env.CUTOVER_WRITES_FROZEN === 'true',
    });
    const target = await collectDatabaseSnapshot(targetDatabase, 'target_postgresql');
    const comparison = compareSnapshots(source, target);
    const valid = sourceReadiness.ready_for_final_copy && comparison.matches;
    process.stdout.write(`${JSON.stringify({
      mode: 'read_only',
      valid_for_cutover: valid,
      source_readiness: sourceReadiness,
      comparison,
      source,
      target,
    }, null, 2)}\n`);
    if (!valid) process.exitCode = 2;
  } finally {
    await targetDatabase.destroy();
  }
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => sourceDatabase.destroy());
