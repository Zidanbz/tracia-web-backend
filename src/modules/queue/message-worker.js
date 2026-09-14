const os = require('os');
const knex = require('../../database/knex');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { manager } = require('../whatsapp/whatsapp-client-manager');
const {
  DELIVERY_SAFETY_CODES,
  isDeliverySafetyError,
} = require('../whatsapp/whatsapp-send-safety');
const { recipientStillEligible } = require('../campaigns/campaign-reblast');
const {
  isCampaignCompletionThankYou,
  isCampaignReviewAcknowledgement,
  isCampaignReviewDetailRequest,
} = require('../campaigns/campaign-attribution');
const {
  buildPacingMetadata,
  nextSendNotBefore,
} = require('./message-pacing');

function applyTrackedMessageFilter(builder, table = 'messages') {
  return builder
    .whereNotNull(`${table}.broadcast_id`)
    .orWhere((reply) => reply
      .where(`${table}.source`, 'campaign')
      .whereNull(`${table}.broadcast_id`));
}

function isTrackedMessage(message) {
  return Boolean(message?.broadcast_id)
    || (message?.source === 'campaign' && !message?.broadcast_id);
}

function globalPacingRange() {
  return {
    minimumMs: Math.max(
      env.messageWorker.broadcastRecipientIntervalMs,
      env.messageWorker.campaignAutoReplyDelayMs,
    ),
    maximumMs: Math.max(
      env.messageWorker.broadcastRecipientIntervalMaxMs,
      env.messageWorker.campaignAutoReplyDelayMaxMs,
    ),
  };
}

