var express = require('express');
var router = express.Router();
const socket = require('../utils/socket');
const { URL } = require('../utils/config');
const { requirePermission } = require('../src/middleware/auth');
const asyncHandler = require('../src/shared/async-handler');
const { manager, extractQrToken } = require('../src/modules/whatsapp/whatsapp-client-manager');
const messagesService = require('../src/modules/messages/messages.service');
const { writeRequestAudit } = require('../src/modules/audit/audit.repository');

manager.on('qr', (payload) => {
  const qrToken = extractQrToken(payload);
  if (!qrToken) return;
  socket.io.to('whatsapp:default').emit('qrWa', qrToken);
});
manager.on('ready', (status) => socket.io.to('whatsapp:default').emit('connectqr', status.status));
manager.on('disconnected', (status) => socket.io.to('whatsapp:default').emit('waDisconnected', status));
manager.on('connection_error', (status) => socket.io.to('whatsapp:default').emit('waConnectionError', status));

// ==================== ROUTES ====================
router.get('/', requirePermission('whatsapp.view'), function (req, res) {
  const status = manager.getStatus();
  res.render('index', {
    title: 'Koneksi WhatsApp',
    status: status.status,
    URL,
    canManageWhatsApp: req.session.permissions.includes('whatsapp.manage'),
  });
});

// start connection
router.post('/', requirePermission('whatsapp.manage'), asyncHandler(async (req, res) => {
  const result = await manager.connect();
  await writeRequestAudit(req, { action: 'whatsapp.connect', entityType: 'whatsapp_account', entityId: 'default' });
  return res.status(result.started ? 202 : 200).send(result);
}));

router.post('/reconnect', requirePermission('whatsapp.manage'), asyncHandler(async (req, res) => {
  const result = await manager.reconnect();
  await writeRequestAudit(req, { action: 'whatsapp.reconnect', entityType: 'whatsapp_account', entityId: 'default' });
  return res.status(202).send(result);
}));

// ==================== SEND MESSAGE ====================
router.post('/send', requirePermission('messages.send'), asyncHandler(async (req, res) => {
  const message = await messagesService.enqueue({
    recipient_phone: req.body.nohp,
    body: req.body.msg,
    source: 'dashboard',
  }, req.session.user.id);
  await writeRequestAudit(req, { action: 'message.enqueued', entityType: 'message', entityId: message.public_id });
  res.status(202).json({ success: true, data: message });
}));

// send array
router.post('/send-array', requirePermission('messages.send'), (req, res) => res.status(410).json({
  success: false,
  error: {
    code: 'LEGACY_BULK_SEND_DISABLED',
    message: 'Gunakan broadcast persistent melalui POST /api/v1/broadcasts agar consent, retry, dan riwayat tercatat.',
  },
}));

// send media
router.post('/send-media', requirePermission('messages.send'), (req, res) => res.status(501).json({
  success: false,
  error: { code: 'MEDIA_QUEUE_NOT_IMPLEMENTED', message: 'Pengiriman media dinonaktifkan sampai media storage dan queue aman selesai.' },
}));

router.get('/send-wa', requirePermission('broadcasts.view'), async (req, res) => {
  res.render('send/send-wa');
});

router.post('/upload-notlp', requirePermission('contacts.manage'), (req, res) => res.status(410).json({
  success: false,
  error: {
    code: 'LEGACY_CONTACT_IMPORT_DISABLED',
    message: 'Gunakan POST /api/v1/contact-imports lalu commit setelah preview.',
  },
}));

router.post('/send-wa/admin', requirePermission('broadcasts.manage'), (req, res) => res.status(410).json({
  success: false,
  error: {
    code: 'LEGACY_BROADCAST_DISABLED',
    message: 'Import kontak terlebih dahulu, catat consent, lalu gunakan POST /api/v1/broadcasts.',
  },
}));

module.exports = router;
