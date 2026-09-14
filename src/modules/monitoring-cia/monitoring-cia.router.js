const express = require('express');
const { requirePermission } = require('../../middleware/auth');
const controller = require('./monitoring-cia.controller');

const router = express.Router();

router.get('/', requirePermission('inbox.view'), controller.listMessages);
router.get('/summary', requirePermission('inbox.view'), controller.getSummary);
router.patch('/:publicId/read', requirePermission('inbox.manage'), controller.markAsRead);
router.post('/read-all', requirePermission('inbox.manage'), controller.markAllAsRead);
router.post('/sync', requirePermission('inbox.manage'), controller.syncUnreadMessages);
router.delete('/clear-all', requirePermission('inbox.manage'), controller.clearAllMessages);
router.post('/clear-all', requirePermission('inbox.manage'), controller.clearAllMessages);

module.exports = router;
