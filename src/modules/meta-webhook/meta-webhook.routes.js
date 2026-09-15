const express = require('express');
const router = express.Router();
const env = require('../../config/env');
const logger = require('../../config/logger');

/**
 * GET /api/v1/meta-webhook
 * Handshake / Webhook verification from Meta Graph API
 */
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expectedToken = env.meta?.webhookVerifyToken || process.env.META_WEBHOOK_VERIFY_TOKEN || 'tracia_meta_verify_2026';

  if (mode === 'subscribe' && token === expectedToken) {
    logger.info('Meta webhook verification successful');
    return res.status(200).send(challenge);
  }

  logger.warn({ mode, tokenReceived: !!token }, 'Meta webhook verification failed: invalid token or mode');
  return res.sendStatus(403);
});

/**
 * POST /api/v1/meta-webhook
 * Receiving realtime messages and delivery status updates from Meta
 */
router.post('/', (req, res) => {
  try {
    const body = req.body;
    logger.info({ object: body?.object }, 'Meta webhook event received');

    // Immediately return 200 OK as required by Meta
    res.sendStatus(200);

    // Process event asynchronously
    if (body?.object === 'whatsapp_business_account' && Array.isArray(body.entry)) {
      for (const entry of body.entry) {
        if (!Array.isArray(entry.changes)) continue;
        for (const change of entry.changes) {
          if (change.field === 'messages' && change.value) {
            const { messages, statuses } = change.value;
            if (Array.isArray(messages)) {
              logger.info({ messageCount: messages.length }, 'Incoming WhatsApp message received via Meta Webhook');
            }
            if (Array.isArray(statuses)) {
              logger.info({ statusCount: statuses.length }, 'Message status update received via Meta Webhook');
            }
          }
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error processing Meta webhook event');
  }
});

module.exports = router;
