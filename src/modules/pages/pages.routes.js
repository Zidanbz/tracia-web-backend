const express = require('express');
const { requirePermission, requireAnyPermission } = require('../../middleware/auth');
const env = require('../../config/env');

const router = express.Router();

router.get('/dashboard', requirePermission('dashboard.view'), (req, res) => {
  res.render('dashboard', { title: 'Dashboard' });
});

router.get('/campus-dashboard', requirePermission('campaigns.monitor'), (req, res) => {
  res.render('campus-dashboard/index', { title: 'Dashboard Kampus' });
});

router.get('/campaign-monitoring', requirePermission('campaigns.monitor'), (req, res) => {
  res.render('campaign-monitoring/index', { title: 'Monitoring Campaign' });
});

router.get('/message-timing', requirePermission('campaigns.monitor'), (req, res) => {
  res.render('message-timing/index', { title: 'Log Waktu Pesan' });
});

router.get('/guidebook', requirePermission('settings.view'), requirePermission('dashboard.view'), (req, res) => {
  res.render('guidebook', { title: 'Guidebook Admin' });
});

router.get('/messages', requirePermission('messages.send'), (req, res) => {
  res.render('messages/index', { title: 'Kirim Pesan' });
});

router.get('/broadcasts', requirePermission('broadcasts.view'), (req, res) => {
  res.render('broadcasts/index', {
    title: 'Broadcast',
    canManageBroadcasts: req.session.permissions.includes('broadcasts.manage'),
  });
});

router.get('/campaigns', requirePermission('campaigns.view'), (req, res) => {
  const permissions = req.session.permissions || [];
  res.render('campaigns/index', {
    title: 'Campaign',
    canManageCampaigns: permissions.includes('campaigns.manage'),
  });
});

router.get('/campaigns/:publicId', requirePermission('campaigns.view'), (req, res) => {
  const permissions = req.session.permissions || [];
  res.render('campaigns/detail', {
    title: 'Detail Campaign',
    campaignPublicId: req.params.publicId,
    canManageCampaigns: permissions.includes('campaigns.manage'),
    canOperateCampaigns: permissions.includes('campaigns.operate'),
    canMonitorCampaigns: permissions.includes('campaigns.monitor'),
    canAttributeCampaignReplies: permissions.includes('campaigns.attribute_replies'),
    showCampaignDevelopmentTools: env.nodeEnv === 'development',
  });
});

router.get('/contacts', requirePermission('contacts.view'), (req, res) => {
  res.render('contacts/index', {
    title: 'Kontak',
    canManageContacts: req.session.permissions.includes('contacts.manage'),
  });
});

router.get('/contact-groups', requirePermission('contacts.view'), (req, res) => {
  res.render('contact-groups/index', {
    title: 'Struktur Akademik',
    canManageContactGroups: req.session.permissions.includes('contacts.manage'),
  });
});

router.get('/templates', requirePermission('templates.view'), (req, res) => {
  res.render('templates/index', {
    title: 'Template Pesan',
    canManageTemplates: req.session.permissions.includes('templates.manage'),
  });
});

router.get('/message-activity', requireAnyPermission(['messages.view', 'queue.view']), (req, res) => {
  const permissions = req.session.permissions || [];
  const canViewHistory = permissions.includes('messages.view');
  const canViewQueue = permissions.includes('queue.view');
  const requestedTab = req.query.tab === 'queue' ? 'queue' : 'history';
  const initialTab = (requestedTab === 'history' && canViewHistory) || (requestedTab === 'queue' && canViewQueue)
    ? requestedTab
    : (canViewHistory ? 'history' : 'queue');

  res.render('message-activity/index', {
    title: 'Aktivitas Pesan',
    initialTab,
    canViewHistory,
    canViewQueue,
    canRetryMessages: permissions.includes('messages.retry'),
    canManageQueue: permissions.includes('queue.manage'),
  });
});

router.get('/message-history', requirePermission('messages.view'), (req, res) => {
  res.redirect('/message-activity?tab=history');
});

router.get('/queue', requirePermission('queue.view'), (req, res) => {
  res.redirect('/message-activity?tab=queue');
});

router.get('/users-management', requirePermission('users.view'), (req, res) => {
  res.render('users-management/index', {
    title: 'Pengguna dan Hak Akses',
    canManageUsers: req.session.permissions.includes('users.manage'),
  });
});

router.get('/integrations', requirePermission('integrations.view'), (req, res) => {
  res.render('integrations/index', {
    title: 'Integrasi API',
    canManageIntegrations: req.session.permissions.includes('integrations.manage'),
  });
});

router.get('/reports', requirePermission('reports.view'), (req, res) => {
  res.render('reports/index', { title: 'Laporan' });
});

router.get('/settings', requirePermission('settings.view'), (req, res) => {
  res.render('settings/index', {
    title: 'Pengaturan',
    canManageSettings: req.session.permissions.includes('settings.manage'),
  });
});

router.get('/monitoring-cia', requireAnyPermission(['inbox.view', 'messages.view']), (req, res) => {
  const permissions = req.session.permissions || [];
  res.render('monitoring-cia/index', {
    title: 'Monitoring CIA',
    canManageInbox: permissions.includes('inbox.manage') || permissions.includes('messages.send'),
  });
});

router.get('/qa-sessions', requireAnyPermission(['qa_session.view', 'inbox.view']), (req, res) => {
  const permissions = req.session.permissions || [];
  res.render('qa-sessions/index', {
    title: 'Pertanyaan Sesi CIA',
    canManageQASessions: permissions.includes('qa_session.manage') || permissions.includes('inbox.manage'),
  });
});

module.exports = router;
