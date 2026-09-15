const createError = require('http-errors');
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const pinoHttp = require('pino-http');
const engine = require('ejs-layout');
const { ZodError } = require('zod');

const env = require('./src/config/env');
const logger = require('./src/config/logger');
const sessionMiddleware = require('./src/middleware/session');
const { csrfProtection, exposeCsrfToken } = require('./src/middleware/csrf');
const { exposeCurrentUser, refreshSessionAuthorization, requireAuth, requirePermission } = require('./src/middleware/auth');
const { authenticateApiKey } = require('./src/middleware/api-key');
const authRouter = require('./src/modules/auth/auth.routes');
const whatsappRouter = require('./src/modules/whatsapp/whatsapp.routes');
const dashboardRouter = require('./src/modules/dashboard/dashboard.routes');
const contactsRouter = require('./src/modules/contacts/contacts.routes');
const contactGroupsRouter = require('./src/modules/contact-groups/contact-groups.routes');
const contactImportsRouter = require('./src/modules/contact-imports/contact-imports.routes');
const templatesRouter = require('./src/modules/templates/templates.routes');
const messagesRouter = require('./src/modules/messages/messages.routes');
const queueRouter = require('./src/modules/queue/queue.routes');
const broadcastsRouter = require('./src/modules/broadcasts/broadcasts.routes');
const apiUsersRouter = require('./src/modules/users/users.routes');
const reportsRouter = require('./src/modules/reports/reports.routes');
const integrationsRouter = require('./src/modules/integrations/integrations.routes');
const settingsRouter = require('./src/modules/settings/settings.routes');
const monitoringCiaRouter = require('./src/modules/monitoring-cia/monitoring-cia.router');
const qaSessionRouter = require('./src/modules/qa-session/qa-session.router');
const campaignsRouter = require('./src/modules/campaigns/campaigns.routes');
const campaignMonitoringRouter = require('./src/modules/campaign-monitoring/campaign-monitoring.routes');
const campusDashboardRouter = require('./src/modules/campus-dashboard/campus-dashboard.routes');
const messageTimingRouter = require('./src/modules/message-timing/message-timing.routes');
const metaWebhookRouter = require('./src/modules/meta-webhook/meta-webhook.routes');
const pagesRouter = require('./src/modules/pages/pages.routes');
const knex = require('./src/database/knex');
const indexRouter = require('./routes/index');
const usersRouter = require('./routes/users');

const fs = require('fs');
const app = express();

function findFrontendRoot() {
  const candidates = [
    process.env.FRONTEND_ROOT,
    path.resolve(__dirname, '../wa-service-fe'),
    path.resolve(__dirname, '../tracia-web-frontend'),
    '/wa-service-fe',
    '/tracia-web-frontend',
    path.resolve(__dirname, 'views'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'views'))) {
      return candidate;
    }
    if (fs.existsSync(path.join(candidate, 'login.ejs'))) {
      return path.dirname(candidate);
    }
  }
  return path.resolve(__dirname, '../wa-service-fe');
}

const frontendRoot = findFrontendRoot();
const viewsDirectory = fs.existsSync(path.join(frontendRoot, 'views'))
  ? path.join(frontendRoot, 'views')
  : (fs.existsSync(path.join(frontendRoot, 'login.ejs')) ? frontendRoot : path.join(frontendRoot, 'views'));

app.disable('x-powered-by');
app.disable('view cache');
app.set('view cache', false);
if (env.trustProxy) app.set('trust proxy', 1);
app.set('views', viewsDirectory);
app.set('view engine', 'ejs');
app.engine('ejs', (filePath, options, callback) => {
  if (typeof engine.clearCache === 'function') {
    engine.clearCache();
  }
  options.cache = false;
  if (options.settings) options.settings['view cache'] = false;
  return engine.__express(filePath, options, callback);
});

app.use(pinoHttp({ logger }));
app.use(helmet({
  // Beberapa view operasional masih memakai inline script. CSP bernonce masuk tahap hardening frontend.
  contentSecurityPolicy: false,
  // HSTS hanya relevan ketika aplikasi benar-benar dilayani melalui HTTPS.
  strictTransportSecurity: env.isProduction ? undefined : false,
}));
app.use(express.static(path.join(frontendRoot, 'public')));
app.use(express.json({ limit: env.bodyLimit }));
app.use(express.urlencoded({ limit: env.bodyLimit, extended: false }));

