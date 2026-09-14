const crypto = require('crypto');
const { z } = require('zod');
const knex = require('../../database/knex');
const {
  variablesFromBody,
  unsupportedVariables,
  renderContactTemplate,
} = require('../../shared/contact-template');

const schema = z.object({
  name: z.string().trim().min(2).max(180),
  body: z.string().trim().min(1).max(10000),
  contact_ids: z.array(z.coerce.number().int().positive()).max(10000),
  scheduled_at: z.coerce.date().optional(),
  idempotency_key: z.string().trim().min(8).max(100).optional(),
}).superRefine((value, context) => {
  const unsupported = unsupportedVariables(value.body);
  if (unsupported.length) {
    context.addIssue({
      code: 'custom',
      path: ['body'],
      message: `Variabel broadcast tidak didukung: ${unsupported.join(', ')}. Gunakan {{nama}} atau {{nomor}}.`,
    });
  }
});

async function preview(input) {
  const value = schema.parse(input);
  const contacts = await knex('contacts').whereIn('id', value.contact_ids).whereNull('deleted_at');
  const unique = new Map();
  let skipped = 0;
  for (const contact of contacts) {
    if (contact.status !== 'active' || contact.consent_status !== 'granted' || unique.has(contact.phone_e164)) {
      skipped += 1;
      continue;
    }
    try {
      const renderedBody = renderContactTemplate(value.body, contact);
      unique.set(contact.phone_e164, { contact, renderedBody });
    } catch (error) {
      if (error.code !== 'MISSING_CONTACT_TEMPLATE_DATA') throw error;
      skipped += 1;
    }
  }
  skipped += Math.max(0, value.contact_ids.length - contacts.length);
  const samples = [...unique.values()].slice(0, 3).map(({ contact, renderedBody }) => ({
    contact_id: contact.id,
    contact_name: contact.name,
    body: renderedBody,
  }));
  return {
    total: value.contact_ids.length,
    eligible: unique.size,
    skipped,
    variables: variablesFromBody(value.body),
    samples,
  };
}

