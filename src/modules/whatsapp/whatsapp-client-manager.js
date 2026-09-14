const EventEmitter = require('events');
const path = require('path');
const { Client, LocalAuth, MessageAck } = require('whatsapp-web.js');
const env = require('../../config/env');
const logger = require('../../config/logger');
const repository = require('./whatsapp.repository');
const {
  DELIVERY_SAFETY_CODES,
  createDeliverySafetyError,
} = require('./whatsapp-send-safety');

const STATES = Object.freeze({
  IDLE: 'idle',
  INITIALIZING: 'initializing',
  AWAITING_QR: 'awaiting_qr',
  READY: 'ready',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
});

function extractQrToken(payload) {
  if (typeof payload === 'string') return payload || null;
  return typeof payload?.qr === 'string' && payload.qr ? payload.qr : null;
}

function prepareSyncedMessages(rawMessages) {
  const unique = new Map();
  for (const message of Array.isArray(rawMessages) ? rawMessages : []) {
    if (!message || message.fromMe || !message.fromPhone) continue;
    const timestampMs = Number(message.timestampMs);
    const normalized = {
      ...message,
      timestampMs: Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : Date.now(),
    };
    const key = message.waMessageId
      ? `wa:${message.waMessageId}`
      : `fallback:${message.fromId || message.fromPhone}:${normalized.timestampMs}:${message.body || ''}`;
    if (!unique.has(key)) unique.set(key, normalized);
  }
  return [...unique.values()].sort((left, right) => left.timestampMs - right.timestampMs);
}

function parseWhatsAppIdentifier(value) {
  const serialized = typeof value === 'string' ? value.trim() : value?._serialized;
  if (!serialized || !serialized.includes('@')) return null;
  const [rawUser, server] = serialized.split('@');
  const user = String(rawUser || '').split(':')[0].replace(/\D/g, '');
  if (!user || !server) return null;
  return { serialized: `${rawUser}@${server}`, user, server };
}

function extractPhoneFromDisplayName(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.startsWith(env.defaultCountryCode) && digits.length >= 10 && digits.length <= 15
    ? digits
    : null;
}

function extractExternalMessageId(message) {
  // WhatsApp Web 2.3000.x memindahkan serialized MsgKey ke `$1`. Pertahankan
  // fallback ini sampai upstream kembali menormalisasi `_serialized`.
  const id = message?.id?._serialized || message?.id?.$1 || message?.id?.id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

function withSendTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(createDeliverySafetyError(
        DELIVERY_SAFETY_CODES.ACK_TIMEOUT,
        'Batas waktu pengiriman WhatsApp habis sebelum hasil dapat dikonfirmasi',
      )), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitForServerAck(client, sentMessage, timeoutMs) {
  const externalMessageId = extractExternalMessageId(sentMessage);
  if (!externalMessageId) {
    throw createDeliverySafetyError(
      DELIVERY_SAFETY_CODES.RESULT_MISSING,
      'WhatsApp tidak mengembalikan ID pesan',
    );
  }

  const initialAck = Number(sentMessage.ack);
  if (initialAck === MessageAck.ACK_ERROR) {
    throw createDeliverySafetyError(
      DELIVERY_SAFETY_CODES.ACK_ERROR,
      'WhatsApp menolak pengiriman pesan',
    );
  }
  if (initialAck >= MessageAck.ACK_SERVER) return Promise.resolve(sentMessage);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off('message_ack', onAck);
      client.off('disconnected', onDisconnected);
      client.off('auth_failure', onDisconnected);
      if (error) reject(error);
      else resolve(message);
    };
    const onAck = (message, ackValue) => {
      if (extractExternalMessageId(message) !== externalMessageId) return;
      const ack = Number(ackValue);
      if (ack === MessageAck.ACK_ERROR) {
        finish(createDeliverySafetyError(
          DELIVERY_SAFETY_CODES.ACK_ERROR,
          'WhatsApp menolak pengiriman pesan',
        ));
      } else if (ack >= MessageAck.ACK_SERVER) {
        finish(null, message || sentMessage);
      }
    };
    const onDisconnected = () => finish(createDeliverySafetyError(
      DELIVERY_SAFETY_CODES.CONNECTION_CHANGED,
      'Koneksi WhatsApp berubah sebelum pengiriman terkonfirmasi',
    ));
    const timer = setTimeout(() => finish(createDeliverySafetyError(
      DELIVERY_SAFETY_CODES.ACK_TIMEOUT,
      'ACK server WhatsApp tidak diterima dalam batas waktu',
    )), timeoutMs);
    timer.unref?.();

    client.on('message_ack', onAck);
    client.on('disconnected', onDisconnected);
    client.on('auth_failure', onDisconnected);

    // ACK dapat berubah tepat setelah sendMessage selesai, sebelum listener di atas
    // terpasang. Pemeriksaan ulang menutup race tersebut tanpa menganggap ACK_PENDING
    // sebagai keberhasilan.
    const currentAck = Number(sentMessage.ack);
    if (currentAck === MessageAck.ACK_ERROR) onAck(sentMessage, currentAck);
    else if (currentAck >= MessageAck.ACK_SERVER) onAck(sentMessage, currentAck);
  });
}