// Health check tidak membuat session/CSRF token dan tetap dapat digunakan oleh
// orchestrator walaupun session store sedang bermasalah.
app.get('/health/live', (req, res) => res.json({ success: true, data: { status: 'up' } }));
app.get('/health/ready', async (req, res) => {
  try {
    await knex.raw('SELECT 1');
    return res.json({ success: true, data: { status: 'ready' } });
  } catch (error) {
    req.log.error({ err: error }, 'Database readiness check failed');
    return res.status(503).json({
      success: false,
      error: { code: 'NOT_READY', message: 'Database belum siap' },
    });
  }
});

// Webhook publik Meta WhatsApp Cloud API (bebas CSRF & Session, diautentikasi lewat verify token / HMAC)
app.use('/api/v1/meta-webhook', metaWebhookRouter);

app.use(sessionMiddleware);
app.use('/api/v1', authenticateApiKey);
app.use(refreshSessionAuthorization);
app.use(exposeCurrentUser);
app.use(exposeCsrfToken);
app.use(csrfProtection);

app.use(authRouter);
app.use('/api/v1/whatsapp', requireAuth, whatsappRouter);
app.use('/api/v1/dashboard', requireAuth, dashboardRouter);
app.use('/api/v1/contacts', requireAuth, contactsRouter);
app.use('/api/v1/contact-groups', requireAuth, contactGroupsRouter);
app.use('/api/v1/contact-imports', requireAuth, contactImportsRouter);
app.use('/api/v1/templates', requireAuth, templatesRouter);
app.use('/api/v1/messages', requireAuth, messagesRouter);
app.use('/api/v1/queue', requireAuth, queueRouter);
app.use('/api/v1/broadcasts', requireAuth, broadcastsRouter);
app.use('/api/v1/users', requireAuth, apiUsersRouter);
app.use('/api/v1/reports', requireAuth, reportsRouter);
app.use('/api/v1/integrations', requireAuth, integrationsRouter);
app.use('/api/v1/settings', requireAuth, settingsRouter);
app.use('/api/v1/monitoring-cia', requireAuth, monitoringCiaRouter);
app.use('/api/v1/qa-sessions', requireAuth, qaSessionRouter);
app.use('/api/v1/campaigns', requireAuth, campaignsRouter);
app.use('/api/v1/campaign-monitoring', requireAuth, campaignMonitoringRouter);
app.use('/api/v1/campus-dashboard', requireAuth, campusDashboardRouter);
app.use('/api/v1/message-timing', requireAuth, messageTimingRouter);
app.use('/', requireAuth, pagesRouter);
app.use('/', requireAuth, indexRouter);
app.use('/users', requireAuth, requirePermission('users.view'), usersRouter);

app.use((req, res, next) => next(createError(404)));

app.use((err, req, res, next) => {
  const isApi = req.originalUrl.startsWith('/api/') || req.xhr;
  let status = err.status || err.statusCode || 500;
  let code = err.code || 'INTERNAL_SERVER_ERROR';
  let message = status >= 500 ? 'Terjadi kesalahan pada server' : err.message;

  if (err instanceof ZodError) {
    status = 422;
    code = 'VALIDATION_ERROR';
    message = 'Input tidak valid';
  }
  if (status >= 500) req.log.error({ err }, 'Unhandled request error');
  else req.log.warn({ err, status }, 'Request rejected');

  if (isApi) {
    return res.status(status).json({
      success: false,
      error: {
        code,
        message,
        ...(err instanceof ZodError ? { details: err.issues } : {}),
      },
    });
  }

  res.locals.message = message;
  res.locals.error = env.nodeEnv === 'development' ? err : {};
  return res.status(status).render('error', (renderErr, html) => {
    if (renderErr) {
      req.log.error({ err: renderErr }, 'Failed to render error view');
      return res.status(status).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Error ${status}</title></head>
        <body style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h2>${status} - ${message}</h2>
          ${env.nodeEnv === 'development' ? `<pre style="text-align: left; background: #f4f4f4; padding: 15px; border-radius: 5px;">${err.stack || err}</pre>` : ''}
        </body>
        </html>
      `);
    }
    return res.send(html);
  });
});

if (env.session.usesEphemeralSecret) {
  logger.warn('SESSION_SECRET tidak tersedia; secret acak runtime dipakai dan session gugur saat restart');
}

module.exports = app;
