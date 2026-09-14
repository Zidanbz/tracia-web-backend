const knex = require('../../database/knex');

async function updateAccountStatus(status, details = {}) {
  const updates = {
    status,
    last_error_code: details.errorCode || null,
    updated_at: knex.fn.now(3),
  };
  if (status === 'ready') updates.last_connected_at = knex.fn.now(3);
  if (status === 'disconnected') updates.last_disconnected_at = knex.fn.now(3);
  if (details.phoneNumber) updates.phone_number = details.phoneNumber;
  await knex('whatsapp_accounts').where({ public_id: 'default' }).update(updates);
}

async function addConnectionEvent(eventType, metadata = null) {
  const account = await knex('whatsapp_accounts').where({ public_id: 'default' }).first('id');
  if (!account) return;
  await knex('whatsapp_connection_events').insert({
    whatsapp_account_id: account.id,
    event_type: eventType,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });
}

module.exports = { updateAccountStatus, addConnectionEvent };
