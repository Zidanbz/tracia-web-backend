const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');
const { z } = require('zod');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalNonEmpty = (schema) => z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  schema.optional(),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_URL: z.url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SESSION_SECRET: optionalNonEmpty(z.string().min(32)),
  SESSION_STORE: z.enum(['memory', 'mysql']).optional(),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(604800).default(28800),
  SESSION_REMEMBER_TTL_SECONDS: z.coerce.number().int().min(86400).max(7776000).default(2592000),
  APP_ENCRYPTION_KEY: optionalNonEmpty(z.string().regex(/^[a-fA-F0-9]{64}$/)),
  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  DB_NAME: z.string().min(1).default('wa_service'),
  DB_USER: z.string().min(1).default('wa_service_app'),
  DB_PASSWORD: z.string().default(''),
  DB_POOL_MIN: z.coerce.number().int().min(0).max(20).default(2),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DEFAULT_COUNTRY_CODE: z.string().regex(/^\d{1,4}$/).default('62'),
  BODY_LIMIT: z.string().regex(/^\d+(kb|mb)$/i).default('2mb'),
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024).max(52428800).default(10485760),
  TRUST_PROXY: booleanFromEnv,
  PUPPETEER_NO_SANDBOX: booleanFromEnv,
  WHATSAPP_RECOVERY_SYNC_INTERVAL_MS: z.coerce.number().int().min(5000).max(300000).default(30000),
  WHATSAPP_RECOVERY_MESSAGE_LIMIT: z.coerce.number().int().min(20).max(500).default(100),
  WHATSAPP_RECOVERY_LOOKBACK_HOURS: z.coerce.number().int().min(1).max(168).default(72),
  START_MESSAGE_WORKER: booleanFromEnv,
  MESSAGE_WORKER_POLL_MS: z.coerce.number().int().min(250).max(60000).default(2000),
  BROADCAST_RECIPIENT_INTERVAL_MS: z.coerce.number().int().min(65000).default(65000),
  BROADCAST_RECIPIENT_INTERVAL_MAX_MS: z.coerce.number().int().min(65000).max(86400000).default(120000),
  CAMPAIGN_AUTO_REPLY_DELAY_MS: z.coerce.number().int().min(65000).default(65000),
  CAMPAIGN_AUTO_REPLY_DELAY_MAX_MS: z.coerce.number().int().min(65000).max(86400000).default(120000),
  MESSAGE_WORKER_LOCK_TIMEOUT_MS: z.coerce.number().int().min(60000).max(3600000).default(300000),
  MESSAGE_SEND_TIMEOUT_MS: z.coerce.number().int().min(10000).max(300000).default(90000),
  START_CONTACT_VERIFICATION_WORKER: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  CONTACT_VERIFICATION_POLL_MS: z.coerce.number().int().min(500).max(60000).default(1500),
  CONTACT_VERIFICATION_LOCK_TIMEOUT_MS: z.coerce.number().int().min(60000).max(3600000).default(300000),
  CONTACT_VERIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  CONTACT_VERIFICATION_CACHE_TTL_SECONDS: z.coerce.number().int().min(300).max(604800).default(86400),
}).superRefine((value, context) => {
  if (value.BROADCAST_RECIPIENT_INTERVAL_MAX_MS < value.BROADCAST_RECIPIENT_INTERVAL_MS) {
    context.addIssue({
      code: 'custom',
      path: ['BROADCAST_RECIPIENT_INTERVAL_MAX_MS'],
      message: 'harus lebih besar atau sama dengan BROADCAST_RECIPIENT_INTERVAL_MS',
    });
  }
  if (value.CAMPAIGN_AUTO_REPLY_DELAY_MAX_MS < value.CAMPAIGN_AUTO_REPLY_DELAY_MS) {
    context.addIssue({
      code: 'custom',
      path: ['CAMPAIGN_AUTO_REPLY_DELAY_MAX_MS'],
      message: 'harus lebih besar atau sama dengan CAMPAIGN_AUTO_REPLY_DELAY_MS',
    });
  }
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid environment configuration: ${issues}`);
}

const values = parsed.data;
const isProduction = values.NODE_ENV === 'production';

if (values.SESSION_REMEMBER_TTL_SECONDS < values.SESSION_TTL_SECONDS) {
  throw new Error('SESSION_REMEMBER_TTL_SECONDS tidak boleh lebih kecil dari SESSION_TTL_SECONDS');
}

if (isProduction && !values.SESSION_SECRET) {
  throw new Error('SESSION_SECRET minimal 32 karakter wajib tersedia di production');
}

const sessionStore = values.SESSION_STORE || (isProduction ? 'mysql' : 'memory');

if (isProduction && sessionStore !== 'mysql') {
  throw new Error('SESSION_STORE=mysql wajib digunakan di production');
}

module.exports = Object.freeze({
  nodeEnv: values.NODE_ENV,
  isProduction,
  isTest: values.NODE_ENV === 'test',
  port: values.PORT,
  appUrl: values.APP_URL,
  logLevel: values.LOG_LEVEL,
  session: Object.freeze({
    secret: values.SESSION_SECRET || crypto.randomBytes(48).toString('base64url'),
    usesEphemeralSecret: !values.SESSION_SECRET,
    store: sessionStore,
    ttlSeconds: values.SESSION_TTL_SECONDS,
    rememberTtlSeconds: values.SESSION_REMEMBER_TTL_SECONDS,
  }),
  encryptionKey: values.APP_ENCRYPTION_KEY || null,
  database: Object.freeze({
    host: values.DB_HOST,
    port: values.DB_PORT,
    database: values.DB_NAME,
    user: values.DB_USER,
    password: values.DB_PASSWORD,
    poolMin: values.DB_POOL_MIN,
    poolMax: values.DB_POOL_MAX,
  }),
  defaultCountryCode: values.DEFAULT_COUNTRY_CODE,
  bodyLimit: values.BODY_LIMIT,
  uploadMaxBytes: values.UPLOAD_MAX_BYTES,
  trustProxy: values.TRUST_PROXY,
  puppeteerNoSandbox: values.PUPPETEER_NO_SANDBOX,
  whatsappRecovery: Object.freeze({
    syncIntervalMs: values.WHATSAPP_RECOVERY_SYNC_INTERVAL_MS,
    messageLimit: values.WHATSAPP_RECOVERY_MESSAGE_LIMIT,
    lookbackHours: values.WHATSAPP_RECOVERY_LOOKBACK_HOURS,
  }),
  messageWorker: Object.freeze({
    enabled: values.START_MESSAGE_WORKER,
    pollMs: values.MESSAGE_WORKER_POLL_MS,
    broadcastRecipientIntervalMs: values.BROADCAST_RECIPIENT_INTERVAL_MS,
    broadcastRecipientIntervalMaxMs: values.BROADCAST_RECIPIENT_INTERVAL_MAX_MS,
    campaignAutoReplyDelayMs: values.CAMPAIGN_AUTO_REPLY_DELAY_MS,
    campaignAutoReplyDelayMaxMs: values.CAMPAIGN_AUTO_REPLY_DELAY_MAX_MS,
    lockTimeoutMs: values.MESSAGE_WORKER_LOCK_TIMEOUT_MS,
    sendTimeoutMs: values.MESSAGE_SEND_TIMEOUT_MS,
  }),
  contactVerificationWorker: Object.freeze({
    enabled: values.START_CONTACT_VERIFICATION_WORKER,
    pollMs: values.CONTACT_VERIFICATION_POLL_MS,
    lockTimeoutMs: values.CONTACT_VERIFICATION_LOCK_TIMEOUT_MS,
    maxAttempts: values.CONTACT_VERIFICATION_MAX_ATTEMPTS,
    cacheTtlSeconds: values.CONTACT_VERIFICATION_CACHE_TTL_SECONDS,
  }),
});