function normalizeMessageTarget(value) {
  if (typeof value === 'string') return value;
  return value?._serialized || null;
}

function createSendObservation(client, { chatId, chatAliases = [], content }) {
  const expectedBody = typeof content === 'string' ? content : null;
  const expectedTargets = new Set([chatId, ...chatAliases].filter(Boolean));
  const candidates = new Map();
  const ackByMessageId = new Map();
  let resolveFirstCandidate;
  const firstCandidate = new Promise((resolve) => { resolveFirstCandidate = resolve; });

  const matchesCurrentSend = (message) => {
    if (!message || expectedBody === null) return false;
    const fromMe = message.fromMe === true || message.id?.fromMe === true;
    const target = normalizeMessageTarget(message.to || message._data?.to);
    return fromMe && expectedTargets.has(target) && message.body === expectedBody;
  };
  const recordCandidate = (message) => {
    if (!matchesCurrentSend(message)) return;
    const id = extractExternalMessageId(message);
    if (!id) return;
    candidates.set(id, message);
    resolveFirstCandidate();
  };
  const onMessageCreate = (message) => recordCandidate(message);
  const onAck = (message, ackValue) => {
    const id = extractExternalMessageId(message);
    if (!id) return;
    ackByMessageId.set(id, Number(ackValue));
    recordCandidate(message);
  };

  client.on('message_create', onMessageCreate);
  client.on('message_ack', onAck);

  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const selectUniqueCandidate = () => {
    if (candidates.size === 0) return null;
    if (candidates.size > 1) {
      throw createDeliverySafetyError(
        DELIVERY_SAFETY_CODES.RESULT_AMBIGUOUS,
        'Lebih dari satu pesan WhatsApp cocok dengan pengiriman yang sedang diproses',
      );
    }
    return [...candidates.values()][0];
  };

  return {
    async resolve(sentMessage, timeoutMs) {
      if (extractExternalMessageId(sentMessage)) return sentMessage;
      if (candidates.size === 0 && timeoutMs > 0) {
        await Promise.race([firstCandidate, delay(timeoutMs)]);
      }
      if (candidates.size > 0 && timeoutMs > 0) {
        // Grace singkat untuk mendeteksi kandidat ganda sebelum memilih fallback.
        await delay(Math.min(50, timeoutMs));
      }
      return selectUniqueCandidate();
    },
    applyLatestAck(message) {
      const id = extractExternalMessageId(message);
      if (id && ackByMessageId.has(id)) message.ack = ackByMessageId.get(id);
      return message;
    },
    cleanup() {
      client.off('message_create', onMessageCreate);
      client.off('message_ack', onAck);
    },
  };
}

