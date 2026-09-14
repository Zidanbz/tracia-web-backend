const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../../shared/async-handler');
const { requirePermission } = require('../../middleware/auth');
const { manager } = require('../whatsapp/whatsapp-client-manager');
const messageWorker = require('../queue/message-worker');
const service = require('./dashboard.service');

const router = express.Router();
router.get('/summary', requirePermission('dashboard.view'), asyncHandler(async (req, res) => {
  const query = z.object({ days: z.coerce.number().int().min(7).max(30).default(7) }).parse(req.query);
  const permissions = req.session?.permissions || [];
  const data = await service.getSummary({
    days: query.days,
    access: {
      broadcasts: permissions.includes('broadcasts.view'),
      messages: permissions.includes('messages.view'),
      contacts: permissions.includes('contacts.view'),
      templates: permissions.includes('templates.view'),
      audit: permissions.includes('audit.view'),
    },
  });
  res.json({
    success: true,
    data: {
      ...data,
      whatsapp: manager.getStatus(),
      worker: messageWorker.getStatus(),
      generated_at: new Date().toISOString(),
    },
  });
}));

module.exports = router;
