const crypto = require('crypto');
const knex = require('../../database/knex');
const env = require('../../config/env');
const { maskEmail, maskPhone } = require('../../shared/data-masking');
const {
  REBLAST_CONFIRMATION_RETRY_TEXT,
  isReblastDeliveryType,
  parseReblastConfirmation,
} = require('./campaign-reblast');
const {
  formatInvalidAnswerMessage,
  formatQuestionMessage,
  getCurrentQuestion,
  getQuestion,
  matchQuestionOption,
  resolveQuestionRoute,
} = require('./campaign-questions');
const {
  REVIEW_DETAIL_PROMPT,
  buildReviewDetailReply,
} = require('./campaign-review-fields');
const { randomIntervalMs } = require('../queue/message-pacing');

const THANK_YOU_TEXT = 'Terima kasih banyak atas waktu dan partisipasi Anda dalam mengisi Tracer Study Alumni. Seluruh jawaban Anda telah kami terima dengan baik.';
const UNQUOTED_TERMINAL_PROGRESS_STATUSES = Object.freeze(['completed', 'stopped', 'needs_review']);

function calculateCampaignMessageAvailability(
  delayMs,
  nowMs = Date.now(),
  lastScheduledAt = null,
  maximumDelayMs = delayMs,
  randomInt,
) {
  const minimumDelay = Number(delayMs);
  if (!Number.isFinite(minimumDelay) || minimumDelay <= 0) return null;
  const delay = randomIntervalMs(minimumDelay, maximumDelayMs, randomInt);
  const earliestForIncoming = Number(nowMs) + delay;
  const lastScheduledMs = lastScheduledAt ? new Date(lastScheduledAt).getTime() : 0;
  const nextQueueSlot = Number.isFinite(lastScheduledMs) && lastScheduledMs > 0
    ? lastScheduledMs + delay
    : 0;
  return new Date(Math.max(earliestForIncoming, nextQueueSlot));
}

function isCampaignCompletionThankYou(message) {
  return message?.source === 'campaign'
    && /^campaign-reply:\d+:thank_you$/.test(String(message.idempotency_key || ''));
}

function isCampaignReviewAcknowledgement(message) {
  return message?.source === 'campaign'
    && /^campaign-reply:\d+:needs_review$/.test(String(message.idempotency_key || ''));
}

function isCampaignReviewDetailRequest(message) {
  return message?.source === 'campaign'
    && /^campaign-review:\d+:details(?:-retry)?:\d+$/.test(String(message.idempotency_key || ''));
}

function isReblastConfirmationMessage(message) {
  return isReblastDeliveryType(message?.campaign_delivery_type)
    || /^campaign-reblast:\d+:confirm:\d+$/.test(String(message?.idempotency_key || ''));
}

async function latestOutboundContext(incoming, campaignId, trx) {
  return trx('messages as messages')
    .leftJoin('broadcasts', 'broadcasts.id', 'messages.broadcast_id')
    .where({
      'messages.campaign_id': campaignId,
      'messages.contact_id': incoming.contact_id,
      'messages.status': 'sent',
    })
    .where('messages.sent_at', '<=', incoming.received_at)
    .select(
      'messages.id as outbound_message_id',
      'messages.source',
      'messages.idempotency_key',
      'broadcasts.campaign_delivery_type',
    )
    .orderBy('messages.sent_at', 'desc')
    .orderBy('messages.id', 'desc')
    .first();
}

function withOutboundContext(campaign, context) {
  return {
    ...campaign,
    outbound_message_id: context?.outbound_message_id || null,
    campaign_delivery_type: context?.campaign_delivery_type || null,
    is_reblast_confirmation: isReblastConfirmationMessage(context),
  };
}

