const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone } = require('../src/shared/phone');

test('normalisasi nomor Indonesia ke format E.164 tanpa plus', () => {
  assert.equal(normalizePhone('0812-3456-7890'), '6281234567890');
  assert.equal(normalizePhone('812 3456 7890'), '6281234567890');
  assert.equal(normalizePhone('+62 812 3456 7890'), '6281234567890');
});

test('nomor invalid ditolak', () => {
  assert.throws(() => normalizePhone('123'), /tidak valid/);
});
