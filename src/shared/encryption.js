const crypto = require('crypto');
const env = require('../config/env');

function encryptSecret(value) {
  if (!env.encryptionKey) {
    const error = new Error('APP_ENCRYPTION_KEY belum dikonfigurasi');
    error.status = 503;
    error.code = 'ENCRYPTION_NOT_CONFIGURED';
    throw error;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(env.encryptionKey, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

module.exports = { encryptSecret };
