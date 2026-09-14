const knex = require('../../database/knex');
const { maskPhone } = require('../../shared/data-masking');

function countMap(rows) {
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

function deliveryRate(statusCounts) {
  const sent = Number(statusCounts.sent || 0);
  const failed = Number(statusCounts.failed || 0);
  const completed = sent + failed;
  return completed ? Number(((sent / completed) * 100).toFixed(1)) : 0;
}

async function getSummary({ days, access = {} }) {
  const safeDays = Math.min(Math.max(Number(days) || 7, 7), 30);
  const trendStart = knex.raw(`DATE_SUB(CURRENT_DATE(), INTERVAL ${safeDays - 1} DAY)`);
  const [
    messageRows,
    queueRows,
    queueHealth,
    staleQueue,
    trendRows,
    activeBroadcasts,
    activeBroadcastCount,
    recentFailures,
    contactRow,
    activeTemplateCount,
    account,
    auditRows,
  ] = await Promise.all([
    knex('messages')
      .where('created_at', '>=', knex.raw('CURRENT_DATE()'))
      .select('status').count({ count: '*' }).groupBy('status'),
    knex('message_jobs').select('status').count({ count: '*' }).groupBy('status'),
    knex('message_jobs')
      .whereIn('status', ['pending', 'reserved', 'processing'])
      .where('available_at', '<=', knex.raw('NOW(3)'))
      .min({ oldest_due_at: 'available_at' })
      .select(knex.raw("DATE_FORMAT(CURRENT_DATE(), '%Y-%m-%d') AS database_today"))
      .first(),
    knex('message_jobs')
      .whereIn('status', ['pending', 'reserved', 'processing'])
      .where('available_at', '<=', knex.raw('DATE_SUB(NOW(3), INTERVAL 10 MINUTE)'))
      .count({ count: '*' }).first(),
    knex('messages')
      .where('created_at', '>=', trendStart)
      .select(knex.raw("DATE_FORMAT(created_at, '%Y-%m-%d') AS report_date"), 'status')
      .count({ count: '*' })
      .groupByRaw("DATE_FORMAT(created_at, '%Y-%m-%d'), status")
      .orderBy('report_date'),
    access.broadcasts
      ? knex('broadcasts')
        .whereIn('status', ['scheduled', 'running', 'paused'])
        .select('public_id', 'name', 'status', 'total_count', 'queued_count', 'sent_count', 'failed_count', 'skipped_count', 'scheduled_at')
        .orderBy('created_at', 'desc').limit(5)
      : Promise.resolve([]),
    access.broadcasts
      ? knex('broadcasts').whereIn('status', ['scheduled', 'running', 'paused']).count({ count: '*' }).first()
      : Promise.resolve({ count: 0 }),
    access.messages
      ? knex('messages')
        .leftJoin('message_jobs', 'message_jobs.message_id', 'messages.id')
        .where('messages.status', 'failed')
        .select(
          'messages.public_id', 'messages.recipient_phone_e164', 'messages.source', 'messages.failed_at', 'messages.updated_at',
          'message_jobs.attempts', 'message_jobs.last_error_code',
        )
        .orderByRaw('COALESCE(messages.failed_at, messages.updated_at) DESC')
        .limit(5)
      : Promise.resolve([]),
    access.contacts
      ? knex('contacts').whereNull('deleted_at').select(knex.raw(`
        COUNT(*) AS total,
        SUM(status = 'active' AND consent_status = 'granted') AS eligible,
        SUM(consent_status = 'unknown') AS consent_unknown,
        SUM(consent_status = 'revoked') AS consent_revoked,
        SUM(status = 'opted_out') AS opted_out,
        SUM(status = 'invalid') AS invalid,
        SUM(status = 'blocked') AS blocked
      `)).first()
      : Promise.resolve(null),
    access.templates
      ? knex('message_templates').where({ status: 'active' }).count({ count: '*' }).first()
      : Promise.resolve({ count: 0 }),
    knex('whatsapp_accounts').where({ public_id: 'default' })
      .select('phone_number', 'last_connected_at', 'last_disconnected_at', 'last_error_code').first(),
    access.audit
      ? knex('audit_logs').leftJoin('users', 'users.id', 'audit_logs.actor_user_id')
        .select('audit_logs.action', 'audit_logs.entity_type', 'audit_logs.created_at', 'users.name as actor_name')
        .orderBy('audit_logs.id', 'desc').limit(8)
      : Promise.resolve([]),
  ]);

  const messagesToday = countMap(messageRows);
  const queue = countMap(queueRows);
  const trendByDate = new Map();
  const databaseToday = new Date(`${queueHealth.database_today}T00:00:00Z`);
  for (let offset = safeDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(databaseToday);
    date.setUTCDate(databaseToday.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
    trendByDate.set(key, { date: key, sent: 0, failed: 0 });
  }
  for (const row of trendRows) {
    const key = String(row.report_date);
    if (!trendByDate.has(key)) trendByDate.set(key, { date: key, sent: 0, failed: 0 });
    if (row.status === 'sent' || row.status === 'failed') trendByDate.get(key)[row.status] = Number(row.count);
  }

  return {
    messages_today: messagesToday,
    delivery_success_rate: deliveryRate(messagesToday),
    queue: {
      ...queue,
      active: Number(queue.pending || 0) + Number(queue.reserved || 0) + Number(queue.processing || 0),
      oldest_due_at: queueHealth?.oldest_due_at || null,
      stale_count: Number(staleQueue?.count || 0),
    },
    trend: [...trendByDate.values()],
    active_broadcast_count: Number(activeBroadcastCount?.count || 0),
    active_broadcasts: activeBroadcasts.map((broadcast) => ({
      ...broadcast,
      total_count: Number(broadcast.total_count),
      queued_count: Number(broadcast.queued_count),
      sent_count: Number(broadcast.sent_count),
      failed_count: Number(broadcast.failed_count),
      skipped_count: Number(broadcast.skipped_count),
    })),
    recent_failures: recentFailures.map((message) => ({
      ...message,
      recipient_phone_e164: maskPhone(message.recipient_phone_e164),
      attempts: Number(message.attempts || 0),
    })),
    contacts: Object.fromEntries(Object.entries(contactRow || {}).map(([key, value]) => [key, Number(value || 0)])),
    active_template_count: Number(activeTemplateCount?.count || 0),
    whatsapp_account: account ? {
      phone_number: maskPhone(account.phone_number),
      last_connected_at: account.last_connected_at,
      last_disconnected_at: account.last_disconnected_at,
      last_error_code: account.last_error_code,
    } : null,
    recent_activity: auditRows,
  };
}

module.exports = { getSummary, deliveryRate };
