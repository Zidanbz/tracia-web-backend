const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_STORE = 'memory';

const {
  extractQrToken,
  prepareSyncedMessages,
  WhatsAppClientManager,
  STATES,
  extractExternalMessageId,
  waitForServerAck,
  createSendObservation,
  parseWhatsAppIdentifier,
  extractPhoneFromDisplayName,
} = require('../src/modules/whatsapp/whatsapp-client-manager');
const {
  buildDuplicateIncomingContactRepair,
} = require('../src/modules/monitoring-cia/incoming-message.repository');

test('event QR hanya meneruskan token string ke browser', () => {
  assert.equal(extractQrToken({ qr: 'token-pairing', connection_state: 'awaiting_qr' }), 'token-pairing');
  assert.equal(extractQrToken('token-legacy'), 'token-legacy');
  assert.equal(extractQrToken({ qr: null }), null);
  assert.equal(extractQrToken({ connection_state: 'awaiting_qr' }), null);
  assert.equal(extractQrToken(null), null);
});

test('recovery menyingkirkan duplikat dan mengurutkan pesan tertinggal secara kronologis', () => {
  const messages = prepareSyncedMessages([
    { waMessageId: 'newer', fromPhone: '62812', body: '2', timestampMs: 2000 },
    { waMessageId: 'older', fromPhone: '62812', body: '1', timestampMs: 1000 },
    { waMessageId: 'older', fromPhone: '62812', body: 'duplikat', timestampMs: 1000 },
    { waMessageId: 'outbound', fromPhone: '62812', fromMe: true, timestampMs: 3000 },
    null,
  ]);

  assert.deepEqual(messages.map((message) => message.waMessageId), ['older', 'newer']);
  assert.equal(messages[0].body, '1');
});

test('event recovery yang bersamaan memakai satu proses sync', async () => {
  const manager = new WhatsAppClientManager();
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  manager.performMessageSync = async () => {
    calls += 1;
    await gate;
    return { synced_count: 1 };
  };

  const readySync = manager.syncUnreadMessages({ deep: true, reason: 'ready' });
  const eventSync = manager.syncUnreadMessages({ deep: false, reason: 'unread_count' });
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await readySync, { synced_count: 1 });
  assert.deepEqual(await eventSync, { synced_count: 1 });
  assert.equal(manager.syncPromise, null);
});

test('scheduler recovery hanya dibuat sekali dan dapat dihentikan', () => {
  const manager = new WhatsAppClientManager();
  manager.state = STATES.READY;
  manager.startAutoSync();
  const timer = manager.autoSyncInterval;
  manager.startAutoSync();
  assert.equal(manager.autoSyncInterval, timer);
  manager.stopAutoSync();
  assert.equal(manager.autoSyncInterval, null);
});

test('ID dan ACK server wajib tersedia sebelum hasil send dianggap berhasil', async () => {
  const client = new EventEmitter();
  const sent = { id: { _serialized: 'true_wa_id' }, ack: 0 };
  assert.equal(extractExternalMessageId(sent), 'true_wa_id');

  const confirmation = waitForServerAck(client, sent, 1000);
  client.emit('message_ack', { id: { _serialized: 'different_id' } }, 1);
  client.emit('message_ack', { id: { _serialized: 'true_wa_id' } }, 1);
  assert.equal(extractExternalMessageId(await confirmation), 'true_wa_id');
});

test('hasil kosong dan ACK error ditolak sebagai delivery tidak terkonfirmasi', async () => {
  const client = new EventEmitter();
  await assert.rejects(
    () => waitForServerAck(client, undefined, 20),
    (error) => error.code === 'WHATSAPP_SEND_RESULT_MISSING' && error.deliveryUnconfirmed,
  );
  await assert.rejects(
    () => waitForServerAck(client, { id: { id: 'ack_error_id' }, ack: -1 }, 20),
    (error) => error.code === 'WHATSAPP_ACK_ERROR' && error.deliveryUnconfirmed,
  );
});

