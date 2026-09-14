const { z } = require('zod');

const REBLAST_DELIVERY_TYPES = Object.freeze(['reblast_no_reply', 'reblast_stalled']);
const REBLAST_CONFIRMATION_PROMPT = 'Apakah Anda bersedia melanjutkan pengisian Tracer Study sekarang?\nBalas YA untuk melanjutkan atau TIDAK jika belum bersedia saat ini.';
const REBLAST_CONFIRMATION_RETRY_TEXT = `Mohon konfirmasi pilihan Anda.\n${REBLAST_CONFIRMATION_PROMPT}`;

const targetSchema = z.object({
  mode: z.enum(['no_reply', 'stalled']),
});

function parseReblastTarget(input) {
  const value = targetSchema.parse(input);
  return {
    mode: value.mode,
    sessionNumber: null,
    deliveryType: value.mode === 'stalled' ? 'reblast_stalled' : 'reblast_no_reply',
  };
}

function isReblastDeliveryType(deliveryType) {
  return REBLAST_DELIVERY_TYPES.includes(deliveryType);
}

function withReblastConfirmationPrompt(body) {
  const value = String(body || '').trim();
  if (value.includes(REBLAST_CONFIRMATION_PROMPT)) return value;
  return `${value}\n\n${REBLAST_CONFIRMATION_PROMPT}`.trim();
}

function parseReblastConfirmation(body) {
  const normalized = String(body || '')
    .toLocaleLowerCase('id-ID')
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return 'invalid';
  const tokens = new Set(normalized.split(' '));
  if (['tidak', 'nggak', 'enggak', 'gak', 'ga', 'no', 'stop', 'berhenti'].some((word) => tokens.has(word))) {
    return 'declined';
  }
  if (['ya', 'iya', 'yes', 'y', 'lanjut', 'bersedia', 'setuju'].some((word) => tokens.has(word))) {
    return 'accepted';
  }
  return 'invalid';
}

function targetQuery(database, campaignId, target) {
  const query = database('campaign_contacts as cc')
    .leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'cc.id')
    .where('cc.campaign_id', campaignId)
    .where('cc.status', 'active');

  if (target.mode === 'no_reply') {
    return query
      .whereExists(function hasDeliveredCampaignMessage() {
        this.select(database.raw('1')).from('messages as delivered')
          .whereRaw('delivered.contact_id = cc.contact_id')
          .where('delivered.campaign_id', campaignId)
          .where('delivered.status', 'sent')
          .whereRaw('(progress.reset_at IS NULL OR delivered.sent_at > progress.reset_at)');
      })
      .whereNotExists(function hasSessionAnswer() {
        this.select(database.raw('1')).from('campaign_incoming_messages as attribution')
          .whereRaw('attribution.campaign_contact_id = cc.id')
          .where('attribution.campaign_id', campaignId)
          .where('attribution.interaction_type', 'session_answer')
          .whereRaw('(progress.reset_at IS NULL OR attribution.attributed_at > progress.reset_at)');
      })
      .whereNotExists(function hasStartedProgress() {
        this.select(database.raw('1')).from('campaign_contact_progress as progress')
          .whereRaw('progress.campaign_contact_id = cc.id')
          .whereNot('progress.status', 'not_started');
      })
      // Incoming yang belum teratribusi tetap dianggap balasan secara konservatif.
      // Konfirmasi Reblast yang sudah teratribusi tidak mengeluarkan alumni dari
      // target agar jawaban TIDAK masih dapat diingatkan pada kesempatan berikutnya.
      .whereNotExists(function hasLaterUnattributedIncomingMessage() {
        this.select(database.raw('1')).from('incoming_messages as incoming')
          .leftJoin('campaign_incoming_messages as attribution', 'attribution.incoming_message_id', 'incoming.id')
          .whereRaw('incoming.contact_id = cc.contact_id')
          .whereNull('attribution.id')
          .whereRaw('(progress.reset_at IS NULL OR incoming.received_at > progress.reset_at)')
          .whereExists(function hasEarlierCampaignDelivery() {
            this.select(database.raw('1')).from('messages as earlier_delivery')
              .whereRaw('earlier_delivery.contact_id = cc.contact_id')
              .where('earlier_delivery.campaign_id', campaignId)
              .where('earlier_delivery.status', 'sent')
              .whereRaw('earlier_delivery.sent_at <= incoming.received_at');
          });
      });
  }

  return query
    .join('messages as waiting_message', 'waiting_message.id', 'progress.last_outbound_message_id')
    .where('progress.status', 'in_progress')
    .where('waiting_message.status', 'sent');
}

