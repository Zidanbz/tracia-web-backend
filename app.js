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
const pagesRouter = require('./src/modules/pages/pages.routes');
const knex = require('./src/database/knex');
const indexRouter = require('./routes/index');
const usersRouter = require('./routes/users');

const app = express();
const frontendRoot = path.resolve(__dirname, '../wa-service-fe');

app.disable('x-powered-by');
if (env.trustProxy) app.set('trust proxy', 1);
app.set('views', path.join(frontendRoot, 'views'));
app.set('view engine', 'ejs');
app.engine('ejs', engine.__express);

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
  return res.status(status).render('error');
});

if (env.session.usesEphemeralSecret) {
  logger.warn('SESSION_SECRET tidak tersedia; secret acak runtime dipakai dan session gugur saat restart');
}

module.exports = app;
