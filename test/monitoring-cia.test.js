const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_STORE = 'memory';

const app = require('../app');

test('halaman monitoring cia dapat dirender dengan layout dashboard', async () => {
  const html = await new Promise((resolve, reject) => {
    app.render('monitoring-cia/index', {
      title: 'Monitoring CIA',
      csrfToken: 'test-token',
      currentUser: { id: 1, name: 'Operator CIA' },
      currentPath: '/monitoring-cia',
      permissions: ['dashboard.view', 'inbox.view', 'inbox.manage'],
      canManageInbox: true,
    }, (error, output) => (error ? reject(error) : resolve(output)));
  });

  assert.match(html, /Monitoring CIA/);
  assert.match(html, /Total Balasan/);
  assert.match(html, /Belum Dibaca/);
  assert.match(html, /btn-read-all/);
  assert.match(html, /session-filter/);
  assert.match(html, /Sesi Tanya Jawab/);
  assert.match(html, /feather icon-inbox/);
});
