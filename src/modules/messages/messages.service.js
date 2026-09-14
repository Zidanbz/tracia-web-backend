const crypto = require('crypto');
const { z } = require('zod');
const knex = require('../../database/knex');
const { normalizePhone } = require('../../shared/phone');
const { isDeliverySafetyError } = require('../whatsapp/whatsapp-send-safety');

const createSchema = z.object({
  recipient_phone: z.union([z.string(), z.number()]),
  body: z.string().trim().min(1).max(10000),
  scheduled_at: z.coerce.date().optional(),
  idempotency_key: z.string().min(8).max(100).optional(),
  source: z.enum(['dashboard', 'api']).default('dashboard'),
});

const optionalDate = z.preprocess((value) => (value === '' ? undefined : value), z.coerce.date().optional());
const listSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['draft', 'queued', 'processing', 'sent', 'failed', 'cancelled']).optional(),
  source: z.enum(['dashboard', 'broadcast', 'api']).optional(),
  broadcast_id: z.coerce.number().int().positive().optional(),
  date_from: optionalDate,
  date_to: optionalDate,
});

async function enqueue(input, actorUserId = null) {
  const value = createSchema.parse(input);
  const unresolvedVariables = [...value.body.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)].map((match) => match[1]);
  if (unresolvedVariables.length) {
    const error = new Error(`Variabel template belum diisi: ${[...new Set(unresolvedVariables)].join(', ')}`);
    error.status = 422;
    error.code = 'UNRESOLVED_TEMPLATE_VARIABLES';
    throw error;
  }
  const phone = normalizePhone(value.recipient_phone);
  return knex.transaction(async (trx) => {
    const contact = await trx('contacts').where({ phone_e164: phone, status: 'active' }).whereNull('deleted_at').first();
    if (!contact || contact.consent_status !== 'granted') {
      const error = new Error('Penerima belum memiliki consent aktif');
      error.status = 422;
      error.code = 'CONSENT_REQUIRED';
      throw error;
    }
    const account = await trx('whatsapp_accounts').where({ public_id: 'default' }).first();
    if (!account) throw new Error('Akun WhatsApp default belum tersedia');

    const publicId = crypto.randomUUID();
    try {
      const [messageId] = await trx('messages').insert({
        public_id: publicId,
        whatsapp_account_id: account.id,
        contact_id: contact.id,
        recipient_phone_e164: phone,
        message_type: 'text',
        body: value.body,
        source: value.source,
        status: 'queued',
        scheduled_at: value.scheduled_at || trx.fn.now(3),
        idempotency_key: value.idempotency_key || null,
        created_by: actorUserId,
      });
      await trx('message_jobs').insert({
        message_id: messageId,
        status: 'pending',
        available_at: value.scheduled_at || trx.fn.now(3),
      });
      await trx('message_events').insert({ message_id: messageId, event_type: 'queued' });
      return trx('messages').where({ id: messageId }).first();
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY' && value.idempotency_key) {
        error.status = 409;
        error.code = 'DUPLICATE_IDEMPOTENCY_KEY';
        error.message = 'Request dengan idempotency key tersebut sudah diproses';
      }
      throw error;
    }
  });
}

async function list(input = {}) {
  const value = listSchema.parse(input);
  const safeLimit = value.limit;
  const safePage = value.page;
  const query = knex('messages');
  if (value.status) query.where('status', value.status);
  if (value.source) query.where('source', value.source);
  if (value.broadcast_id) query.where('broadcast_id', value.broadcast_id);
  if (value.date_from) query.where('created_at', '>=', value.date_from);
  if (value.date_to) query.where('created_at', '<=', value.date_to);
  const [{ total }] = await query.clone().count({ total: '*' });
  const data = await query.select('*').orderBy('id', 'desc').limit(safeLimit).offset((safePage - 1) * safeLimit);
  return { data, meta: { page: safePage, limit: safeLimit, total: Number(total) } };
}

async function detail(publicId) {
  const message = await knex('messages').where({ public_id: publicId }).first();
  if (!message) {
    const error = new Error('Pesan tidak ditemukan'); error.status = 404; throw error;
  }
  const events = await knex('message_events').where({ message_id: message.id }).orderBy('id');
  return { ...message, events };
}

async function retry(publicId) {
  return knex.transaction(async (trx) => {
    const message = await trx('messages').where({ public_id: publicId }).forUpdate().first();
    if (!message) {
      const error = new Error('Pesan tidak ditemukan'); error.status = 404; throw error;
    }
    if (message.status !== 'failed') {
      const error = new Error('Hanya pesan gagal yang dapat dicoba ulang'); error.status = 409; throw error;
    }
    const job = await trx('message_jobs').where({ message_id: message.id }).first('last_error_code');
    if (isDeliverySafetyError(job?.last_error_code)) {
      const error = new Error('Pesan tidak dapat dicoba ulang karena hasil pengiriman sebelumnya tidak terkonfirmasi');
      error.status = 409;
      error.code = 'UNCONFIRMED_DELIVERY_RETRY_BLOCKED';
      throw error;
    }
    await trx('messages').where({ id: message.id }).update({ status: 'queued', failed_at: null, updated_at: trx.fn.now(3) });
    await trx('message_jobs').where({ message_id: message.id }).update({
      status: 'pending', attempts: 0, available_at: trx.fn.now(3), locked_at: null, locked_by: null, last_error_code: null,
    });
    await trx('message_events').insert({ message_id: message.id, event_type: 'retried' });
    return trx('messages').where({ id: message.id }).first();
  });
}

module.exports = { enqueue, list, detail, retry };