async function enqueueCampaignMessage(trx, {
  campaignId,
  contact,
  idempotencyKey,
  body,
  delayMs = 0,
  delayMaxMs = delayMs,
}) {
  if (!body) return null;
  const accountQuery = trx('whatsapp_accounts').where({ public_id: 'default' });
  // Lock akun menjadi mutex lintas transaction agar dua incoming bersamaan
  // tidak memperoleh slot auto-reply yang sama.
  if (Number(delayMs) > 0) accountQuery.forUpdate();
  const account = await accountQuery.first();
  if (!account) throw new Error('Akun WhatsApp default belum tersedia');
  let outbound = await trx('messages').where({ source: 'campaign', idempotency_key: idempotencyKey }).first();
  if (!outbound) {
    const [{ last_scheduled_at: lastScheduledAt }] = Number(delayMs) > 0
        ? await trx('messages')
        .where({ source: 'campaign' })
        .whereNull('broadcast_id')
        // Tetap hitung slot yang baru saja selesai dikirim. Tanpa status sent,
        // transaksi berikutnya dapat kembali mengambil slot interval yang sama jika worker
        // menyelesaikan pesan sebelumnya tepat sebelum query ini dijalankan.
        .whereIn('status', ['queued', 'processing', 'sent'])
        .max({ last_scheduled_at: 'scheduled_at' })
      : [{ last_scheduled_at: null }];
    const enqueueNowMs = Date.now();
    const availableAt = calculateCampaignMessageAvailability(
      delayMs,
      enqueueNowMs,
      lastScheduledAt,
      delayMaxMs,
    )
      || trx.fn.now(3);
    const [messageId] = await trx('messages').insert({
      public_id: crypto.randomUUID(),
      whatsapp_account_id: account.id,
      contact_id: contact.id,
      campaign_id: campaignId,
      recipient_phone_e164: contact.phone_e164,
      message_type: 'text',
      body,
      source: 'campaign',
      status: 'queued',
      scheduled_at: availableAt,
      idempotency_key: idempotencyKey,
    });
    await trx('message_jobs').insert({ message_id: messageId, status: 'pending', available_at: availableAt });
    await trx('message_events').insert({
      message_id: messageId,
      event_type: 'queued',
      metadata: Number(delayMs) > 0 ? JSON.stringify({
        earliest_delay_ms: new Date(availableAt).getTime() - Math.max(
          enqueueNowMs,
          lastScheduledAt ? new Date(lastScheduledAt).getTime() : 0,
        ),
      }) : null,
    });
    outbound = { id: messageId };
  }
  return outbound.id;
}

function pendingReblastSession(progress) {
  return Math.max(1, Number(progress.current_session_number) || 1);
}

function nextReblastConfirmationState(progress, decision, canResume) {
  if (['completed', 'stopped', 'needs_review', 'review_pending_details'].includes(progress.status)) {
    return { action: 'already_completed', resumedSessionNumber: null, updates: {} };
  }
  if (decision === 'declined') {
    return { action: 'reblast_declined', resumedSessionNumber: null, updates: {} };
  }
  if (decision === 'accepted') {
    const resumedSessionNumber = pendingReblastSession(progress);
    return canResume
      ? {
        action: 'reblast_resumed',
        resumedSessionNumber,
        updates: { current_session_number: resumedSessionNumber, status: 'in_progress' },
      }
      : { action: 'reblast_accepted_deferred', resumedSessionNumber, updates: {} };
  }
  return { action: 'reblast_confirmation_required', resumedSessionNumber: null, updates: {} };
}

async function questionVariables(trx, campaignId, contact) {
  const campaign = await trx('campaigns').where({ id: campaignId }).first('university_group_id');
  const profile = campaign
    ? await trx('contact_academic_profiles as profile')
      .leftJoin('contact_groups as faculty', 'faculty.id', 'profile.faculty_group_id')
      .leftJoin('contact_groups as study_program', 'study_program.id', 'profile.study_program_group_id')
      .where({
        'profile.contact_id': contact.id,
        'profile.university_group_id': campaign.university_group_id,
      })
      .first(
        'profile.student_number', 'profile.entry_year', 'profile.email', 'profile.graduation_period',
        'faculty.name as faculty_name', 'study_program.name as study_program_name',
      )
    : null;
  return {
    nama: contact.name,
    nomor: contact.phone_e164,
    nomor_masked: maskPhone(contact.phone_e164),
    email: profile?.email,
    email_masked: maskEmail(profile?.email),
    nim: profile?.student_number,
    tahun_masuk: profile?.entry_year,
    fakultas: profile?.faculty_name,
    jurusan: profile?.study_program_name,
    periode_wisuda: profile?.graduation_period,
  };
}

function selectUnquotedCampaignCandidate(candidates) {
  return Array.isArray(candidates) && candidates.length === 1 ? candidates[0] : null;
}