class MessageWorker {
  constructor() {
    this.workerId = `${os.hostname()}:${process.pid}`;
    this.running = false;
    this.timer = null;
    this.lastRecoveryAt = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
    logger.info({ workerId: this.workerId }, 'Message worker started');
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  getStatus() {
    return {
      configured: env.messageWorker.enabled,
      running: this.running,
      poll_ms: env.messageWorker.pollMs,
      broadcast_recipient_interval_ms: env.messageWorker.broadcastRecipientIntervalMs,
      broadcast_recipient_interval_max_ms: env.messageWorker.broadcastRecipientIntervalMaxMs,
      campaign_auto_reply_delay_ms: env.messageWorker.campaignAutoReplyDelayMs,
      campaign_auto_reply_delay_max_ms: env.messageWorker.campaignAutoReplyDelayMaxMs,
    };
  }

  schedule(delay = env.messageWorker.pollMs) {
    if (!this.running) return;
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref();
  }

  async tick() {
    try {
      if (Date.now() - this.lastRecoveryAt >= 60000) {
        await this.recoverStaleJobs();
        this.lastRecoveryAt = Date.now();
      }
      const job = await this.claim();
      if (job) await this.process(job);
    } catch (error) {
      logger.error({ err: error, workerId: this.workerId }, 'Message worker tick failed');
    } finally {
      this.schedule();
    }
  }

  async recoverStaleJobs() {
    const cutoff = new Date(Date.now() - env.messageWorker.lockTimeoutMs);
    const broadcastIds = await knex.transaction(async (trx) => {
      const staleJobs = await trx('message_jobs')
        .join('messages', 'messages.id', 'message_jobs.message_id')
        .whereIn('message_jobs.status', ['reserved', 'processing'])
        .where('message_jobs.locked_at', '<', cutoff)
        .select('message_jobs.id', 'message_jobs.message_id', 'message_jobs.status', 'messages.broadcast_id')
        .orderBy('message_jobs.id')
        .limit(100)
        // MariaDB 10.4 tidak mendukung SKIP LOCKED. FOR UPDATE tetap menjaga
        // recovery atomic; proses paralel akan menunggu lock, bukan mengambil
        // job yang sama.
        .forUpdate();
      const affectedBroadcasts = new Set();
      for (const job of staleJobs) {
        await trx('message_jobs').where({ id: job.id }).whereIn('status', ['reserved', 'processing']).update({
          status: 'pending', locked_at: null, locked_by: null, last_error_code: 'STALE_JOB_RECOVERED', updated_at: trx.fn.now(3),
        });
        await trx('messages').where({ id: job.message_id }).whereIn('status', ['queued', 'processing']).update({ status: 'queued', updated_at: trx.fn.now(3) });
        await trx('message_events').insert({ message_id: job.message_id, event_type: 'retry_scheduled', error_code: 'STALE_JOB_RECOVERED' });
        if (job.broadcast_id) affectedBroadcasts.add(job.broadcast_id);
      }
      if (staleJobs.length) logger.warn({ count: staleJobs.length }, 'Stale message jobs recovered');
      return [...affectedBroadcasts];
    });
    for (const broadcastId of broadcastIds) await this.refreshBroadcast(broadcastId);
  }

  async claim() {
    // Jangan menghabiskan retry ketika WhatsApp belum siap. Job tetap pending
    // dan otomatis dapat diklaim pada tick berikutnya setelah koneksi ready.
    if (!manager.getStatus().ready) return null;
    return knex.transaction(async (trx) => {
      // Row akun menjadi mutex claim lintas proses. Ini mencegah dua worker
      // melewati pemeriksaan global sebelum salah satunya sempat berstatus reserved.
      const account = await trx('whatsapp_accounts')
        .where({ public_id: 'default' })
        .forUpdate()
        .first('id');
      if (!account) return null;

      const inFlightTracked = await trx('message_jobs')
        .join('messages', 'messages.id', 'message_jobs.message_id')
        .whereIn('message_jobs.status', ['reserved', 'processing'])
        .where((builder) => applyTrackedMessageFilter(builder))
        .first('message_jobs.id');

      let trackedDeliveryAllowed = !inFlightTracked;
      if (trackedDeliveryAllowed) {
        const latestDelivery = await trx('messages')
          .where({ status: 'sent' })
          .whereNotNull('sent_at')
          .where((builder) => applyTrackedMessageFilter(builder))
          .select('id', 'sent_at')
          .orderBy('sent_at', 'desc')
          .orderBy('id', 'desc')
          .first();
        if (latestDelivery) {
          const sentEvent = await trx('message_events')
            .where({ message_id: latestDelivery.id, event_type: 'sent' })
            .orderBy('id', 'desc')
            .first('metadata');
          const { minimumMs } = globalPacingRange();
          const notBefore = nextSendNotBefore({
            ...latestDelivery,
            pacing_metadata: sentEvent?.metadata,
          }, minimumMs);
          trackedDeliveryAllowed = !notBefore || notBefore.getTime() <= Date.now();
        }
      }

      const jobQuery = trx('message_jobs')
        .join('messages', 'messages.id', 'message_jobs.message_id')
        .leftJoin('broadcasts', 'broadcasts.id', 'messages.broadcast_id')
        .leftJoin('campaigns', 'campaigns.id', 'messages.campaign_id')
        .where('message_jobs.status', 'pending')
        .where('message_jobs.available_at', '<=', trx.fn.now(3))
        .where((builder) => builder.whereNull('messages.broadcast_id').orWhereIn('broadcasts.status', ['scheduled', 'running']))
        .where((builder) => builder.whereNull('messages.campaign_id').orWhere('campaigns.status', 'active'))
        .select('message_jobs.*')
        .orderBy('message_jobs.id')
        // FOR UPDATE kompatibel dengan MariaDB 10.4 dan tetap mencegah dua
        // worker mengklaim row yang sama. SKIP LOCKED dapat diaktifkan kembali
        // setelah deployment MySQL 8 memiliki integration test tersendiri.
        .forUpdate();
      if (!trackedDeliveryAllowed) {
        // Pesan manual/non-Campaign tetap tidak ikut tertahan oleh antrean Campaign.
        jobQuery.whereNull('messages.broadcast_id').where((builder) => builder
          .whereNull('messages.source')
          .orWhereNot('messages.source', 'campaign'));
      }
      const job = await jobQuery.first();
      if (!job) return null;
      await trx('message_jobs').where({ id: job.id }).update({
        status: 'reserved', locked_at: trx.fn.now(3), locked_by: this.workerId, updated_at: trx.fn.now(3),
      });
      return { ...job, status: 'reserved' };
    });
  }

  async process(job) {
    const message = await knex('messages').where({ id: job.message_id }).first();
    if (!message) return this.fail(job, 'MESSAGE_NOT_FOUND');
    const contact = message.contact_id
      ? await knex('contacts').where({ id: message.contact_id }).whereNull('deleted_at').first()
      : null;
    if (!contact || contact.status !== 'active' || contact.consent_status !== 'granted') {
      return this.skip(job, message, 'RECIPIENT_NO_LONGER_ELIGIBLE');
    }
    if (message.campaign_id) {
      const isCompletionThankYou = isCampaignCompletionThankYou(message);
      const isReviewAcknowledgement = isCampaignReviewAcknowledgement(message);
      const isReviewDetailRequest = isCampaignReviewDetailRequest(message);
      const [campaignEligibility, membershipEligibility, broadcast] = await Promise.all([
        knex('campaigns').where({ id: message.campaign_id, status: 'active' }).first('id'),
        knex('campaign_contacts as membership')
          .leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'membership.id')
          .where({
            'membership.campaign_id': message.campaign_id,
            'membership.contact_id': message.contact_id,
            'membership.status': 'active',
          })
          .where((builder) => {
            if (isCompletionThankYou) builder.where('progress.status', 'completed');
            else if (isReviewAcknowledgement) builder.where('progress.status', 'needs_review');
            else if (isReviewDetailRequest) builder.where('progress.status', 'review_pending_details');
            else builder.whereNull('progress.status').orWhereNotIn(
              'progress.status', ['review_pending_details', 'completed', 'stopped', 'needs_review'],
            );
          })
          .first('membership.id'),
        message.broadcast_id
          ? knex('broadcasts').where({ id: message.broadcast_id }).first('campaign_delivery_type', 'campaign_target_session')
          : Promise.resolve(null),
      ]);
      if (!campaignEligibility || !membershipEligibility) {
        return this.skip(job, message, 'CAMPAIGN_RECIPIENT_NO_LONGER_ELIGIBLE');
      }
      if (broadcast && !await recipientStillEligible(
        knex,
        message.campaign_id,
        message.contact_id,
        broadcast.campaign_delivery_type,
        broadcast.campaign_target_session,
      )) {
        return this.skip(job, message, 'CAMPAIGN_REBLAST_TARGET_CHANGED');
      }
    }
    try {
      const started = await knex.transaction(async (trx) => {
        const affected = await trx('message_jobs').where({ id: job.id, status: 'reserved' }).update({ status: 'processing', updated_at: trx.fn.now(3) });
        if (!affected) return false;
        await trx('messages').where({ id: message.id }).update({ status: 'processing', updated_at: trx.fn.now(3) });
        await trx('message_events').insert({ message_id: message.id, event_type: 'processing' });
        return true;
      });
      if (!started) return;
      const result = await manager.sendMessage(`${message.recipient_phone_e164}@c.us`, message.body);
      const externalMessageId = result?.id?._serialized || result?.id?.id || null;
      if (!externalMessageId) {
        const error = new Error('WhatsApp tidak mengembalikan ID pesan terkonfirmasi');
        error.code = DELIVERY_SAFETY_CODES.RESULT_MISSING;
        error.deliveryUnconfirmed = true;
        throw error;
      }
      const sentAt = new Date();
      const pacingMetadata = isTrackedMessage(message)
        ? buildPacingMetadata(
          sentAt,
          globalPacingRange().minimumMs,
          globalPacingRange().maximumMs,
        )
        : null;
      const completed = await knex.transaction(async (trx) => {
        const affected = await trx('message_jobs').where({ id: job.id, status: 'processing' }).update({ status: 'completed', locked_at: null, locked_by: null, updated_at: trx.fn.now(3) });
        if (!affected) return false;
        await trx('messages').where({ id: message.id }).update({
          status: 'sent', sent_at: sentAt, external_message_id: externalMessageId, updated_at: trx.fn.now(3),
        });
        await trx('message_events').insert({
          message_id: message.id,
          event_type: 'sent',
          metadata: pacingMetadata ? JSON.stringify(pacingMetadata) : null,
        });
        if (message.broadcast_id) {
          await trx('broadcast_recipients').where({ message_id: message.id }).update({ status: 'sent' });
        }
        return true;
      });
      if (!completed) logger.warn({ jobId: job.id }, 'Sent message result arrived after job lock recovery; state remains ambiguous');
      if (message.broadcast_id) await this.refreshBroadcast(message.broadcast_id);
    } catch (error) {
      const deliveryUnconfirmed = isDeliverySafetyError(error);
      await this.fail(
        job,
        error.code || 'SEND_FAILED',
        message.id,
        message.broadcast_id,
        { retryable: !deliveryUnconfirmed, pauseBroadcast: deliveryUnconfirmed },
      );
      if (message.broadcast_id) await this.refreshBroadcast(message.broadcast_id);
    }
  }