async function create(input, actorUserId, options = {}) {
  const value = schema.parse(input);
  if (!value.contact_ids.length) {
    const error = new Error('Tidak ada target eligible untuk broadcast');
    error.status = 409;
    error.code = 'BROADCAST_HAS_NO_ELIGIBLE_TARGETS';
    throw error;
  }
  return knex.transaction(async (trx) => {
    if (options.campaignId) {
      const campaign = await trx('campaigns').where({ id: options.campaignId }).forUpdate().first();
      if (!campaign || campaign.status !== 'active') {
        const error = new Error('Campaign harus aktif sebelum blast');
        error.status = 409;
        error.code = 'CAMPAIGN_NOT_ACTIVE';
        throw error;
      }
      if (value.idempotency_key) {
        const existing = await trx('broadcasts').where({
          campaign_id: options.campaignId,
          campaign_idempotency_key: value.idempotency_key,
        }).first();
        if (existing) return existing;
      }
      const activeBatch = await trx('broadcasts')
        .where({ campaign_id: options.campaignId })
        .whereIn('status', ['scheduled', 'running', 'paused'])
        .first('id');
      if (activeBatch) {
        const error = new Error('Campaign masih memiliki batch blast aktif');
        error.status = 409;
        error.code = 'CAMPAIGN_ACTIVE_BLAST_EXISTS';
        throw error;
      }
    }
    const account = await trx('whatsapp_accounts').where({ public_id: 'default' }).first();
    if (!account) throw new Error('Akun WhatsApp default belum tersedia');
    const contacts = await trx('contacts').whereIn('id', value.contact_ids).whereNull('deleted_at');
    const contactById = new Map(contacts.map((contact) => [Number(contact.id), contact]));
    const seenPhones = new Set();
    const [broadcastId] = await trx('broadcasts').insert({
      public_id: crypto.randomUUID(),
      campaign_id: options.campaignId || null,
      campaign_idempotency_key: options.campaignId ? value.idempotency_key || null : null,
      campaign_delivery_type: options.campaignId ? options.campaignDeliveryType || 'blast' : null,
      campaign_target_session: options.campaignTargetSession || null,
      name: value.name,
      whatsapp_account_id: account.id,
      body_snapshot: value.body,
      status: 'scheduled',
      scheduled_at: value.scheduled_at || trx.fn.now(3),
      total_count: value.contact_ids.length,
      created_by: actorUserId,
    });

    let queued = 0;
    let skipped = 0;
    for (const contactId of value.contact_ids) {
      const contact = contactById.get(Number(contactId));
      let skipReason = !contact ? 'CONTACT_NOT_FOUND'
        : contact.status !== 'active' ? `CONTACT_${contact.status.toUpperCase()}`
          : contact.consent_status !== 'granted' ? 'CONSENT_REQUIRED'
            : seenPhones.has(contact.phone_e164) ? 'DUPLICATE' : null;
      let renderedBody = null;
      if (!skipReason) {
        try {
          renderedBody = renderContactTemplate(value.body, contact);
        } catch (error) {
          if (error.code !== 'MISSING_CONTACT_TEMPLATE_DATA') throw error;
          skipReason = error.code;
        }
      }

      if (skipReason) {
        skipped += 1;
        if (contact && !seenPhones.has(contact.phone_e164)) {
          await trx('broadcast_recipients').insert({
            broadcast_id: broadcastId,
            contact_id: contact.id,
            recipient_phone_e164: contact.phone_e164,
            status: 'skipped',
            skip_reason: skipReason,
          });
          seenPhones.add(contact.phone_e164);
        }
        continue;
      }

      seenPhones.add(contact.phone_e164);
      const [messageId] = await trx('messages').insert({
        public_id: crypto.randomUUID(),
        whatsapp_account_id: account.id,
        contact_id: contact.id,
        broadcast_id: broadcastId,
        campaign_id: options.campaignId || null,
        recipient_phone_e164: contact.phone_e164,
        message_type: 'text',
        body: renderedBody,
        source: 'broadcast',
        status: 'queued',
        scheduled_at: value.scheduled_at || trx.fn.now(3),
        created_by: actorUserId,
      });
      await trx('message_jobs').insert({
        message_id: messageId,
        status: 'pending',
        available_at: value.scheduled_at || trx.fn.now(3),
      });
      await trx('message_events').insert({ message_id: messageId, event_type: 'queued' });
      await trx('broadcast_recipients').insert({
        broadcast_id: broadcastId,
        contact_id: contact.id,
        message_id: messageId,
        recipient_phone_e164: contact.phone_e164,
        status: 'queued',
      });
      queued += 1;
    }

    await trx('broadcasts').where({ id: broadcastId }).update({ queued_count: queued, skipped_count: skipped });
    return trx('broadcasts').where({ id: broadcastId }).first();
  });
}

async function list() {
  return knex('broadcasts').select('*').orderBy('id', 'desc').limit(100);
}

async function setStatus(publicId, action) {
  const transitions = {
    pause: { from: ['scheduled', 'running'], to: 'paused' },
    resume: { from: ['paused'], to: 'scheduled' },
    cancel: { from: ['draft', 'scheduled', 'running', 'paused'], to: 'cancelled' },
  };
  const transition = transitions[action];
  return knex.transaction(async (trx) => {
    const broadcast = await trx('broadcasts').where({ public_id: publicId }).forUpdate().first();
    if (!broadcast) {
      const error = new Error('Broadcast tidak ditemukan'); error.status = 404; throw error;
    }
    if (!transition.from.includes(broadcast.status)) {
      const error = new Error(`Broadcast tidak dapat melakukan aksi ${action}`); error.status = 409; throw error;
    }
    await trx('broadcasts').where({ id: broadcast.id }).update({ status: transition.to, updated_at: trx.fn.now(3) });
    if (action === 'cancel') {
      const messageIds = trx('messages').select('id').where({ broadcast_id: broadcast.id });
      await trx('message_jobs').whereIn('message_id', messageIds).whereIn('status', ['pending', 'reserved']).update({ status: 'cancelled' });
      // Pesan yang sudah processing dianggap in-flight dan dapat tetap terkirim.
      // Hanya pesan yang belum dimulai yang aman untuk dibatalkan.
      await trx('messages').where({ broadcast_id: broadcast.id }).where({ status: 'queued' }).update({ status: 'cancelled' });
      await trx('broadcast_recipients').where({ broadcast_id: broadcast.id }).whereIn('status', ['pending', 'queued'])
        .update({ status: 'skipped', skip_reason: 'BROADCAST_CANCELLED' });
    }
    return trx('broadcasts').where({ id: broadcast.id }).first();
  });
}

module.exports = { preview, create, list, setStatus };
