const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_STORE = 'memory';

const messageWorker = require('../src/modules/queue/message-worker');
const {
  DELIVERY_SAFETY_CODES,
  isDeliverySafetyError,
} = require('../src/modules/whatsapp/whatsapp-send-safety');
const {
  randomIntervalMs,
  nextSendNotBefore,
  buildPacingMetadata,
} = require('../src/modules/queue/message-pacing');

test('worker tidak mengklaim job ketika WhatsApp belum ready', async () => {
  assert.equal(await messageWorker.claim(), null);
});

test('worker mengekspos status runtime untuk dashboard', () => {
  const status = messageWorker.getStatus();
  assert.equal(typeof status.configured, 'boolean');
  assert.equal(typeof status.running, 'boolean');
  assert.equal(typeof status.poll_ms, 'number');
  assert.equal(status.broadcast_recipient_interval_ms, 65000);
  assert.equal(status.broadcast_recipient_interval_max_ms, 120000);
  assert.equal(status.campaign_auto_reply_delay_ms, 65000);
  assert.equal(status.campaign_auto_reply_delay_max_ms, 120000);
});

test('konfigurasi menjadikan 65 detik minimum dan memvalidasi batas acak', () => {
  const cwd = path.resolve(__dirname, '..');
  const loadConfig = (overrides) => spawnSync(process.execPath, ['-e', 'require("./src/config/env")'], {
    cwd,
    env: {
      ...process.env,
      BROADCAST_RECIPIENT_INTERVAL_MS: '65000',
      BROADCAST_RECIPIENT_INTERVAL_MAX_MS: '120000',
      CAMPAIGN_AUTO_REPLY_DELAY_MS: '65000',
      CAMPAIGN_AUTO_REPLY_DELAY_MAX_MS: '120000',
      ...overrides,
    },
    encoding: 'utf8',
  });

  const invalidBlast = loadConfig({ BROADCAST_RECIPIENT_INTERVAL_MS: '64999' });
  const invalidReply = loadConfig({ CAMPAIGN_AUTO_REPLY_DELAY_MS: '64999' });
  const invalidRange = loadConfig({ BROADCAST_RECIPIENT_INTERVAL_MAX_MS: '64999' });
  const exactMinimum = loadConfig({
    BROADCAST_RECIPIENT_INTERVAL_MS: '65000',
    BROADCAST_RECIPIENT_INTERVAL_MAX_MS: '65000',
    CAMPAIGN_AUTO_REPLY_DELAY_MS: '65000',
    CAMPAIGN_AUTO_REPLY_DELAY_MAX_MS: '65000',
  });
  const abovePreviousMaximum = loadConfig({
    BROADCAST_RECIPIENT_INTERVAL_MS: '600000',
    BROADCAST_RECIPIENT_INTERVAL_MAX_MS: '700000',
    CAMPAIGN_AUTO_REPLY_DELAY_MS: '600000',
    CAMPAIGN_AUTO_REPLY_DELAY_MAX_MS: '700000',
  });

  assert.notEqual(invalidBlast.status, 0);
  assert.match(`${invalidBlast.stdout}${invalidBlast.stderr}`, /Invalid environment configuration/);
  assert.notEqual(invalidReply.status, 0);
  assert.match(`${invalidReply.stdout}${invalidReply.stderr}`, /Invalid environment configuration/);
  assert.notEqual(invalidRange.status, 0);
  assert.match(`${invalidRange.stdout}${invalidRange.stderr}`, /Invalid environment configuration/);
  assert.equal(exactMinimum.status, 0, exactMinimum.stderr);
  assert.equal(abovePreviousMaximum.status, 0, abovePreviousMaximum.stderr);
});

test('jeda acak bersifat inklusif dan gate tersimpan bertahan setelah restart', () => {
  assert.equal(randomIntervalMs(65000, 65000), 65000);
  assert.equal(randomIntervalMs(65000, 120000, () => 78000), 78000);
  assert.throws(() => randomIntervalMs(65000, 64000), /lebih kecil/);

  const sentAt = '2026-09-07T04:00:00.000Z';
  const metadata = buildPacingMetadata(sentAt, 65000, 120000, () => 78000);
  assert.deepEqual(metadata, {
    pacing_delay_ms: 78000,
    next_send_not_before: '2026-09-07T04:01:18.000Z',
  });
  assert.equal(nextSendNotBefore({
    sent_at: sentAt,
    pacing_metadata: JSON.stringify(metadata),
  }, 65000).toISOString(), '2026-09-07T04:01:18.000Z');
  assert.equal(nextSendNotBefore({
    sent_at: sentAt,
    pacing_metadata: null,
  }, 65000).toISOString(), '2026-09-07T04:01:05.000Z');
  assert.equal(nextSendNotBefore({
    sent_at: sentAt,
    pacing_metadata: JSON.stringify({ next_send_not_before: '2026-09-07T04:00:01.000Z' }),
  }, 65000).toISOString(), '2026-09-07T04:01:05.000Z');
});

test('error delivery tidak terkonfirmasi dikenali agar tidak di-retry otomatis', () => {
  for (const code of Object.values(DELIVERY_SAFETY_CODES)) {
    assert.equal(isDeliverySafetyError(code), true);
  }
  assert.equal(isDeliverySafetyError('SEND_FAILED'), false);
});