function isUnquotedCampaignProgressEligible(status) {
  return !UNQUOTED_TERMINAL_PROGRESS_STATUSES.includes(String(status || 'not_started'));
}

function normalizeCampaignStartCommand(value) {
  return String(value || '')
    .toLocaleLowerCase('id-ID')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCampaignStartCommand(value) {
  const normalized = normalizeCampaignStartCommand(value);
  return /^(?:(?:ayo|yuk)\s+)?mulai+(?:\s+(?:ya|yah|yuk|dong|kak|sekarang))*$/.test(normalized);
}

function selectStartCampaignCandidate(candidates) {
  if (!Array.isArray(candidates)) return null;
  const notStarted = candidates
    .filter((candidate) => ['not_started', ''].includes(String(candidate.progress_status || '')))
    .sort((left, right) => new Date(right.sent_at).getTime() - new Date(left.sent_at).getTime());
  if (!notStarted.length) return null;
  if (notStarted.length > 1
    && new Date(notStarted[0].sent_at).getTime() === new Date(notStarted[1].sent_at).getTime()) {
    return null;
  }
  return notStarted[0];
}

function selectLatestOutboundCampaignCandidate(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const latestSentAt = new Date(candidates[0].sent_at).getTime();
  if (!Number.isFinite(latestSentAt)) return null;
  const runnerUpSentAt = candidates[1] ? new Date(candidates[1].sent_at).getTime() : null;
  if (Number.isFinite(runnerUpSentAt) && latestSentAt <= runnerUpSentAt) return null;
  return candidates[0];
}

function selectLatestReblastCampaignCandidate(candidates, latestOutbound) {
  if (!Array.isArray(candidates) || !candidates.length || !isReblastConfirmationMessage(latestOutbound)) {
    return null;
  }

  const latest = candidates[0];
  const latestSentAt = new Date(latest.sent_at).getTime();
  if (!Number.isFinite(latestSentAt)) return null;

  const runnerUpSentAt = candidates[1] ? new Date(candidates[1].sent_at).getTime() : null;
  if (Number.isFinite(runnerUpSentAt) && latestSentAt <= runnerUpSentAt) return null;

  return latest;
}

function selectReviewDetailCampaignCandidate(candidates) {
  if (!Array.isArray(candidates)) return null;
  const pending = candidates.filter((candidate) => candidate.progress_status === 'review_pending_details');
  return pending.length === 1 ? pending[0] : null;
}

function buildReviewReconfirmationPlan(progress, currentQuestion, variables = {}) {
  if (!progress?.id || !currentQuestion?.id) {
    throw new TypeError('Progress dan pertanyaan konfirmasi wajib tersedia');
  }
  const reviewCycleId = progress.last_incoming_message_id || progress.id;
  return {
    body: formatQuestionMessage(currentQuestion, variables),
    idempotency_key: `campaign-review:${progress.id}:reconfirm:${reviewCycleId}:${currentQuestion.id}`,
    progress_update: {
      status: 'in_progress',
      current_question_id: currentQuestion.id,
      current_session_number: currentQuestion.position,
      review_fields: null,
      completed_at: null,
    },
  };
}

async function resolveCampaign(incoming, trx, options = {}) {
  if (!incoming.contact_id) return null;

  if (options.campaignId) {
    const forced = await trx('campaigns')
      .where({ id: options.campaignId })
      .first('id as campaign_id', 'status');
    if (!forced) return null;
    const context = await latestOutboundContext(incoming, forced.campaign_id, trx);
    return withOutboundContext({ ...forced, method: options.attributionMethod || 'manual' }, context);
  }

  if (incoming.quoted_wa_message_id) {
    const quoted = await trx('messages as messages')
      .join('campaigns', 'campaigns.id', 'messages.campaign_id')
      .leftJoin('broadcasts', 'broadcasts.id', 'messages.broadcast_id')
      .whereNotNull('messages.campaign_id')
      .where('messages.contact_id', incoming.contact_id)
      .where((builder) => builder
        .where('messages.external_message_id', incoming.quoted_wa_message_id)
        .orWhere('messages.external_message_id', 'like', `%${incoming.quoted_wa_message_id}%`))
      .select(
        'messages.campaign_id',
        'campaigns.status',
        'messages.id as outbound_message_id',
        'messages.source',
        'messages.idempotency_key',
        'broadcasts.campaign_delivery_type',
      )
      .orderBy('messages.sent_at', 'desc')
      .first();
    if (quoted) return withOutboundContext({ ...quoted, method: 'quoted_message' }, quoted);
  }

  const candidates = await trx('messages as messages')
    .join('campaigns', 'campaigns.id', 'messages.campaign_id')
    .join('campaign_contacts as membership', function joinCampaignMembership() {
      this.on('membership.campaign_id', '=', 'messages.campaign_id')
        .andOn('membership.contact_id', '=', 'messages.contact_id');
    })
    .leftJoin('campaign_contact_progress as progress', 'progress.campaign_contact_id', 'membership.id')
    .whereNotNull('messages.campaign_id')
    .where('messages.contact_id', incoming.contact_id)
    .where('messages.status', 'sent')
    .where('messages.sent_at', '<=', incoming.received_at)
    .where((builder) => builder.whereNull('progress.reset_at').orWhereRaw('messages.sent_at > progress.reset_at'))
    .whereIn('campaigns.status', ['active', 'paused'])
    .where('membership.status', 'active')
    .where((builder) => builder
      .whereNull('progress.status')
      .orWhereNotIn('progress.status', UNQUOTED_TERMINAL_PROGRESS_STATUSES))
    .select('messages.campaign_id', 'campaigns.status', 'progress.status as progress_status')
    .max({ sent_at: 'messages.sent_at' })
    .groupBy('messages.campaign_id', 'campaigns.status', 'progress.status')
    .orderBy('sent_at', 'desc')
    .limit(100);
  // Tanpa quote, progress terminal tidak boleh menangkap balasan baru. Pada kontak
  // multi-Campaign, outbound terakhir yang waktunya unik menjadi konteks percakapan;
  // timestamp seri tetap ambigu dan tidak boleh ditebak.
  const reviewDetailCandidate = selectReviewDetailCampaignCandidate(candidates);
  const latestCandidateContext = !reviewDetailCandidate && candidates.length
    ? await latestOutboundContext(incoming, candidates[0].campaign_id, trx)
    : null;
  const latestReblastCandidate = !reviewDetailCandidate
    ? selectLatestReblastCampaignCandidate(candidates, latestCandidateContext)
    : null;
  const startCandidate = !reviewDetailCandidate && !latestReblastCandidate && isCampaignStartCommand(incoming.body)
    ? selectStartCampaignCandidate(candidates)
    : null;
  const latestOutboundCandidate = !reviewDetailCandidate && !latestReblastCandidate && !startCandidate
    ? selectLatestOutboundCampaignCandidate(candidates)
    : null;
  const candidate = reviewDetailCandidate
    || latestReblastCandidate
    || startCandidate
    || latestOutboundCandidate
    || selectUnquotedCampaignCandidate(candidates);
  if (!candidate) return null;
  const context = latestReblastCandidate === candidate
    ? latestCandidateContext
    : await latestOutboundContext(incoming, candidate.campaign_id, trx);
  return withOutboundContext({
    ...candidate,
    method: reviewDetailCandidate || latestReblastCandidate || startCandidate || latestOutboundCandidate
      ? 'latest_outbound'
      : 'single_active_campaign',
  }, context);
}

async function attributeAndAdvance(incoming, options = {}) {
  return knex.transaction(async (trx) => {
    const existing = await trx('campaign_incoming_messages')
      .where({ incoming_message_id: incoming.id })
      .first();
    if (existing) return { attributed: true, campaign_id: existing.campaign_id, duplicate: true };

    const resolved = await resolveCampaign(incoming, trx, options);
    if (!resolved) return { attributed: false, ambiguous_or_missing: true };
    const membership = await trx('campaign_contacts')
      .where({ campaign_id: resolved.campaign_id, contact_id: incoming.contact_id })
      .first();
    if (!membership) return { attributed: false, ambiguous_or_missing: true };

    const startCommand = !resolved.is_reblast_confirmation && isCampaignStartCommand(incoming.body);
    const interactionType = resolved.is_reblast_confirmation
      ? 'reblast_confirmation'
      : startCommand ? 'start_command' : 'session_answer';
    const reblastDecision = resolved.is_reblast_confirmation
      ? parseReblastConfirmation(incoming.body)
      : null;

    await trx('campaign_incoming_messages').insert({
      incoming_message_id: incoming.id,
      campaign_id: resolved.campaign_id,
      campaign_contact_id: membership.id,
      attribution_method: resolved.method,
      interaction_type: interactionType,
      reblast_decision: reblastDecision,
      reply_to_message_id: resolved.outbound_message_id,
      attributed_by: options.attributedBy || null,
    });

    let progress = await trx('campaign_contact_progress')
      .where({ campaign_contact_id: membership.id })
      .forUpdate()
      .first();
    if (!progress) {
      await trx('campaign_contact_progress').insert({ campaign_contact_id: membership.id })
        .onConflict('campaign_contact_id').ignore();
      progress = await trx('campaign_contact_progress').where({ campaign_contact_id: membership.id }).forUpdate().first();
    }

    const contact = await trx('contacts').where({ id: membership.contact_id }).whereNull('deleted_at').first();
    const canAutoReply = resolved.status === 'active'
      && membership.status === 'active'
      && contact?.status === 'active'
      && contact?.consent_status === 'granted';
    const variables = contact ? await questionVariables(trx, resolved.campaign_id, contact) : {};

    if (resolved.is_reblast_confirmation) {
      const progressUpdate = {
        last_incoming_message_id: incoming.id,
        updated_at: trx.fn.now(3),
      };
      let autoReplyMessageId = null;
      const candidateSession = reblastDecision === 'accepted' ? pendingReblastSession(progress) : null;
      let question = null;
      if (canAutoReply && candidateSession) {
        question = progress.current_question_id
          ? await getQuestion(trx, resolved.campaign_id, { id: progress.current_question_id })
          : await getCurrentQuestion(trx, resolved.campaign_id, { position: candidateSession });
        if (!question) question = await getCurrentQuestion(trx, resolved.campaign_id, { afterPosition: 0 });
      }
      const questionBody = question ? formatQuestionMessage(question, variables) : null;
      const next = nextReblastConfirmationState(progress, reblastDecision, Boolean(questionBody));
      const { action, resumedSessionNumber } = next;
      Object.assign(progressUpdate, next.updates);

      if (action === 'reblast_resumed') {
        progressUpdate.started_at = progress.started_at || trx.fn.now(3);
        progressUpdate.current_question_id = question.id;
        progressUpdate.current_session_number = question.position;
        autoReplyMessageId = await enqueueCampaignMessage(trx, {
          campaignId: resolved.campaign_id,
          contact,
          body: questionBody,
          delayMs: env.messageWorker.campaignAutoReplyDelayMs,
          delayMaxMs: env.messageWorker.campaignAutoReplyDelayMaxMs,
          idempotencyKey: `campaign-reblast:${resolved.outbound_message_id || incoming.id}:resume:${question.id}`,
        });
      } else if (action === 'reblast_confirmation_required' && canAutoReply) {
        autoReplyMessageId = await enqueueCampaignMessage(trx, {
          campaignId: resolved.campaign_id,
          contact,
          body: REBLAST_CONFIRMATION_RETRY_TEXT,
          delayMs: env.messageWorker.campaignAutoReplyDelayMs,
          delayMaxMs: env.messageWorker.campaignAutoReplyDelayMaxMs,
          idempotencyKey: `campaign-reblast:${resolved.outbound_message_id || incoming.id}:confirm:${incoming.id}`,
        });
      }

      if (autoReplyMessageId) progressUpdate.last_outbound_message_id = autoReplyMessageId;
      await trx('campaign_contact_progress').where({ id: progress.id }).update(progressUpdate);
      await trx('incoming_messages').where({ id: incoming.id }).update({
        session_number: null,
        updated_at: trx.fn.now(3),
      });
      return {
        attributed: true,
        campaign_id: resolved.campaign_id,
        campaign_contact_id: membership.id,
        progress_id: progress.id,
        attribution_method: resolved.method,
        interaction_type: 'reblast_confirmation',
        reblast_decision: reblastDecision,
        action,
        question_session: null,
        resumed_session_number: question?.position || resumedSessionNumber,
        auto_reply_message_id: autoReplyMessageId,
      };
    }

    if (progress.status === 'review_pending_details') {
      const detailReply = buildReviewDetailReply(incoming.body);
      const progressUpdate = {
        last_incoming_message_id: incoming.id,
        updated_at: trx.fn.now(3),
      };
      let action;
      let autoReplyMessageId = null;
      await trx('campaign_incoming_messages').where({ incoming_message_id: incoming.id }).update({
        interaction_type: 'review_detail',
        campaign_question_id: null,
        campaign_question_option_id: null,
      });
      await trx('incoming_messages').where({ id: incoming.id }).update({
        session_number: null,
        updated_at: trx.fn.now(3),
      });

      if (detailReply.valid) {
        action = canAutoReply ? 'needs_review' : 'needs_review_deferred';
        Object.assign(progressUpdate, detailReply.progress_update);
        if (canAutoReply) {
          autoReplyMessageId = await enqueueCampaignMessage(trx, {
            campaignId: resolved.campaign_id,
            contact,
            body: detailReply.response_body,
            delayMs: env.messageWorker.campaignAutoReplyDelayMs,
            delayMaxMs: env.messageWorker.campaignAutoReplyDelayMaxMs,
            idempotencyKey: `campaign-reply:${incoming.id}:needs_review`,
          });
        }
      } else {
        action = canAutoReply ? 'review_details_invalid' : 'review_details_invalid_deferred';
        if (canAutoReply) {
          autoReplyMessageId = await enqueueCampaignMessage(trx, {
            campaignId: resolved.campaign_id,
            contact,
            body: detailReply.response_body,
            delayMs: env.messageWorker.campaignAutoReplyDelayMs,
            delayMaxMs: env.messageWorker.campaignAutoReplyDelayMaxMs,
            idempotencyKey: `campaign-review:${progress.id}:details-retry:${incoming.id}`,
          });
        }
      }

      if (autoReplyMessageId) progressUpdate.last_outbound_message_id = autoReplyMessageId;
      await trx('campaign_contact_progress').where({ id: progress.id }).update(progressUpdate);
      return {
        attributed: true,
        campaign_id: resolved.campaign_id,
        campaign_contact_id: membership.id,
        progress_id: progress.id,
        attribution_method: resolved.method,
        interaction_type: 'review_detail',
        action,
        question_session: null,
        review_fields: detailReply.fields,
        auto_reply_message_id: autoReplyMessageId,
      };
    }

    const update = { last_incoming_message_id: incoming.id, updated_at: trx.fn.now(3) };
    let currentQuestion = progress.current_question_id
      ? await getQuestion(trx, resolved.campaign_id, { id: progress.current_question_id })
      : null;
    if (!currentQuestion && Number(progress.current_session_number) > 0) {
      currentQuestion = await getCurrentQuestion(trx, resolved.campaign_id, { position: progress.current_session_number });
    }
    if (startCommand) {
      await trx('incoming_messages').where({ id: incoming.id }).update({
        session_number: null,
        updated_at: trx.fn.now(3),
      });
    }

    let action = 'none';
    let questionSession = null;
    let outboundBody = null;
    let outboundKey = null;

    if (['completed', 'stopped', 'needs_review'].includes(progress.status)) {
      action = 'already_completed';
    } else if (!currentQuestion) {
      const firstQuestion = await getCurrentQuestion(trx, resolved.campaign_id, { afterPosition: 0 });
      if (firstQuestion) {
        action = canAutoReply ? 'question' : 'none';
        questionSession = firstQuestion.position;
        update.current_question_id = firstQuestion.id;
        update.current_session_number = firstQuestion.position;
        update.status = 'in_progress';
        update.started_at = progress.started_at || trx.fn.now(3);
        if (canAutoReply) {
          outboundBody = formatQuestionMessage(firstQuestion, variables);
          outboundKey = `campaign-reply:${incoming.id}:question:${firstQuestion.id}`;
        }
      } else {
        action = 'no_active_question';
      }
    } else if (startCommand) {
      action = canAutoReply ? 'question_repeat' : 'question_repeat_deferred';
      questionSession = currentQuestion.position;
      if (canAutoReply) {
        outboundBody = formatQuestionMessage(currentQuestion, variables);
        outboundKey = `campaign-start:${incoming.id}:question:${currentQuestion.id}`;
      }
    } else {
      questionSession = currentQuestion.position;
      const answer = matchQuestionOption(currentQuestion, incoming.body);
      await trx('campaign_incoming_messages').where({ incoming_message_id: incoming.id }).update({
        campaign_question_id: currentQuestion.id,
        campaign_question_option_id: answer.option?.id || null,
      });
      await trx('incoming_messages').where({ id: incoming.id }).update({
        session_number: currentQuestion.position,
        updated_at: trx.fn.now(3),
      });

      if (!answer.valid) {
        action = canAutoReply ? 'invalid_answer' : 'invalid_answer_deferred';
        if (canAutoReply) {
          outboundBody = formatInvalidAnswerMessage(currentQuestion, variables);
          outboundKey = `campaign-answer:${incoming.id}:retry:${currentQuestion.id}`;
        }
      } else {
        const route = resolveQuestionRoute(currentQuestion, answer.option);
        const selectedAction = route.action;
        let nextQuestion = null;
        const selectedTargetId = route.targetQuestionId;
        if (selectedAction === 'goto' && selectedTargetId) {
          nextQuestion = await getQuestion(trx, resolved.campaign_id, {
            id: selectedTargetId,
            questionnaireId: currentQuestion.questionnaire_id,
          });
        } else if (selectedAction === 'next') {
          nextQuestion = await getQuestion(trx, resolved.campaign_id, {
            questionnaireId: currentQuestion.questionnaire_id,
            afterPosition: currentQuestion.position,
          });
        }

        if (selectedAction === 'review') {
          action = canAutoReply ? 'review_details_requested' : 'review_details_deferred';
          update.status = 'review_pending_details';
          update.review_fields = null;
          update.completed_at = null;
          if (canAutoReply) {
            outboundBody = REVIEW_DETAIL_PROMPT;
            outboundKey = `campaign-review:${progress.id}:details:${incoming.id}`;
          }
        } else if (selectedAction === 'complete') {
          action = canAutoReply ? 'thank_you' : 'completed';
          update.status = 'completed';
          update.completed_at = trx.fn.now(3);
          if (canAutoReply) {
            outboundBody = THANK_YOU_TEXT;
            outboundKey = `campaign-reply:${incoming.id}:thank_you`;
          }
        } else if (nextQuestion) {
          action = canAutoReply ? 'question' : 'question_deferred';
          update.current_question_id = nextQuestion.id;
          update.current_session_number = nextQuestion.position;
          update.status = 'in_progress';
          update.started_at = progress.started_at || trx.fn.now(3);
          if (canAutoReply) {
            outboundBody = formatQuestionMessage(nextQuestion, variables);
            outboundKey = `campaign-reply:${incoming.id}:question:${nextQuestion.id}`;
          }
        } else {
          action = canAutoReply ? 'thank_you' : 'completed';
          update.status = 'completed';
          update.completed_at = trx.fn.now(3);
          if (canAutoReply) {
            outboundBody = THANK_YOU_TEXT;
            outboundKey = `campaign-reply:${incoming.id}:thank_you`;
          }
        }
      }
    }

    await trx('campaign_contact_progress').where({ id: progress.id }).update(update);
    let autoReplyMessageId = null;
    if (outboundBody) {
      autoReplyMessageId = await enqueueCampaignMessage(trx, {
        campaignId: resolved.campaign_id,
        contact,
        body: outboundBody,
        delayMs: env.messageWorker.campaignAutoReplyDelayMs,
        delayMaxMs: env.messageWorker.campaignAutoReplyDelayMaxMs,
        idempotencyKey: outboundKey,
      });
      await trx('campaign_contact_progress').where({ id: progress.id }).update({
        last_outbound_message_id: autoReplyMessageId,
        updated_at: trx.fn.now(3),
      });
    }
    return {
      attributed: true,
      campaign_id: resolved.campaign_id,
      campaign_contact_id: membership.id,
      progress_id: progress.id,
      attribution_method: resolved.method,
      interaction_type: interactionType,
      action,
      question_session: questionSession,
      auto_reply_message_id: autoReplyMessageId,
    };
  });
}

async function resumeReviewedContactInTransaction(trx, campaignId, membershipId, options = {}) {
    const campaign = await trx('campaigns').where({ id: campaignId }).forUpdate().first('id', 'status');
    if (!campaign) {
      const error = new Error('Campaign tidak ditemukan');
      error.status = 404;
      error.code = 'CAMPAIGN_NOT_FOUND';
      throw error;
    }
    if (campaign.status !== 'active') {
      const error = new Error('Campaign harus aktif sebelum verifikasi diselesaikan');
      error.status = 409;
      error.code = 'CAMPAIGN_NOT_ACTIVE';
      throw error;
    }

    const membership = await trx('campaign_contacts as membership')
      .join('contacts', 'contacts.id', 'membership.contact_id')
      .where({ 'membership.id': membershipId, 'membership.campaign_id': campaignId })
      .whereNull('contacts.deleted_at')
      .forUpdate()
      .first(
        'membership.id', 'membership.status as membership_status',
        'contacts.id as contact_id', 'contacts.name', 'contacts.phone_e164',
        'contacts.status as contact_status', 'contacts.consent_status',
      );
    if (!membership) {
      const error = new Error('Kontak monitoring Campaign tidak ditemukan');
      error.status = 404;
      error.code = 'CAMPAIGN_MONITORING_CONTACT_NOT_FOUND';
      throw error;
    }
    if (membership.membership_status !== 'active'
      || membership.contact_status !== 'active'
      || membership.consent_status !== 'granted') {
      const error = new Error('Kontak tidak memenuhi syarat untuk melanjutkan questionnaire');
      error.status = 409;
      error.code = 'CAMPAIGN_CONTACT_NOT_ELIGIBLE';
      throw error;
    }

    const progress = await trx('campaign_contact_progress')
      .where({ campaign_contact_id: membership.id })
      .forUpdate()
      .first();
    if (!progress || progress.status !== 'needs_review') {
      const error = new Error('Kontak tidak sedang menunggu verifikasi data');
      error.status = 409;
      error.code = 'CAMPAIGN_CONTACT_REVIEW_NOT_PENDING';
      throw error;
    }

    const currentQuestion = progress.current_question_id
      ? await getQuestion(trx, campaignId, { id: progress.current_question_id })
      : null;
    if (!currentQuestion) {
      const error = new Error('Pertanyaan asal verifikasi tidak ditemukan');
      error.status = 409;
      error.code = 'CAMPAIGN_REVIEW_QUESTION_NOT_FOUND';
      throw error;
    }
    const correction = options.beforeResume
      ? await options.beforeResume({ trx, campaign, membership, progress, currentQuestion })
      : null;
    const contact = {
      id: membership.contact_id,
      name: correction?.contact?.name || membership.name,
      phone_e164: correction?.contact?.phone_e164 || membership.phone_e164,
    };
    const variables = await questionVariables(trx, campaignId, contact);
    const reconfirmation = buildReviewReconfirmationPlan(progress, currentQuestion, variables);
    const outboundMessageId = await enqueueCampaignMessage(trx, {
      campaignId,
      contact,
      body: reconfirmation.body,
      idempotencyKey: reconfirmation.idempotency_key,
    });
    await trx('campaign_contact_progress').where({ id: progress.id }).update({
      ...reconfirmation.progress_update,
      last_outbound_message_id: outboundMessageId,
      updated_at: trx.fn.now(3),
    });
    return {
      membership_id: Number(membership.id),
      progress_status: 'in_progress',
      current_session_number: Number(currentQuestion.position),
      current_question_title: currentQuestion.title,
      outbound_message_id: outboundMessageId,
      ...(correction?.result || {}),
    };
}

async function resumeReviewedContact(campaignId, membershipId, options = {}) {
  return knex.transaction((trx) => resumeReviewedContactInTransaction(trx, campaignId, membershipId, options));
}

module.exports = {
  attributeAndAdvance,
  buildReviewReconfirmationPlan,
  calculateCampaignMessageAvailability,
  isCampaignCompletionThankYou,
  isCampaignReviewAcknowledgement,
  isCampaignReviewDetailRequest,
  isReblastConfirmationMessage,
  isCampaignStartCommand,
  isUnquotedCampaignProgressEligible,
  nextReblastConfirmationState,
  resumeReviewedContact,
  resumeReviewedContactInTransaction,
  resolveCampaign,
  selectLatestReblastCampaignCandidate,
  selectLatestOutboundCampaignCandidate,
  selectReviewDetailCampaignCandidate,
  selectStartCampaignCandidate,
  selectUnquotedCampaignCandidate,
};
