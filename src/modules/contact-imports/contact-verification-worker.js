const os = require('os');
const knex = require('../../database/knex');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { manager } = require('../whatsapp/whatsapp-client-manager');
const { refreshImportVerificationStatus } = require('./contact-verification');

class ContactVerificationWorker {
  constructor() {
    this.workerId = `${os.hostname()}:${process.pid}:contact-verification`;
    this.running = false;
    this.timer = null;
    this.ticking = false;
    this.lastTickAt = null;
    this.lastClaimAt = null;
    this.lastErrorCode = null;
    this.lastRecoveryAt = 0;
  }

  start() {
    if (this.running) {
      this.wake();
      return;
    }
    this.running = true;
    this.wake();
    logger.info({ workerId: this.workerId }, 'Contact verification worker started');
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  getStatus() {
    return {
      configured: env.contactVerificationWorker.enabled,
      running: this.running,
      scheduled: Boolean(this.timer),
      ticking: this.ticking,
      last_tick_at: this.lastTickAt,
      last_claim_at: this.lastClaimAt,
      last_error_code: this.lastErrorCode,
      poll_ms: env.contactVerificationWorker.pollMs,
      whatsapp_ready: manager.getStatus().ready,
    };
  }

  wake() {
    if (!this.running) return false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.ticking) this.schedule(0);
    return true;
  }

  schedule(delay = env.contactVerificationWorker.pollMs) {
    if (!this.running || this.timer || this.ticking) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
    this.timer.unref();
  }

  async tick() {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    this.lastTickAt = new Date();
    try {
      // Tidak menyentuh database ketika WhatsApp belum siap. Import tetap
      // persistent dan akan dilanjutkan setelah akun terhubung kembali.
      if (!manager.getStatus().ready) return;
      if (Date.now() - this.lastRecoveryAt >= 60000) {
        await this.recoverStaleChecks();
        this.lastRecoveryAt = Date.now();
      }
      const row = await this.claim();
      if (row) {
        this.lastClaimAt = new Date();
        this.lastErrorCode = null;
        await this.verify(row);
      }
    } catch (error) {
      this.lastErrorCode = String(error.code || 'CONTACT_VERIFICATION_TICK_FAILED').slice(0, 100);
      logger.error({ err: error, workerId: this.workerId }, 'Contact verification worker tick failed');
    } finally {
      this.ticking = false;
      this.schedule();
    }
  }

  async recoverStaleChecks() {
    const cutoff = new Date(Date.now() - env.contactVerificationWorker.lockTimeoutMs);
    const staleRows = await knex('contact_import_rows')
      .where({ wa_registration_status: 'checking' })
      .where('wa_locked_at', '<', cutoff)
      .select('id', 'contact_import_id', 'wa_check_attempts')
      .limit(100);
    const affectedImports = new Set();
    for (const row of staleRows) {
      const exhausted = row.wa_check_attempts >= env.contactVerificationWorker.maxAttempts;
      await knex('contact_import_rows').where({ id: row.id, wa_registration_status: 'checking' }).update({
        wa_registration_status: exhausted ? 'check_failed' : 'pending',
        wa_check_available_at: exhausted ? null : knex.fn.now(3),
        wa_error_code: exhausted ? 'STALE_CHECK_EXHAUSTED' : 'STALE_CHECK_RECOVERED',
        wa_locked_at: null,
        wa_locked_by: null,
      });
      affectedImports.add(row.contact_import_id);
    }
    for (const importId of affectedImports) await refreshImportVerificationStatus(importId);
    if (staleRows.length) logger.warn({ count: staleRows.length }, 'Stale contact verification checks recovered');
  }

  async claim() {
    if (!manager.getStatus().ready) return null;
    return knex.transaction(async (trx) => {
      const row = await trx('contact_import_rows')
        .join('contact_imports', 'contact_imports.id', 'contact_import_rows.contact_import_id')
        .where('contact_import_rows.status', 'valid')
        .where('contact_import_rows.wa_registration_status', 'pending')
        .where('contact_import_rows.wa_check_available_at', '<=', trx.fn.now(3))
        .where('contact_imports.status', 'previewed')
        .where((builder) => builder
          .whereNull('contact_imports.campaign_id')
          .orWhereRaw(`contact_imports.id = (
            SELECT MAX(latest_import.id)
            FROM contact_imports AS latest_import
            WHERE latest_import.campaign_id = contact_imports.campaign_id
          )`))
        .select('contact_import_rows.*')
        .orderBy('contact_imports.updated_at')
        .orderBy('contact_import_rows.id')
        .forUpdate()
        .first();
      if (!row) return null;
      const attempts = Number(row.wa_check_attempts) + 1;
      await trx('contact_import_rows').where({ id: row.id, wa_registration_status: 'pending' }).update({
        wa_registration_status: 'checking',
        wa_check_attempts: attempts,
        wa_locked_at: trx.fn.now(3),
        wa_locked_by: this.workerId,
        wa_error_code: null,
      });
      await trx('contact_imports').where({ id: row.contact_import_id }).update({
        verification_status: 'running',
        updated_at: trx.fn.now(3),
      });
      return { ...row, wa_check_attempts: attempts };
    });
  }

  async verify(row) {
    try {
      const registered = await manager.checkNumberRegistered(row.normalized_phone);
      await knex('contact_import_rows').where({
        id: row.id,
        wa_registration_status: 'checking',
        wa_locked_by: this.workerId,
      }).update({
        wa_registration_status: registered ? 'registered' : 'not_registered',
        wa_checked_at: knex.fn.now(3),
        wa_check_available_at: null,
        wa_error_code: null,
        wa_locked_at: null,
        wa_locked_by: null,
      });
    } catch (error) {
      const retry = row.wa_check_attempts < env.contactVerificationWorker.maxAttempts;
      const retryDelayMs = Math.min(60000, 2000 * (2 ** Math.max(0, row.wa_check_attempts - 1)));
      await knex('contact_import_rows').where({
        id: row.id,
        wa_registration_status: 'checking',
        wa_locked_by: this.workerId,
      }).update({
        wa_registration_status: retry ? 'pending' : 'check_failed',
        wa_check_available_at: retry ? new Date(Date.now() + retryDelayMs) : null,
        wa_error_code: String(error.code || 'WA_CHECK_FAILED').slice(0, 100),
        wa_locked_at: null,
        wa_locked_by: null,
      });
      logger.warn({ errorCode: error.code || 'WA_CHECK_FAILED', retry }, 'Contact registration check failed');
    }
    await refreshImportVerificationStatus(row.contact_import_id);
  }
}

module.exports = new ContactVerificationWorker();