  async skip(job, message, reason) {
    await knex.transaction(async (trx) => {
      const affected = await trx('message_jobs').where({ id: job.id, status: 'reserved' }).update({
        status: 'cancelled', locked_at: null, locked_by: null, last_error_code: reason, updated_at: trx.fn.now(3),
      });
      if (!affected) return;
      await trx('messages').where({ id: message.id }).update({ status: 'cancelled', updated_at: trx.fn.now(3) });
      await trx('message_events').insert({ message_id: message.id, event_type: 'cancelled', error_code: reason });
      await trx('broadcast_recipients').where({ message_id: message.id }).whereIn('status', ['pending', 'queued'])
        .update({ status: 'skipped', skip_reason: reason });
    });
    if (message.broadcast_id) await this.refreshBroadcast(message.broadcast_id);
  }

  async fail(job, errorCode, messageId = job.message_id, broadcastId = null, options = {}) {
    const attempts = Number(job.attempts) + 1;
    const retry = options.retryable !== false && attempts < Number(job.max_attempts);
    const availableAt = new Date(Date.now() + Math.min(300000, 30000 * (2 ** (attempts - 1))));
    return knex.transaction(async (trx) => {
      const affected = await trx('message_jobs').where({ id: job.id }).whereIn('status', ['reserved', 'processing']).update({
        status: retry ? 'pending' : 'failed', attempts,
        available_at: retry ? availableAt : job.available_at,
        locked_at: null, locked_by: null, last_error_code: errorCode, updated_at: trx.fn.now(3),
      });
      if (!affected) return false;
      if (messageId) {
        await trx('messages').where({ id: messageId }).update({
          status: retry ? 'queued' : 'failed', failed_at: retry ? null : trx.fn.now(3), updated_at: trx.fn.now(3),
        });
        await trx('message_events').insert({
          message_id: messageId,
          event_type: retry ? 'retry_scheduled' : (options.pauseBroadcast ? 'delivery_unconfirmed' : 'failed'),
          error_code: errorCode,
        });
        if (!retry) {
          await trx('broadcast_recipients').where({ message_id: messageId }).update({
            status: 'failed',
            skip_reason: errorCode,
          });
        }
      }
      if (options.pauseBroadcast && broadcastId) {
        await trx('broadcasts')
          .where({ id: broadcastId })
          .whereIn('status', ['scheduled', 'running'])
          .update({ status: 'paused', updated_at: trx.fn.now(3) });
      }
      return true;
    });
  }

  async refreshBroadcast(broadcastId) {
    const rows = await knex('messages').where({ broadcast_id: broadcastId }).select('status').count({ count: '*' }).groupBy('status');
    const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    const active = (counts.queued || 0) + (counts.processing || 0);
    const updates = {
      sent_count: counts.sent || 0,
      failed_count: counts.failed || 0,
      updated_at: knex.fn.now(3),
    };
    if (active === 0) {
      updates.status = counts.failed ? 'partially_failed' : 'completed';
      updates.completed_at = knex.fn.now(3);
    } else {
      updates.status = 'running';
      updates.started_at = knex.fn.now(3);
    }
    // Pause adalah keputusan operator. Progress counter boleh berubah, tetapi worker
    // tidak boleh diam-diam mengaktifkan kembali broadcast yang sedang di-pause.
    const broadcast = await knex('broadcasts').where({ id: broadcastId }).first('status');
    if (!broadcast || broadcast.status === 'cancelled') return;
    if (broadcast.status === 'paused') {
      delete updates.status;
      delete updates.started_at;
      delete updates.completed_at;
    }
    await knex('broadcasts').where({ id: broadcastId }).update(updates);
  }
}

module.exports = new MessageWorker();
