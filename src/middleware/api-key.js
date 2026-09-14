const crypto = require('crypto');
const knex = require('../database/knex');
const logger = require('../config/logger');

async function authenticateApiKey(req, res, next) {
  const authorization = req.get('authorization');
  if (!authorization) return next();
  const match = authorization.match(/^Bearer\s+(wa_[a-f0-9]{8}\.[A-Za-z0-9_-]+)$/);
  if (!match) return unauthorized(res);

  try {
    const keyHash = crypto.createHash('sha256').update(match[1]).digest('hex');
    const apiKey = await knex('api_keys')
      .where({ key_hash: keyHash, status: 'active' })
      .where((builder) => builder.whereNull('expires_at').orWhere('expires_at', '>', knex.fn.now(3)))
      .first();
    if (!apiKey) return unauthorized(res);

    req.apiKey = {
      id: apiKey.id,
      name: apiKey.name,
      scopes: Array.isArray(apiKey.scopes) ? apiKey.scopes : JSON.parse(apiKey.scopes),
    };
    knex('api_keys').where({ id: apiKey.id }).update({ last_used_at: knex.fn.now(3) })
      .catch((error) => logger.warn({ err: error, apiKeyId: apiKey.id }, 'Failed to update API key usage'));

    const startedAt = Date.now();
    res.on('finish', () => {
      knex('api_request_logs').insert({
        api_key_id: apiKey.id,
        request_id: req.id,
        method: req.method,
        endpoint: req.route?.path || req.path,
        response_status: res.statusCode,
        duration_ms: Date.now() - startedAt,
        ip_address: req.ip,
      }).catch((error) => logger.warn({ err: error }, 'Failed to write API request log'));
    });
    return next();
  } catch (error) {
    return next(error);
  }
}

function unauthorized(res) {
  return res.status(401).json({
    success: false,
    error: { code: 'INVALID_API_KEY', message: 'API key tidak valid atau sudah kedaluwarsa' },
  });
}

module.exports = { authenticateApiKey };
