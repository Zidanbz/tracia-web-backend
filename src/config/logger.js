const pino = require('pino');
const env = require('./env');

module.exports = pino({
  level: env.logLevel,
  base: undefined,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      '*.password_hash',
      '*.api_key',
      '*.token',
      '*.qr',
      'phoneNumber',
      '*.phoneNumber',
      '*.recipient_phone_e164',
      '*.body',
      '*.body_snapshot',
    ],
    censor: '[REDACTED]',
  },
});
