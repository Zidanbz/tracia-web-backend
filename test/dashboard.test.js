const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_STORE = 'memory';

const { deliveryRate } = require('../src/modules/dashboard/dashboard.service');

test('delivery success rate hanya menghitung hasil final', () => {
  assert.equal(deliveryRate({ sent: 8, failed: 2, queued: 90 }), 80);
});

test('delivery success rate nol ketika belum ada hasil final', () => {
  assert.equal(deliveryRate({ queued: 10 }), 0);
});
