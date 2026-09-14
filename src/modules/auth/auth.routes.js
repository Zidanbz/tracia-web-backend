const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const asyncHandler = require('../../shared/async-handler');
const authService = require('./auth.service');
const { writeAuditLog } = require('../audit/audit.repository');
const { requireAuth } = require('../../middleware/auth');
const { revokeCsrfToken } = require('../../middleware/csrf');
const env = require('../../config/env');
const { applySessionLifetime } = require('./session-lifetime');
const { passwordSchema } = require('./password-policy');

const router = express.Router();
const loginSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(1).max(128),
  remember_me: z.enum(['on', 'true', '1']).optional().transform(Boolean),
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    if (req.accepts('html')) return res.redirect('/login?error=too_many_attempts');
    return res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Terlalu banyak percobaan login' },
    });
  },
});

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

router.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/dashboard');
  const messages = {
    invalid: 'Email atau password tidak valid.',
    too_many_attempts: 'Terlalu banyak percobaan. Silakan tunggu sebelum mencoba lagi.',
    session_expired: 'Sesi Anda telah berakhir. Silakan login kembali.',
  };
  return res.render('login', { errorMessage: messages[req.query.error] || null });
});

router.post(['/login', '/auth/login'], loginLimiter, asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.redirect('/login?error=invalid');

  const result = await authService.authenticate({
    ...parsed.data,
    ipAddress: req.ip,
  });
  if (!result) return res.redirect('/login?error=invalid');

  await regenerateSession(req);
  req.session.user = result.user;
  req.session.authVersion = result.authVersion;
  req.session.roles = result.roles;
  req.session.permissions = result.permissions;
  applySessionLifetime(req.session, {
    rememberMe: parsed.data.remember_me,
    standardTtlSeconds: env.session.ttlSeconds,
    rememberedTtlSeconds: env.session.rememberTtlSeconds,
  });
  await saveSession(req);

  await writeAuditLog({
    actorUserId: result.user.id,
    action: 'auth.login',
    entityType: 'user',
    entityId: String(result.user.id),
    requestId: req.id,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });

  return res.redirect('/dashboard');
}));

router.post('/auth/logout', requireAuth, asyncHandler(async (req, res) => {
  const actor = req.session.user;
  await writeAuditLog({
    actorUserId: actor.id,
    action: 'auth.logout',
    entityType: 'user',
    entityId: String(actor.id),
    requestId: req.id,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });
  revokeCsrfToken(req);
  await destroySession(req);
  res.clearCookie('wa.sid');
  return res.redirect('/login');
}));

const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(128),
  new_password: passwordSchema,
});
router.post('/auth/change-password', requireAuth, asyncHandler(async (req, res) => {
  const bcrypt = require('bcrypt');
  const knex = require('../../database/knex');
  const value = changePasswordSchema.parse(req.body);
  const user = await knex('users').where({ id: req.session.user.id }).first();
  if (!user || !(await bcrypt.compare(value.current_password, user.password_hash))) {
    const error = new Error('Password saat ini tidak valid'); error.status = 422; throw error;
  }
  const passwordHash = await bcrypt.hash(value.new_password, 12);
  await knex('users').where({ id: user.id }).update({
    password_hash: passwordHash,
    auth_version: knex.raw('auth_version + 1'),
    updated_at: knex.fn.now(3),
  });
  await writeAuditLog({
    actorUserId: user.id, action: 'auth.password_changed', entityType: 'user', entityId: String(user.id),
    requestId: req.id, ipAddress: req.ip, userAgent: req.get('user-agent'),
  });
  await destroySession(req);
  res.clearCookie('wa.sid');
  return res.redirect('/login?error=session_expired');
}));

module.exports = router;