class WhatsAppClientManager extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.state = STATES.IDLE;
    this.initializationPromise = null;
    this.lastError = null;
    this.autoSyncInterval = null;
    this.syncPromise = null;
    this.lidPhoneCache = new Map();
    this.phoneLidCache = new Map();
  }

  getStatus() {
    return {
      status: this.state === STATES.READY ? 1 : 0,
      connection_state: this.state,
      ready: this.state === STATES.READY,
      error_code: this.lastError?.code || null,
    };
  }

  async connect() {
    if (this.initializationPromise || ![STATES.IDLE, STATES.DISCONNECTED, STATES.ERROR].includes(this.state)) {
      return { ...this.getStatus(), started: false };
    }

    this.state = STATES.INITIALIZING;
    this.lastError = null;
    this.client = this.createClient();
    this.persistState('initializing');
    this.initializationPromise = this.client.initialize()
      .catch(async (error) => {
        this.lastError = { code: error.code || 'INITIALIZATION_FAILED' };
        this.state = STATES.ERROR;
        logger.error({ err: error }, 'WhatsApp initialization failed');
        this.emit('connection_error', this.getStatus());
        await this.cleanupClient();
        this.persistState('error', { errorCode: this.lastError.code });
      })
      .finally(() => {
        this.initializationPromise = null;
      });

    return { ...this.getStatus(), started: true };
  }

  async reconnect() {
    if (this.initializationPromise) await this.initializationPromise;
    await this.cleanupClient();
    this.state = STATES.IDLE;
    return this.connect();
  }

  async logout() {
    const client = this.client;
    if (client) {
      await client.logout().catch((error) => logger.warn({ err: error }, 'WhatsApp logout failed'));
    }
    await this.cleanupClient();
    this.state = STATES.IDLE;
    this.lastError = null;
    this.persistState('idle');
    this.emit('disconnected', { reason: 'logout', ...this.getStatus() });
    return this.getStatus();
  }

  async destroy() {
    await this.cleanupClient();
    this.state = STATES.DISCONNECTED;
  }

  async sendMessage(target, content, options) {
    if (this.state !== STATES.READY || !this.client) {
      const error = new Error('WhatsApp belum terhubung');
      error.code = 'WHATSAPP_NOT_READY';
      error.status = 503;
      throw error;
    }

    let chatId = String(target || '').trim();
    if (!chatId.endsWith('@c.us') && !chatId.endsWith('@g.us') && !chatId.endsWith('@lid')) {
      const digits = chatId.replace(/\D/g, '');
      if (digits.length > 13 && !digits.startsWith('62')) {
        chatId = `${digits}@lid`;
      } else {
        chatId = `${digits}@c.us`;
      }
    }

    const chatAliases = new Set([chatId]);
    if (chatId.endsWith('@c.us')) {
      const digits = chatId.split('@')[0].replace(/\D/g, '');
      const resolved = await this.client.getNumberId(digits);
      if (!resolved) {
        const error = new Error('Nomor tujuan tidak terdaftar di WhatsApp');
        error.code = 'WHATSAPP_NOT_REGISTERED';
        error.status = 422;
        throw error;
      }
      const resolvedChatId = resolved._serialized || (resolved.user ? `${resolved.user}@${resolved.server || 'c.us'}` : null);
      if (!resolvedChatId) {
        const error = new Error('WhatsApp mengembalikan identitas tujuan yang tidak valid');
        error.code = 'WHATSAPP_TARGET_UNRESOLVED';
        throw error;
      }
      chatAliases.add(resolvedChatId);

      // getNumberId() pada era LID dapat mengembalikan @lid untuk nomor baru.
      // Pengiriman langsung ke LID tersebut gagal membangun sesi enkripsi pada
      // beberapa chat baru. Nomor sudah dibuktikan terdaftar oleh getNumberId,
      // jadi target pengiriman tetap PN; LID hanya dipakai sebagai alias receipt.
      chatId = `${digits}@c.us`;

      const cached = this.phoneLidCache.get(digits);
      if (cached && cached.expiresAt > Date.now()) {
        chatAliases.add(cached.lid);
      } else if (typeof this.client.getContactLidAndPhone === 'function') {
        try {
          const mappings = await this.client.getContactLidAndPhone([resolvedChatId]);
          const matchingLids = new Set();
          for (const mapping of Array.isArray(mappings) ? mappings : []) {
            const lid = parseWhatsAppIdentifier(mapping?.lid);
            const phone = parseWhatsAppIdentifier(mapping?.pn);
            if (!lid || lid.server !== 'lid' || !phone || !['c.us', 's.whatsapp.net'].includes(phone.server)) continue;
            if (phone.user === digits) matchingLids.add(lid.serialized);
          }
          if (matchingLids.size === 1) {
            const lid = [...matchingLids][0];
            const expiresAt = Date.now() + (60 * 60 * 1000);
            this.phoneLidCache.set(digits, { lid, expiresAt });
            this.lidPhoneCache.set(lid, { phone: digits, expiresAt });
            chatAliases.add(lid);
          } else if (matchingLids.size > 1) {
            logger.debug('WhatsApp outbound LID mapping ambiguous; PN target retained');
          }
        } catch (error) {
          logger.debug({ err: error.message }, 'WhatsApp outbound LID mapping unavailable');
        }
      }
    }

    const activeClient = this.client;
    const startedAt = Date.now();
    const observation = createSendObservation(activeClient, {
      chatId,
      chatAliases: [...chatAliases],
      content,
    });
    try {
      const directResult = await withSendTimeout(
        activeClient.sendMessage(chatId, content, { ...options, waitUntilMsgSent: true }),
        env.messageWorker.sendTimeoutMs,
      );
      if (this.client !== activeClient || this.state !== STATES.READY) {
        throw createDeliverySafetyError(
          DELIVERY_SAFETY_CODES.CONNECTION_CHANGED,
          'Koneksi WhatsApp berubah selama proses pengiriman',
        );
      }
      let remainingTimeoutMs = Math.max(
        1,
        env.messageWorker.sendTimeoutMs - (Date.now() - startedAt),
      );
      const sentMessage = await observation.resolve(
        directResult,
        Math.min(2000, remainingTimeoutMs),
      );
      remainingTimeoutMs = Math.max(
        1,
        env.messageWorker.sendTimeoutMs - (Date.now() - startedAt),
      );
      return await waitForServerAck(
        activeClient,
        observation.applyLatestAck(sentMessage),
        remainingTimeoutMs,
      );
    } finally {
      observation.cleanup();
    }
  }

  async checkNumberRegistered(phoneE164) {
    if (this.state !== STATES.READY || !this.client) {
      const error = new Error('WhatsApp belum terhubung');
      error.code = 'WHATSAPP_NOT_READY';
      error.status = 503;
      throw error;
    }
    const digits = String(phoneE164).replace(/\D/g, '');
    if (!digits) {
      const error = new Error('Nomor WhatsApp tidak valid');
      error.code = 'INVALID_PHONE';
      error.status = 422;
      throw error;
    }
    return Boolean(await this.client.getNumberId(digits));
  }

  async resolveIncomingPhone({ identifiers = [], fallbackName = null }, activeClient = this.client) {
    const parsed = [...new Set(
      identifiers
        .map(parseWhatsAppIdentifier)
        .filter(Boolean)
        .map((identifier) => identifier.serialized),
    )].map(parseWhatsAppIdentifier);

    const directPhones = new Set(parsed
      .filter((identifier) => ['c.us', 's.whatsapp.net'].includes(identifier.server))
      .map((identifier) => identifier.user));
    if (directPhones.size === 1) return [...directPhones][0];
    if (directPhones.size > 1) return null;

    const lidIdentifiers = parsed.filter((identifier) => identifier.server === 'lid');
    const now = Date.now();
    const mappedPhones = new Set();
    const unresolved = [];
    for (const identifier of lidIdentifiers) {
      const cached = this.lidPhoneCache.get(identifier.serialized);
      if (cached && cached.expiresAt > now) mappedPhones.add(cached.phone);
      else unresolved.push(identifier.serialized);
    }

    if (unresolved.length && typeof activeClient?.getContactLidAndPhone === 'function') {
      try {
        const mappings = await activeClient.getContactLidAndPhone(unresolved);
        for (const mapping of Array.isArray(mappings) ? mappings : []) {
          const lid = parseWhatsAppIdentifier(mapping?.lid);
          const phone = parseWhatsAppIdentifier(mapping?.pn);
          if (!lid || lid.server !== 'lid' || !phone || !['c.us', 's.whatsapp.net'].includes(phone.server)) continue;
          this.lidPhoneCache.set(lid.serialized, {
            phone: phone.user,
            expiresAt: now + (60 * 60 * 1000),
          });
          this.phoneLidCache.set(phone.user, {
            lid: lid.serialized,
            expiresAt: now + (60 * 60 * 1000),
          });
          mappedPhones.add(phone.user);
        }
        while (this.lidPhoneCache.size > 1000) {
          this.lidPhoneCache.delete(this.lidPhoneCache.keys().next().value);
        }
        while (this.phoneLidCache.size > 1000) {
          this.phoneLidCache.delete(this.phoneLidCache.keys().next().value);
        }
      } catch (error) {
        logger.debug({ err: error.message }, 'WhatsApp LID mapping unavailable');
      }
    }

    if (mappedPhones.size === 1) return [...mappedPhones][0];
    if (mappedPhones.size > 1) return null;
    return extractPhoneFromDisplayName(fallbackName);
  }

  async syncUnreadMessages(options = {}) {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performMessageSync(options).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  async performMessageSync({ deep = true, reason = 'manual' } = {}) {
    if (this.state !== STATES.READY || !this.client || !this.client.pupPage) {
      return { synced_count: 0, reason: 'whatsapp_not_ready' };
    }

    const activeClient = this.client;
    const configuredLimit = env.whatsappRecovery.messageLimit;
    const messageLimit = deep ? configuredLimit : Math.min(20, configuredLimit);
    const lookbackMs = env.whatsappRecovery.lookbackHours * 60 * 60 * 1000;

    try {
      logger.info({ deep, reason, messageLimit }, 'Starting WhatsApp recovery sync');
      const monitoringService = require('../monitoring-cia/monitoring-cia.service');

      const rawMessages = await activeClient.pupPage.evaluate(async (syncOptions) => {
        if (!window.Store) return [];
        const chatColl = window.Store.Chat;
        if (!chatColl) return [];

        let chats = [];
        if (typeof chatColl.getModelsArray === 'function') {
          chats = chatColl.getModelsArray();
        } else if (Array.isArray(chatColl.models)) {
          chats = chatColl.models;
        } else if (Array.isArray(chatColl._models)) {
          chats = chatColl._models;
        }

        const results = [];

        for (const c of chats) {
          if (!c || !c.id) continue;
          const serialized = c.id._serialized || (typeof c.id === 'string' ? c.id : '');
          if (c.isGroup || (serialized && serialized.endsWith('@g.us'))) continue;

          const contactName = c.formattedTitle || c.name || c.contact?.name || c.contact?.pushname || null;

          const readMessages = () => {
            if (!c.msgs) return [];
            if (typeof c.msgs.getModelsArray === 'function') return c.msgs.getModelsArray();
            if (Array.isArray(c.msgs.models)) return c.msgs.models;
            if (Array.isArray(c.msgs._models)) return c.msgs._models;
            return [];
          };

          const isIncoming = (message) => message?.id && !Boolean(message.id.fromMe || message.fromMe);
          let msgs = readMessages().filter(isIncoming);
          const chatTimestampMs = Number(c.t || c.timestamp || c.lastMessage?.t || 0) * 1000;
          const recentlyActive = chatTimestampMs > 0 && Date.now() - chatTimestampMs <= syncOptions.lookbackMs;
          const shouldLoadEarlier = syncOptions.deep && (Number(c.unreadCount || 0) > 0 || recentlyActive);
          let loadAttempts = 0;

          while (shouldLoadEarlier && msgs.length < syncOptions.messageLimit && loadAttempts < 20) {
            const loader = window.Store.ConversationMsgs?.loadEarlierMsgs;
            if (typeof loader !== 'function') break;
            const loaded = await loader(c, c.msgs).catch(() => []);
            if (!loaded || !loaded.length) break;
            msgs = [...loaded.filter(isIncoming), ...msgs];
            loadAttempts += 1;
          }

          for (const m of msgs.slice(-syncOptions.messageLimit)) {
            if (!m || !m.id) continue;
            const isFromMe = Boolean(m.id.fromMe || m.fromMe);
            if (isFromMe) continue;

            results.push({
              waMessageId: m.id.id || null,
              quotedWaMessageId: m.quotedStanzaID || m.quotedMsg?.id?.id || null,
              fromId: serialized || null,
              fromName: m.notifyName || m.pushname || contactName,
              body: m.body || m.caption || '',
              hasMedia: Boolean(m.isMedia || m.hasMedia),
              mediaType: m.type || null,
              timestampMs: m.t ? m.t * 1000 : Date.now(),
            });
          }
        }

        return results;
      }, { deep, messageLimit, lookbackMs }).catch((evalErr) => {
        logger.warn({ err: evalErr.message }, 'Puppeteer page evaluate for Chat.msgs failed');
        return [];
      });

      if (this.client !== activeClient || this.state !== STATES.READY) {
        return { synced_count: 0, reason: 'whatsapp_connection_changed' };
      }

      let newSyncedCount = 0;

      const messages = prepareSyncedMessages(rawMessages);
      for (const msg of messages) {
        if (this.client !== activeClient || this.state !== STATES.READY) break;
        if (!msg || msg.fromMe) continue;
        const phoneToUse = await this.resolveIncomingPhone({
          identifiers: [msg.fromId],
          fallbackName: msg.fromName,
        }, activeClient);
        if (!phoneToUse) continue;

        const result = await monitoringService.handleIncomingWAMessage({
          fromPhone: phoneToUse,
          fromName: msg.fromName,
          body: msg.body,
          hasMedia: msg.hasMedia,
          mediaType: msg.mediaType,
          waMessageId: msg.waMessageId,
          quotedWaMessageId: msg.quotedWaMessageId,
          receivedAt: new Date(msg.timestampMs),
        }).catch((err) => logger.debug({ err }, 'Duplicate or sync error skipped'));

        if (result && result.is_new) {
          newSyncedCount++;
        }
      }

      logger.info({ newSyncedCount, totalInspected: messages.length, deep, reason }, 'WhatsApp recovery sync completed');
      return { synced_count: newSyncedCount, inspected_count: messages.length, deep };
    } catch (error) {
      logger.error({ err: error }, 'Failed to sync WhatsApp messages');
      throw error;
    }
  }

  startAutoSync() {
    if (this.autoSyncInterval) return;
    this.autoSyncInterval = setInterval(() => {
      if (this.state !== STATES.READY) return;
      this.syncUnreadMessages({ deep: false, reason: 'periodic' })
        .catch((error) => logger.debug({ err: error.message }, 'Periodic WhatsApp recovery sync skipped'));
    }, env.whatsappRecovery.syncIntervalMs);
    this.autoSyncInterval.unref?.();
  }

  stopAutoSync() {
    if (!this.autoSyncInterval) return;
    clearInterval(this.autoSyncInterval);
    this.autoSyncInterval = null;
  }

  createClient() {
    const puppeteerArgs = ['--disable-extensions'];
    if (env.puppeteerNoSandbox) {
      puppeteerArgs.push('--no-sandbox', '--disable-setuid-sandbox');
    }

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: 'default',
        dataPath: path.resolve(__dirname, '../../../storage/whatsapp-auth'),
      }),
      puppeteer: {
        headless: env.puppeteerHeadless,
        args: puppeteerArgs,
      },
      webVersionCache: {
        type: 'none',
      },
    });

    client.on('qr', (qr) => {
      if (this.client !== client) return;
      this.state = STATES.AWAITING_QR;
      this.qrCode = qr;
      this.persistState('awaiting_qr');
      logger.info('WhatsApp QR code generated');
      this.emit('qr', { qr, ...this.getStatus() });
    });

    client.on('ready', async () => {
      if (this.client !== client) return;
      this.state = STATES.READY;
      this.qrCode = null;
      this.phoneNumber = client.info?.wid?.user || null;
      this.persistState('ready', { phoneNumber: this.phoneNumber });
      logger.info({ phoneNumber: this.phoneNumber }, 'WhatsApp client ready');
      this.emit('ready', this.getStatus());

      this.startAutoSync();
      this.syncUnreadMessages({ deep: true, reason: 'ready' })
        .catch((err) => logger.warn({ err }, 'Auto-sync on ready skipped'));
    });

    client.on('unread_count', () => {
      if (this.client !== client || this.state !== STATES.READY) return;
      this.syncUnreadMessages({ deep: false, reason: 'unread_count' })
        .catch((err) => logger.debug({ err: err.message }, 'Unread count sync skipped'));
    });

    client.on('auth_failure', (message) => {
      if (this.client !== client) return;
      this.state = STATES.ERROR;
      this.stopAutoSync();
      logger.error({ message }, 'WhatsApp authentication failed');
      this.persistState('error', { errorCode: 'AUTH_FAILURE' });
      this.emit('connection_error', this.getStatus());
    });

    client.on('disconnected', (reason) => {
      if (this.client !== client) return;
      this.state = STATES.DISCONNECTED;
      this.stopAutoSync();
      logger.warn({ reason }, 'WhatsApp disconnected');
      this.persistState('disconnected');
      this.emit('disconnected', { reason, ...this.getStatus() });
    });

    const processIncomingMessage = async (msg) => {
      if (this.client !== client) return;
      if (msg.fromMe) return;
      if (msg.from && msg.from.endsWith('@g.us')) return;

      try {
        logger.info({ msgId: msg.id?.id || null }, 'Incoming WhatsApp message detected');
        const monitoringService = require('../monitoring-cia/monitoring-cia.service');

        const msgContact = await msg.getContact().catch(() => null);
        const chat = await msg.getChat().catch(() => null);
        const chatContact = chat ? await chat.getContact().catch(() => null) : null;

        const fromName = msg._data?.notifyName || msg._data?.pushname || msg._data?.shortName || (msgContact ? (msgContact.name || msgContact.pushname) : null) || (chat ? chat.name : null);
        const fromPhone = await this.resolveIncomingPhone({
          identifiers: [
            msgContact?.id,
            chatContact?.id,
            chat?.id,
            msg.from,
            msg.id?.remote,
          ],
          fallbackName: fromName,
        }, client);

        const hasMedia = Boolean(msg.hasMedia);
        const mediaType = msg.type || null;
        let quotedWaMessageId = null;
        if (msg.hasQuotedMsg) {
          const quotedMessage = await msg.getQuotedMessage().catch(() => null);
          quotedWaMessageId = quotedMessage?.id?.id || quotedMessage?.id?._serialized || null;
        }

        if (!fromPhone) return;

        await monitoringService.handleIncomingWAMessage({
          fromPhone,
          fromName,
          body: msg.body || '',
          hasMedia,
          mediaType,
          waMessageId: msg.id?.id || null,
          quotedWaMessageId,
        });
      } catch (err) {
        logger.error({ err }, 'Error processing incoming WhatsApp message');
      }
    };

    client.on('message', processIncomingMessage);
    return client;
  }

  async cleanupClient() {
    this.stopAutoSync();
    this.lidPhoneCache.clear();
    this.phoneLidCache.clear();
    const client = this.client;
    this.client = null;
    if (client) {
      client.removeAllListeners();
      await client.destroy().catch((error) => logger.debug({ err: error }, 'WhatsApp client cleanup skipped'));
    }
  }

  persistState(status, details = {}) {
    Promise.all([
      repository.updateAccountStatus(status, details),
      repository.addConnectionEvent(status, details),
    ]).catch((error) => logger.warn({ err: error, status }, 'WhatsApp state persistence failed'));
  }
}

module.exports = {
  manager: new WhatsAppClientManager(),
  WhatsAppClientManager,
  STATES,
  extractQrToken,
  prepareSyncedMessages,
  extractExternalMessageId,
  waitForServerAck,
  createSendObservation,
  parseWhatsAppIdentifier,
  extractPhoneFromDisplayName,
};
