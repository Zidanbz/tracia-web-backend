const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_STORE = 'memory';

const app = require('../app');
const {
  parseFilters,
  analyzeTimingRows,
  summarizeTimingRows,
  paginateTimingRows,
} = require('../src/modules/message-timing/message-timing.service');

function row(id, sentAt, { broadcast = false, reblast = false, campaign = 'Campaign A' } = {}) {
  return {
    id,
    public_id: `message-${id}`,
    broadcast_id: broadcast ? id : null,
    campaign_delivery_type: broadcast ? (reblast ? 'reblast_no_reply' : 'blast') : null,
    recipient_phone_e164: `628123456${String(id).padStart(4, '0')}`,
    scheduled_at: sentAt,
    sent_at: sentAt,
    campaign_public_id: '11111111-1111-4111-8111-111111111111',
    campaign_title: campaign,
    batch_name: broadcast ? `Batch ${id}` : null,
  };
}

test('filter Log Waktu Pesan membatasi rentang, tipe, status, dan pagination', () => {
  assert.deepEqual(parseFilters({
    campaign_public_id: '', delivery_type: 'reply', timing_status: 'warning',
    window_hours: '72', page: '2', limit: '25', ignored: 'value',
  }), {
    campaign_public_id: undefined,
    delivery_type: 'reply',
    timing_status: 'warning',
    window_hours: 72,
    page: 2,
    limit: 25,
  });
  assert.throws(() => parseFilters({ window_hours: '720' }));
  assert.throws(() => parseFilters({ timing_status: 'unknown' }));
});

test('analisis waktu mendeteksi timestamp Blast dan Reply yang sama serta jarak di bawah interval', () => {
  const analyzed = analyzeTimingRows([
    row(1, '2026-09-07T00:00:00.000Z', { broadcast: true }),
    row(2, '2026-09-07T00:00:00.000Z'),
    row(3, '2026-09-07T00:00:30.000Z'),
    row(4, '2026-09-07T00:01:05.000Z', { broadcast: true, reblast: true }),
    row(5, '2026-09-07T00:02:10.000Z'),
  ], 65000);

  assert.equal(analyzed[1].timing_status, 'collision');
  assert.equal(analyzed[1].gap_ms, 0);
  assert.equal(analyzed[2].timing_status, 'not_applicable');
  assert.equal(analyzed[3].timing_status, 'warning');
  assert.equal(analyzed[3].gap_ms, 35000);
  assert.equal(analyzed[4].timing_status, 'safe');
  assert.equal(analyzed[4].gap_ms, 65000);
  assert.equal(analyzed[4].recipient_phone_masked.endsWith('0005'), true);

  const summary = summarizeTimingRows(analyzed, 65000);
  assert.deepEqual(summary, {
    total_messages: 5,
    blast_messages: 1,
    reblast_messages: 1,
    reply_messages: 3,
    cross_type_checks: 3,
    compliant_checks: 1,
    below_interval_count: 2,
    exact_collision_count: 1,
    minimum_cross_gap_ms: 0,
    configured_interval_ms: 65000,
    configured_interval_max_ms: 65000,
    compliant: false,
  });
});

test('pagination log mempertahankan hasil terbaru dan filter konflik', () => {
  const analyzed = analyzeTimingRows([
    row(1, '2026-09-07T00:00:00.000Z', { broadcast: true }),
    row(2, '2026-09-07T00:00:00.000Z'),
    row(3, '2026-09-07T00:01:05.000Z', { broadcast: true }),
  ], 65000);
  const result = paginateTimingRows(analyzed, {
    timing_status: 'collision', delivery_type: undefined, page: 1, limit: 10,
  });
  assert.equal(result.pagination.total, 1);
  assert.equal(result.data[0].public_id, 'message-2');
});

test('halaman Log Waktu Pesan menggunakan permission Campaign dan asset khusus', async () => {
  const html = await new Promise((resolve, reject) => {
    app.render('message-timing/index', {
      title: 'Log Waktu Pesan', csrfToken: 'test-token',
      currentUser: { id: 7, name: 'Operator' }, currentPath: '/message-timing',
      roles: ['operator'], permissions: ['campaigns.view', 'campaigns.monitor'],
    }, (error, output) => (error ? reject(error) : resolve(output)));
  });
  assert.match(html, /id="message-timing-page"/);
  assert.match(html, /id="message-timing-filter"/);
  assert.match(html, /id="message-timing-collision"/);
  assert.match(html, /href="\/message-timing"/);
  assert.match(html, /nav-item active/);
  assert.match(html, /assets\/css\/message-timing\.css/);
  assert.match(html, /assets\/js\/message-timing\.js/);

  const withoutPermission = await new Promise((resolve, reject) => {
    app.render('dashboard', {
      title: 'Dashboard', csrfToken: 'test-token', currentUser: { id: 8, name: 'Viewer' },
      currentPath: '/dashboard', roles: ['viewer'], permissions: ['dashboard.view'],
    }, (error, output) => (error ? reject(error) : resolve(output)));
  });
  assert.doesNotMatch(withoutPermission, /href="\/message-timing"/);
});
