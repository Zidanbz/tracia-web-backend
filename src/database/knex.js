const knexFactory = require('knex');
const env = require('../config/env');
const { createPoolConfig } = require('./mysql-connection');

module.exports = knexFactory({
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
  acquireConnectionTimeout: 10000,
});