test('ACK pending yang timeout tidak dianggap sent', async () => {
  const client = new EventEmitter();
  await assert.rejects(
    () => waitForServerAck(client, { id: { id: 'pending_id' }, ack: 0 }, 10),
    (error) => error.code === 'WHATSAPP_ACK_TIMEOUT' && error.deliveryUnconfirmed,
  );
  assert.equal(client.listenerCount('message_ack'), 0);
});

test('sendMessage meminta hasil WhatsApp dan hanya mengembalikan ACK server', async () => {
  const manager = new WhatsAppClientManager();
  const client = new EventEmitter();
  let capturedOptions;
  client.getNumberId = async () => ({ _serialized: '628123456789@c.us' });
  client.sendMessage = async (chatId, content, options) => {
    assert.equal(chatId, '628123456789@c.us');
    assert.equal(content, 'pesan pengujian');
    capturedOptions = options;
    return { id: { _serialized: 'confirmed_id' }, ack: 1 };
  };
  manager.client = client;
  manager.state = STATES.READY;

  const result = await manager.sendMessage('628123456789@c.us', 'pesan pengujian');
  assert.equal(result.id._serialized, 'confirmed_id');
  assert.equal(capturedOptions.waitUntilMsgSent, true);
});

test('sendMessage mempertahankan PN untuk chat baru dan menerima receipt alias LID', async () => {
  const manager = new WhatsAppClientManager();
  const client = new EventEmitter();
  let mappingCalls = 0;
  client.getNumberId = async () => ({ _serialized: '987654321012345@lid' });
  client.getContactLidAndPhone = async (ids) => {
    mappingCalls += 1;
    assert.deepEqual(ids, ['987654321012345@lid']);
    return [{ lid: '987654321012345@lid', pn: '628123456789@c.us' }];
  };
  client.sendMessage = async (chatId) => {
    assert.equal(chatId, '628123456789@c.us');
    const delivered = {
      id: { $1: 'lid_confirmed_id', fromMe: true },
      fromMe: true,
      to: '987654321012345@lid',
      body: 'pesan chat baru',
      ack: 1,
    };
    client.emit('message_create', delivered);
    return undefined;
  };
  manager.client = client;
  manager.state = STATES.READY;

  const first = await manager.sendMessage('628123456789@c.us', 'pesan chat baru');
  assert.equal(first.id.$1, 'lid_confirmed_id');
  assert.equal(mappingCalls, 1);

  client.sendMessage = async (chatId) => {
    assert.equal(chatId, '628123456789@c.us');
    return { id: { $1: 'lid_cached_id' }, ack: 1 };
  };
  const second = await manager.sendMessage('628123456789@c.us', 'pesan kedua');
  assert.equal(second.id.$1, 'lid_cached_id');
  assert.equal(mappingCalls, 1);
});

test('sendMessage mengabaikan alias LID konflik dan tetap mengirim ke PN terverifikasi', async () => {
  const manager = new WhatsAppClientManager();
  const client = new EventEmitter();
  let sendCalls = 0;
  client.getNumberId = async () => ({ _serialized: '628123456789@c.us' });
  client.getContactLidAndPhone = async () => [
    { lid: '111111111111111@lid', pn: '628123456789@c.us' },
    { lid: '222222222222222@lid', pn: '628123456789@c.us' },
  ];
  client.sendMessage = async (chatId) => {
    sendCalls += 1;
    assert.equal(chatId, '628123456789@c.us');
    return { id: { $1: 'pn_confirmed_id' }, ack: 1 };
  };
  manager.client = client;
  manager.state = STATES.READY;

  const result = await manager.sendMessage('628123456789@c.us', 'pesan konflik');
  assert.equal(result.id.$1, 'pn_confirmed_id');
  assert.equal(sendCalls, 1);
});

