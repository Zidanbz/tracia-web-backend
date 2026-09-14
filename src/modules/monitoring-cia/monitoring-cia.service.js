const repository = require('./incoming-message.repository');
const { shouldMaskPersonalData, maskPhone } = require('../../shared/data-masking');
const { writeRequestAudit } = require('../audit/audit.repository');
const logger = require('../../config/logger');
let socketApi;
try {
  socketApi = require('../../../utils/socket');
} catch (err) {
  socketApi = null;
}

function maskIncomingMessageData(item) {
  return {
    ...item,
    from_phone: maskPhone(item.from_phone),
    from_name: item.from_name ? maskPhone(item.from_name) : null,
    contact_name: item.contact_name ? maskPhone(item.contact_name) : null,
    body: item.body ? '[MASKED]' : '',
  };
}

async function listMessages(req, filters) {
  const result = await repository.listIncomingMessages(filters);
  const mask = shouldMaskPersonalData(req);

  if (mask) {
    result.data = result.data.map(maskIncomingMessageData);
  }

  return result;
}

async function getSummary() {
  return repository.getSummary();
}

async function markAsRead(req, publicId) {
  const result = await repository.markAsRead(publicId);
  if (result && req) {
    await writeRequestAudit(req, {
      action: 'inbox.mark_read',
      entityType: 'incoming_message',
      entityId: publicId,
      afterData: { is_read: true },
    }).catch((err) => logger.warn({ err }, 'Audit write failed for markAsRead'));
  }
  return result;
}

async function markAllAsRead(req) {
  const result = await repository.markAllAsRead();
  if (req) {
    await writeRequestAudit(req, {
      action: 'inbox.mark_all_read',
      entityType: 'incoming_message',
      afterData: result,
    }).catch((err) => logger.warn({ err }, 'Audit write failed for markAllAsRead'));
  }
  return result;
}

async function clearAllMessages(req) {
  const result = await repository.clearAllIncomingMessages();
  if (req) {
    await writeRequestAudit(req, {
      action: 'inbox.clear_all',
      entityType: 'incoming_message',
      afterData: result,
    }).catch((err) => logger.warn({ err }, 'Audit write failed for clearAllMessages'));
  }
  return result;
}

async function handleIncomingWAMessage({ fromPhone, fromName, body, hasMedia, mediaType, waMessageId, quotedWaMessageId, receivedAt }) {
  try {
    const saved = await repository.saveIncomingMessage({
      fromPhone,
      fromName,
      body,
      hasMedia,
      mediaType,
      waMessageId,
      quotedWaMessageId,
      receivedAt,
    });

    if (saved && saved.is_new) {
      if (socketApi && socketApi.io) {
        socketApi.io.to('whatsapp:default').emit('incoming_message', saved);
      }

    }

    logger.info({ publicId: saved.public_id, campaignId: saved.campaign?.campaign_id || null, isNew: saved.is_new }, 'Balasan WA diproses');
    return saved;
  } catch (error) {
    logger.error({ err: error }, 'Gagal mencatat balasan WA masuk');
    throw error;
  }
}

async function syncUnreadMessages() {
  const { manager: whatsappManager } = require('../whatsapp/whatsapp-client-manager');
  return whatsappManager.syncUnreadMessages();
}

module.exports = {
  listMessages,
  getSummary,
  markAsRead,
  markAllAsRead,
  clearAllMessages,
  handleIncomingWAMessage,
  syncUnreadMessages,
};
