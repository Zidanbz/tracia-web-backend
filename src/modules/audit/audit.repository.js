const knex = require('../../database/knex');

async function writeAuditLog({
  actorUserId = null,
  actorType = 'user',
  action,
  entityType = null,
  entityId = null,
  beforeData = null,
  afterData = null,
  requestId = null,
  ipAddress = null,
  userAgent = null,
}, database = knex) {
  await database('audit_logs').insert({
    actor_user_id: actorUserId,
    actor_type: actorType,
    action,
    entity_type: entityType,
    entity_id: entityId,
    before_data: beforeData ? JSON.stringify(beforeData) : null,
    after_data: afterData ? JSON.stringify(afterData) : null,
    request_id: requestId,
    ip_address: ipAddress,
    user_agent: userAgent?.slice(0, 512) || null,
  });
}

async function writeRequestAudit(req, details, database = knex) {
  return writeAuditLog({
    actorUserId: req.session?.user?.id || null,
    actorType: req.apiKey ? 'api_key' : 'user',
    requestId: req.id,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
    ...details,
  }, database);
}

module.exports = { writeAuditLog, writeRequestAudit };
