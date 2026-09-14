const crypto = require('crypto');
const knex = require('../../database/knex');
const { normalizePhone } = require('../../shared/phone');

const processingWaMessageIds = new Set();

function buildDuplicateIncomingContactRepair(existing, contact, normalizedPhone) {
  if (!existing?.id || existing.contact_id || !contact?.id) return null;
  return {
    contact_id: contact.id,
    from_phone: contact.phone_e164 || normalizedPhone,
  };
}

async function saveIncomingMessage({ fromPhone, fromName, body, hasMedia = false, mediaType = null, waMessageId = null, quotedWaMessageId = null, receivedAt = null }) {
  if (waMessageId && processingWaMessageIds.has(waMessageId)) {
    return { is_new: false, is_finished_session_10: false, already_completed: false };
  }

  if (waMessageId) {
    processingWaMessageIds.add(waMessageId);
  }

  try {
    return await _doSaveIncomingMessage({ fromPhone, fromName, body, hasMedia, mediaType, waMessageId, quotedWaMessageId, receivedAt });
  } finally {
    if (waMessageId) {
      processingWaMessageIds.delete(waMessageId);
    }
  }
}

async function _doSaveIncomingMessage({ fromPhone, fromName, body, hasMedia = false, mediaType = null, waMessageId = null, quotedWaMessageId = null, receivedAt = null }) {
  let phoneE164 = fromPhone;
  try {
    if (fromPhone) {
      phoneE164 = normalizePhone(fromPhone);
    }
  } catch (err) {
    phoneE164 = String(fromPhone || '').replace(/\D/g, '');
  }

  if (!phoneE164) {
    throw new Error('fromPhone tidak boleh kosong');
  }

  // Cek apakah nomor pengirim terdaftar di kontak (by phone_e164 atau by name)
  let contact = await knex('contacts')
    .select('id', 'name', 'phone_e164')
    .where('phone_e164', phoneE164)
    .whereNull('deleted_at')
    .first();

  if (!contact && fromName) {
    contact = await knex('contacts')
      .select('id', 'name', 'phone_e164')
      .where('name', fromName)
      .whereNull('deleted_at')
      .first();
  }

  if (contact && contact.phone_e164) {
    phoneE164 = contact.phone_e164;
  }

  // Hitung histori balasan dari nomor pengirim ini
  const historyMsgs = await knex('incoming_messages')
    .select('session_number')
    .where('from_phone', phoneE164)
    .orderBy('received_at', 'desc')
    .orderBy('id', 'desc');

  const countSession10 = historyMsgs.filter((m) => m.session_number === 10).length;
  const lastMsg = historyMsgs[0] || null;

  let sessionNumber = 1;
  let isFinishedSession10 = false;
  let alreadyCompleted = false;

  if (lastMsg && typeof lastMsg.session_number === 'number') {
    if (lastMsg.session_number >= 10) {
      sessionNumber = 10;
      if (countSession10 === 1) {
        // Balasan pertama terhadap pertanyaan Sesi 10 menyelesaikan alur dan dapat memicu pesan penutup sekali.
        isFinishedSession10 = true;
      } else if (countSession10 >= 2) {
        // Balasan setelah alur selesai tetap dicatat, tetapi tidak memicu auto-reply.
        alreadyCompleted = true;
      }
    } else {
      sessionNumber = lastMsg.session_number + 1;
    }
  }

  // Cek cegah duplikasi wa_message_id jika ada
  if (waMessageId) {
    let existing = await knex('incoming_messages').where('wa_message_id', waMessageId).first();
    if (existing) {
      const repair = buildDuplicateIncomingContactRepair(existing, contact, phoneE164);
      if (repair) {
        await knex('incoming_messages')
          .where({ id: existing.id })
          .whereNull('contact_id')
          .update({ ...repair, updated_at: knex.fn.now(3) });
        existing = await knex('incoming_messages').where({ id: existing.id }).first();
      }
      const attribution = await require('../campaigns/campaign-attribution').attributeAndAdvance(existing);
      return { ...existing, campaign: attribution, is_new: false, is_finished_session_10: false, already_completed: false };
    }
  }

  const publicId = crypto.randomUUID();
  const now = new Date();
  const msgReceivedAt = receivedAt ? new Date(receivedAt) : now;

  const [id] = await knex('incoming_messages').insert({
    public_id: publicId,
    contact_id: contact ? contact.id : null,
    from_phone: phoneE164,
    from_name: fromName || (contact ? contact.name : null),
    body: body || '',
    has_media: Boolean(hasMedia),
    media_type: mediaType || null,
    wa_message_id: waMessageId || null,
    quoted_wa_message_id: quotedWaMessageId || null,
    session_number: sessionNumber,
    is_read: false,
    received_at: msgReceivedAt,
    created_at: now,
    updated_at: now,
  });

  const record = await knex('incoming_messages')
    .select(
      'incoming_messages.id',
      'incoming_messages.public_id',
      'incoming_messages.from_phone',
      'incoming_messages.from_name',
      'incoming_messages.body',
      'incoming_messages.has_media',
      'incoming_messages.media_type',
      'incoming_messages.session_number',
      'incoming_messages.is_read',
      'incoming_messages.received_at',
      'contacts.id as contact_id',
      'contacts.name as contact_name'
    )
    .leftJoin('contacts', 'incoming_messages.contact_id', 'contacts.id')
    .where('incoming_messages.id', id)
    .first();
  const attribution = await require('../campaigns/campaign-attribution').attributeAndAdvance({
    ...record,
    contact_id: record.contact_id,
    quoted_wa_message_id: quotedWaMessageId || null,
    received_at: record.received_at,
  });
  return {
    ...record,
    session_number: ['reblast_confirmation', 'start_command', 'review_detail'].includes(attribution.interaction_type)
      ? null
      : attribution.question_session ?? record.session_number,
    campaign: attribution,
    is_new: true,
    is_finished_session_10: attribution.attributed
      ? !['reblast_confirmation', 'start_command', 'review_detail'].includes(attribution.interaction_type)
        && ['thank_you', 'completed'].includes(attribution.action)
      : isFinishedSession10,
    already_completed: attribution.attributed ? attribution.action === 'already_completed' : alreadyCompleted,
  };
}

