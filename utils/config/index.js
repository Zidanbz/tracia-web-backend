const env = require('../../src/config/env');

module.exports = {
  HOST_DB: env.database.host,
  USER_DB: env.database.user,
  PASSWORD_DB: env.database.password,
  PORT_DB: env.database.port,
  DATABASENAME_DB: env.database.database,
  URL: env.appUrl,
};
