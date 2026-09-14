const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_STORE = 'memory';

const app = require('../app');

test('halaman pertanyaan sesi cia dapat dirender dengan layout dashboard', async () => {
  const html = await new Promise((resolve, reject) => {
    app.render('qa-sessions/index', {
      title: 'Pertanyaan Sesi CIA',
      csrfToken: 'test-token',
      currentUser: { id: 1, name: 'Operator CIA' },
      currentPath: '/qa-sessions',
      permissions: ['dashboard.view', 'inbox.view', 'qa_session.view', 'qa_session.manage'],
      canManageQASessions: true,
    }, (error, output) => (error ? reject(error) : resolve(output)));
  });

  assert.match(html, /Pertanyaan Sesi CIA/);
  assert.match(html, /session-cards-container/);
  assert.match(html, /modal-edit-question/);
  assert.match(html, /form-edit-question/);
});
