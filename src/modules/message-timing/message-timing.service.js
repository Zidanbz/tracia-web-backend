const { z } = require('zod');
const knex = require('../../database/knex');
const env = require('../../config/env');
const { maskPhone } = require('../../shared/data-masking');
const {
  actorFromRequest,
  applyScope,
  findScopedCampaign,
} = require('../campaigns/campaigns.service');

const MAX_TRACKED_ROWS = 50000;
const WINDOW_HOURS = Object.freeze([1, 6, 24, 72, 168]);

const optionalUuid = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.string().uuid().optional(),
);
const optionalDeliveryType = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.enum(['blast', 'reblast', 'reply']).optional(),
);
const optionalTimingStatus = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.enum(['safe', 'warning', 'collision']).optional(),
);
const filterSchema = z.object({
  campaign_public_id: optionalUuid,
  delivery_type: optionalDeliveryType,
  timing_status: optionalTimingStatus,
  window_hours: z.coerce.number().int().refine((value) => WINDOW_HOURS.includes(value), {
    message: 'Rentang waktu tidak didukung',
  }).optional().default(24),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function parseFilters(input = {}) {
  return filterSchema.parse(input);
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function deliveryIdentity(row) {
  if (row.broadcast_id !== null && row.broadcast_id !== undefined) {
    const reblast = ['reblast_no_reply', 'reblast_stalled'].includes(row.campaign_delivery_type);
    return { category: 'blast', delivery_type: reblast ? 'reblast' : 'blast' };
  }
  return { category: 'reply', delivery_type: 'reply' };
}

function compareRows(left, right) {
  const timeDifference = new Date(left.sent_at).getTime() - new Date(right.sent_at).getTime();
  return timeDifference || Number(left.id || 0) - Number(right.id || 0);
}

function analyzeTimingRows(rows, intervalMs) {
  let previous = null;
  return [...rows].sort(compareRows).map((row) => {
    const identity = deliveryIdentity(row);
    const sentAt = toIso(row.sent_at);
    const sentAtMs = sentAt ? new Date(sentAt).getTime() : null;
    const previousSentAtMs = previous?.sent_at ? new Date(previous.sent_at).getTime() : null;
    const gapMs = previous && sentAtMs !== null && previousSentAtMs !== null
      ? Math.max(0, sentAtMs - previousSentAtMs)
      : null;
    const isCrossType = Boolean(previous && previous.category !== identity.category);
    let timingStatus = 'not_applicable';
    if (isCrossType && gapMs === 0) timingStatus = 'collision';
    else if (isCrossType && gapMs < intervalMs) timingStatus = 'warning';
    else if (isCrossType) timingStatus = 'safe';

    const item = {
      id: Number(row.id),
      public_id: row.public_id,
      campaign: {
        public_id: row.campaign_public_id,
        title: row.campaign_title || 'Broadcast umum',
      },
      batch_name: row.batch_name || null,
      recipient_phone_masked: maskPhone(row.recipient_phone_e164),
      scheduled_at: toIso(row.scheduled_at),
      sent_at: sentAt,
      ...identity,
      gap_ms: gapMs,
      is_cross_type: isCrossType,
      timing_status: timingStatus,
      previous: previous ? {
        delivery_type: previous.delivery_type,
        category: previous.category,
        sent_at: previous.sent_at,
        campaign_title: previous.campaign.title,
      } : null,
    };
    previous = item;
    return item;
  });
}

function summarizeTimingRows(rows, intervalMs, intervalMaxMs = intervalMs) {
  const crossTypeRows = rows.filter((row) => row.is_cross_type);
  const gaps = crossTypeRows.map((row) => row.gap_ms).filter(Number.isFinite);
  const exactCollisions = crossTypeRows.filter((row) => row.timing_status === 'collision').length;
  const belowInterval = crossTypeRows.filter((row) => ['collision', 'warning'].includes(row.timing_status)).length;
  return {
    total_messages: rows.length,
    blast_messages: rows.filter((row) => row.delivery_type === 'blast').length,
    reblast_messages: rows.filter((row) => row.delivery_type === 'reblast').length,
    reply_messages: rows.filter((row) => row.delivery_type === 'reply').length,
    cross_type_checks: crossTypeRows.length,
    compliant_checks: crossTypeRows.length - belowInterval,
    below_interval_count: belowInterval,
    exact_collision_count: exactCollisions,
    minimum_cross_gap_ms: gaps.length ? Math.min(...gaps) : null,
    configured_interval_ms: intervalMs,
    configured_interval_max_ms: intervalMaxMs,
    compliant: belowInterval === 0,
  };
}

function paginateTimingRows(rows, filters) {
  let filtered = rows;
  if (filters.delivery_type) {
    filtered = filtered.filter((row) => row.delivery_type === filters.delivery_type);
  }
  if (filters.timing_status) {
    filtered = filtered.filter((row) => row.timing_status === filters.timing_status);
  }
  const total = filtered.length;
  const offset = (filters.page - 1) * filters.limit;
  return {
    data: [...filtered].reverse().slice(offset, offset + filters.limit),
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / filters.limit)),
    },
  };
}

