const test = require('node:test');
const assert = require('node:assert/strict');

const { requireAnyPermission } = require('../src/middleware/auth');

test('requireAnyPermission menerima user dengan salah satu permission', () => {
  const middleware = requireAnyPermission(['messages.view', 'queue.view']);
  const req = { method: 'GET', originalUrl: '/message-activity', session: { user: { id: 1 }, permissions: ['queue.view'] } };
  let forwardedError;

  middleware(req, {}, (error) => { forwardedError = error || null; });

  assert.equal(forwardedError, null);
});

test('requireAnyPermission menolak user tanpa permission yang sesuai', () => {
  const middleware = requireAnyPermission(['messages.view', 'queue.view']);
  const req = { method: 'GET', originalUrl: '/message-activity', session: { user: { id: 2 }, permissions: ['contacts.view'] } };
  let forwardedError;

  middleware(req, {}, (error) => { forwardedError = error; });

  assert.equal(forwardedError?.status, 403);
});
