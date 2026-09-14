const session = require('express-session');
const createMySQLStore = require('express-mysql-session');
const env = require('../config/env');
const logger = require('../config/logger');

function createStore() {
  if (env.session.store === 'memory') {
    logger.warn('Session memakai MemoryStore; hanya diizinkan untuk development/test');
    return undefined;
  }

  const MySQLStore = createMySQLStore(session);
  return new MySQLStore({
    host: env.database.host,
    port: env.database.port,
    user: env.database.user,
    password: env.database.password,
    database: env.database.database,
    createDatabaseTable: false,
    expiration: env.session.ttlSeconds * 1000,
    clearExpired: true,
    endConnectionOnClose: true,
  });
}

module.exports = session({
  name: 'wa.sid',
  secret: env.session.secret,
  store: createStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    maxAge: env.session.ttlSeconds * 1000,
  },
});
