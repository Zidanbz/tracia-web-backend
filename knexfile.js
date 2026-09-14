const path = require('path');
const env = require('./src/config/env');
const { createPoolConfig } = require('./src/database/mysql-connection');

const shared = {
  client: 'mysql2',
  connection: {
    host: env.database.host,
    port: env.database.port,
    user: env.database.user,
    password: env.database.password,
    database: env.database.database,
    timezone: 'Z',
    charset: 'utf8mb4',
  },
  pool: createPoolConfig(env.database.poolMin, env.database.poolMax),
  migrations: {
    directory: path.join(__dirname, 'src/database/migrations'),
    tableName: 'knex_migrations',
  },
  seeds: {
    directory: path.join(__dirname, 'src/database/seeds'),
  },
};

module.exports = {
  development: shared,
  test: shared,
  production: shared,
};
