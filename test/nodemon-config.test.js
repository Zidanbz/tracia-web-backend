const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const config = require(path.resolve(__dirname, '../nodemon.json'));

test('nodemon hanya memantau source runtime dan mengabaikan storage WhatsApp', () => {
  assert.ok(config.watch.includes('src'));
  assert.ok(config.watch.includes('app.js'));
  assert.ok(config.ignore.includes('storage/**'));
  assert.ok(!config.watch.some((entry) => entry.startsWith('storage')));
});