test('event message_create memulihkan ID ketika sendMessage mengembalikan undefined', async () => {
  const manager = new WhatsAppClientManager();
  const client = new EventEmitter();
  client.getNumberId = async () => ({ _serialized: 'resolved@c.us' });
  client.sendMessage = async () => {
    const delivered = {
      id: { _serialized: 'event_confirmed_id', fromMe: true },
      fromMe: true,
      to: 'resolved@c.us',
      body: 'pesan fallback',
      ack: 0,
    };
    client.emit('message_create', delivered);
    client.emit('message_ack', { ...delivered, ack: 1 }, 1);
    return undefined;
  };
  manager.client = client;
  manager.state = STATES.READY;

  const result = await manager.sendMessage('628123456789@c.us', 'pesan fallback');
  assert.equal(result.id._serialized, 'event_confirmed_id');
  assert.equal(result.ack, 1);
  assert.equal(client.listenerCount('message_create'), 0);
  assert.equal(client.listenerCount('message_ack'), 0);
});

test('fallback event menolak korelasi ganda agar pesan tidak salah diklaim sent', async () => {
  const client = new EventEmitter();
  const observation = createSendObservation(client, {
    chatId: 'resolved@c.us',
    content: 'pesan sama',
  });
  for (const id of ['candidate_one', 'candidate_two']) {
    client.emit('message_create', {
      id: { _serialized: id, fromMe: true },
      fromMe: true,
      to: 'resolved@c.us',
      body: 'pesan sama',
      ack: 1,
    });
  }
  await assert.rejects(
    () => observation.resolve(undefined, 10),
    (error) => error.code === 'WHATSAPP_SEND_RESULT_AMBIGUOUS' && error.deliveryUnconfirmed,
  );
  observation.cleanup();
});

test('resolver incoming membedakan phone JID dari raw LID dan memetakan LID secara resmi', async () => {
  const manager = new WhatsAppClientManager();
  let mappingCalls = 0;
  const client = {
    getContactLidAndPhone: async (ids) => {
      mappingCalls += 1;
      assert.deepEqual(ids, ['987654321012345@lid']);
      return [{ lid: '987654321012345@lid', pn: '6281234567890@c.us' }];
    },
  };

  assert.equal(await manager.resolveIncomingPhone({ identifiers: ['6281234567890@c.us'] }, client), '6281234567890');
  assert.equal(mappingCalls, 0);
  assert.equal(await manager.resolveIncomingPhone({ identifiers: ['987654321012345'] }, client), null);
  assert.equal(await manager.resolveIncomingPhone({ identifiers: ['987654321012345@lid'] }, client), '6281234567890');
  assert.equal(await manager.resolveIncomingPhone({ identifiers: ['987654321012345@lid'] }, client), '6281234567890');
  assert.equal(mappingCalls, 1);
});

test('resolver incoming fail-closed untuk mapping LID yang konflik dan membatasi fallback nama', async () => {
  const manager = new WhatsAppClientManager();
  const client = {
    getContactLidAndPhone: async () => [
      { lid: '111111111111111@lid', pn: '628111111111@c.us' },
      { lid: '222222222222222@lid', pn: '628222222222@c.us' },
    ],
  };
  assert.equal(await manager.resolveIncomingPhone({
    identifiers: ['111111111111111@lid', '222222222222222@lid'],
  }, client), null);
  assert.equal(extractPhoneFromDisplayName('Kontak tanpa nomor'), null);
  assert.equal(extractPhoneFromDisplayName('+62 812-3456-7890'), '6281234567890');
  assert.deepEqual(parseWhatsAppIdentifier('6281234567890:7@c.us'), {
    serialized: '6281234567890:7@c.us',
    user: '6281234567890',
    server: 'c.us',
  });
});

test('replay incoming hanya memperbaiki contact kosong dan tidak menimpa atribusi kontak lama', () => {
  assert.deepEqual(buildDuplicateIncomingContactRepair(
    { id: 10, contact_id: null },
    { id: 20, phone_e164: '6281234567890' },
    '6281234567890',
  ), { contact_id: 20, from_phone: '6281234567890' });
  assert.equal(buildDuplicateIncomingContactRepair(
    { id: 10, contact_id: 99 },
    { id: 20, phone_e164: '6281234567890' },
    '6281234567890',
  ), null);
});
