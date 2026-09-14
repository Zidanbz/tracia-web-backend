const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_STORE = 'memory';

const messagesService = require('../src/modules/messages/messages.service');
const broadcastsService = require('../src/modules/broadcasts/broadcasts.service');
const { renderContactTemplate } = require('../src/shared/contact-template');

test('pesan dengan variabel template belum terisi ditolak sebelum akses database', async () => {
  await assert.rejects(
    messagesService.enqueue({ recipient_phone: '08123456789', body: 'Halo {{nama}}' }),
    (error) => error.code === 'UNRESOLVED_TEMPLATE_VARIABLES' && error.status === 422,
  );
});

test('broadcast menolak variabel kontak yang tidak didukung sebelum preview', async () => {
  await assert.rejects(
    broadcastsService.preview({ name: 'Promo', body: 'Halo {{email}}', contact_ids: [1] }),
    (error) => error.name === 'ZodError',
  );
});

test('template broadcast dirender menggunakan data setiap kontak', () => {
  assert.equal(
    renderContactTemplate('Halo {{ nama }}, nomor Anda {{nomor}}', { name: 'Salsa', phone_e164: '628123456789' }),
    'Halo Salsa, nomor Anda 628123456789',
  );
});

test('filter status riwayat yang tidak dikenal ditolak sebelum query database', async () => {
  await assert.rejects(
    messagesService.list({ status: 'unknown_status' }),
    (error) => error.name === 'ZodError',
  );
});