async function listIncomingMessages({ search = '', isRead = null, sessionNumber = null, page = 1, limit = 20 }) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * limitNum;

  const baseQuery = () => {
    const q = knex('incoming_messages')
      .leftJoin('contacts', 'incoming_messages.contact_id', 'contacts.id');

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      q.where((builder) => {
        builder.where('incoming_messages.from_phone', 'like', term)
          .orWhere('incoming_messages.from_name', 'like', term)
          .orWhere('incoming_messages.body', 'like', term)
          .orWhere('contacts.name', 'like', term);
      });
    }

    if (isRead !== null && isRead !== undefined && isRead !== '') {
      q.where('incoming_messages.is_read', isRead === 'true' || isRead === true || isRead === '1');
    }

    if (sessionNumber !== null && sessionNumber !== undefined && sessionNumber !== '' && sessionNumber !== 'all') {
      const sNum = parseInt(sessionNumber, 10);
      if (!isNaN(sNum) && sNum >= 1 && sNum <= 10) {
        q.where('incoming_messages.session_number', sNum);
      }
    }

    return q;
  };

  const countResult = await baseQuery().count({ total: 'incoming_messages.id' }).first();
  const total = parseInt(countResult?.total || 0, 10);

  const rows = await baseQuery()
    .select(
      'incoming_messages.public_id',
      'incoming_messages.from_phone',
      'incoming_messages.from_name',
      'incoming_messages.body',
      'incoming_messages.has_media',
      'incoming_messages.media_type',
      'incoming_messages.wa_message_id',
      'incoming_messages.session_number',
      'incoming_messages.is_read',
      'incoming_messages.received_at',
      'contacts.id as contact_id',
      'contacts.name as contact_name',
      'contacts.status as contact_status'
    )
    .orderBy('incoming_messages.received_at', 'desc')
    .limit(limitNum)
    .offset(offset);

  return {
    data: rows,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      total_pages: Math.ceil(total / limitNum) || 1,
    },
  };
}

async function getSummary() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [totalRow, unreadRow, todayRow, contactCountRow, sessionCountsRows] = await Promise.all([
    knex('incoming_messages').count({ count: '*' }).first(),
    knex('incoming_messages').where('is_read', false).count({ count: '*' }).first(),
    knex('incoming_messages').where('received_at', '>=', todayStart).count({ count: '*' }).first(),
    knex('incoming_messages').whereNotNull('contact_id').countDistinct({ count: 'contact_id' }).first(),
    knex('incoming_messages').select('session_number').count({ count: '*' }).groupBy('session_number'),
  ]);

  const sessions_breakdown = {};
  for (let i = 1; i <= 10; i++) {
    sessions_breakdown[i] = 0;
  }
  for (const row of sessionCountsRows) {
    const sNum = parseInt(row.session_number || 1, 10);
    if (sNum >= 1 && sNum <= 10) {
      sessions_breakdown[sNum] = parseInt(row.count || 0, 10);
    }
  }

  return {
    total: parseInt(totalRow?.count || 0, 10),
    unread: parseInt(unreadRow?.count || 0, 10),
    today: parseInt(todayRow?.count || 0, 10),
    registered_contacts: parseInt(contactCountRow?.count || 0, 10),
    sessions_breakdown,
  };
}

async function markAsRead(publicId) {
  const updated = await knex('incoming_messages')
    .where('public_id', publicId)
    .update({ is_read: true, updated_at: new Date() });

  if (!updated) return null;

  return knex('incoming_messages')
    .select('public_id', 'from_phone', 'from_name', 'is_read', 'updated_at')
    .where('public_id', publicId)
    .first();
}

async function markAllAsRead() {
  const updated = await knex('incoming_messages')
    .where('is_read', false)
    .update({ is_read: true, updated_at: new Date() });

  return { updated_count: updated };
}

async function clearAllIncomingMessages() {
  const countResult = await knex('incoming_messages').count({ count: '*' }).first();
  const totalToDelete = parseInt(countResult?.count || 0, 10);
  await knex('incoming_messages').del();
  return { deleted_count: totalToDelete };
}

module.exports = {
  saveIncomingMessage,
  buildDuplicateIncomingContactRepair,
  listIncomingMessages,
  getSummary,
  markAsRead,
  markAllAsRead,
  clearAllIncomingMessages,
};