function eligibleTargetQuery(database, campaignId, target) {
  return targetQuery(database, campaignId, target)
    .join('contacts', 'contacts.id', 'cc.contact_id')
    .whereNull('contacts.deleted_at')
    .where('contacts.status', 'active')
    .where('contacts.consent_status', 'granted');
}

async function targetContactIds(database, campaignId, target) {
  const rows = await targetQuery(database, campaignId, target)
    .distinct('cc.contact_id');
  return rows.map((row) => Number(row.contact_id));
}

async function listTargetContacts(database, campaignId, target, pagination) {
  const base = () => eligibleTargetQuery(database, campaignId, target);
  const [{ count }] = await base().countDistinct({ count: 'cc.id' });
  const sessionSelection = target.mode === 'stalled'
    ? 'progress.current_session_number'
    : database.raw('NULL AS current_session_number');
  const rowsQuery = base()
    .select('cc.id as membership_id', 'contacts.id as contact_id', 'contacts.name', 'contacts.phone_e164', sessionSelection);
  if (target.mode === 'stalled') {
    rowsQuery.leftJoin('campaign_questions as current_question', 'current_question.id', 'progress.current_question_id')
      .select('current_question.title as current_question_title')
      .orderBy('progress.current_session_number');
  }
  const rows = await rowsQuery.orderBy('contacts.name')
    .limit(pagination.limit).offset((pagination.page - 1) * pagination.limit);
  return {
    data: rows.map((row) => ({
      ...row,
      current_session_number: row.current_session_number === null ? null : Number(row.current_session_number),
      current_question_title: row.current_question_title || null,
    })),
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      total: Number(count),
      total_pages: Math.max(1, Math.ceil(Number(count) / pagination.limit)),
    },
  };
}

async function findEligibleTargetContact(database, campaignId, target, membershipId) {
  const sessionSelection = target.mode === 'stalled'
    ? 'progress.current_session_number'
    : database.raw('NULL AS current_session_number');
  const query = eligibleTargetQuery(database, campaignId, target)
    .where('cc.id', membershipId)
    .select(
      'cc.id as membership_id',
      'contacts.id as contact_id',
      'contacts.name',
      'contacts.phone_e164',
      sessionSelection,
    );
  if (target.mode === 'stalled') {
    query.leftJoin('campaign_questions as current_question', 'current_question.id', 'progress.current_question_id')
      .select('current_question.title as current_question_title');
  }
  const row = await query.first();
  if (!row) return null;
  return {
    ...row,
    membership_id: Number(row.membership_id),
    contact_id: Number(row.contact_id),
    current_session_number: row.current_session_number === null ? null : Number(row.current_session_number),
    current_question_title: row.current_question_title || null,
  };
}

async function recipientStillEligible(database, campaignId, contactId, deliveryType, _targetSession) {
  if (!isReblastDeliveryType(deliveryType)) return true;
  const target = deliveryType === 'reblast_stalled'
    ? { mode: 'stalled', sessionNumber: null }
    : { mode: 'no_reply', sessionNumber: null };
  const row = await targetQuery(database, campaignId, target)
    .where('cc.contact_id', contactId)
    .first('cc.id');
  return Boolean(row);
}

module.exports = {
  REBLAST_CONFIRMATION_PROMPT,
  REBLAST_CONFIRMATION_RETRY_TEXT,
  findEligibleTargetContact,
  isReblastDeliveryType,
  listTargetContacts,
  parseReblastConfirmation,
  parseReblastTarget,
  recipientStillEligible,
  targetContactIds,
  withReblastConfirmationPrompt,
};