function baseLogQuery(database, actor) {
  const query = database('messages as message')
    .leftJoin('campaigns as campaign', 'campaign.id', 'message.campaign_id')
    .leftJoin('broadcasts as broadcast', 'broadcast.id', 'message.broadcast_id')
    .where('message.status', 'sent')
    .whereNotNull('message.sent_at')
    .where((builder) => builder
      .whereNotNull('message.broadcast_id')
      .orWhere((reply) => reply.where('message.source', 'campaign').whereNull('message.broadcast_id')));
  applyScope(query, actor, 'campaign');
  return query.select(
    'message.id',
    'message.public_id',
    'message.broadcast_id',
    'message.recipient_phone_e164',
    'message.scheduled_at',
    'message.sent_at',
    'campaign.public_id as campaign_public_id',
    'campaign.title as campaign_title',
    'broadcast.name as batch_name',
    'broadcast.campaign_delivery_type',
  );
}

async function metadata(req, database = knex) {
  const actor = actorFromRequest(req);
  const query = database('campaigns as campaign')
    .select('campaign.public_id', 'campaign.title', 'campaign.status');
  applyScope(query, actor, 'campaign');
  const campaigns = await query.orderBy('campaign.title');
  const configuredIntervalMs = Math.max(
    env.messageWorker.broadcastRecipientIntervalMs,
    env.messageWorker.campaignAutoReplyDelayMs,
  );
  const configuredIntervalMaxMs = Math.max(
    env.messageWorker.broadcastRecipientIntervalMaxMs,
    env.messageWorker.campaignAutoReplyDelayMaxMs,
  );
  return {
    configured_interval_ms: configuredIntervalMs,
    configured_interval_min_ms: configuredIntervalMs,
    configured_interval_max_ms: configuredIntervalMaxMs,
    campaigns,
    window_hours: WINDOW_HOURS,
  };
}

async function list(req, input = {}, database = knex, nowMs = Date.now()) {
  const actor = actorFromRequest(req);
  const filters = parseFilters(input);
  if (filters.campaign_public_id) {
    await findScopedCampaign(filters.campaign_public_id, actor, database);
  }
  const from = new Date(nowMs - filters.window_hours * 60 * 60 * 1000);
  const until = new Date(nowMs);
  const [periodRows, precedingRow] = await Promise.all([
    baseLogQuery(database, actor)
      .where('message.sent_at', '>=', from)
      .where('message.sent_at', '<=', until)
      .orderBy('message.sent_at', 'asc')
      .orderBy('message.id', 'asc')
      .limit(MAX_TRACKED_ROWS + 1),
    baseLogQuery(database, actor)
      .where('message.sent_at', '<', from)
      .orderBy('message.sent_at', 'desc')
      .orderBy('message.id', 'desc')
      .first(),
  ]);
  if (periodRows.length > MAX_TRACKED_ROWS) {
    throw httpError(413, 'Log terlalu besar; pilih rentang waktu yang lebih pendek', 'MESSAGE_TIMING_RANGE_TOO_LARGE');
  }

  const intervalMs = Math.max(
    env.messageWorker.broadcastRecipientIntervalMs,
    env.messageWorker.campaignAutoReplyDelayMs,
  );
  const intervalMaxMs = Math.max(
    env.messageWorker.broadcastRecipientIntervalMaxMs,
    env.messageWorker.campaignAutoReplyDelayMaxMs,
  );
  const analyzed = analyzeTimingRows(precedingRow ? [precedingRow, ...periodRows] : periodRows, intervalMs)
    .filter((row) => row.sent_at && new Date(row.sent_at).getTime() >= from.getTime());
  const campaignRows = filters.campaign_public_id
    ? analyzed.filter((row) => row.campaign.public_id === filters.campaign_public_id)
    : analyzed;
  const result = paginateTimingRows(campaignRows, filters);
  return {
    ...result,
    summary: summarizeTimingRows(campaignRows, intervalMs, intervalMaxMs),
    range: { from: from.toISOString(), until: until.toISOString(), window_hours: filters.window_hours },
    generated_at: new Date(nowMs).toISOString(),
  };
}

module.exports = {
  WINDOW_HOURS,
  parseFilters,
  deliveryIdentity,
  analyzeTimingRows,
  summarizeTimingRows,
  paginateTimingRows,
  metadata,
  list,
};
