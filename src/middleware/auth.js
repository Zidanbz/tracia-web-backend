function isApiRequest(req) {
  return req.originalUrl.startsWith('/api/') || req.xhr;
}

function exposeCurrentUser(req, res, next) {
  res.locals.currentUser = req.session?.user || null;
  res.locals.permissions = req.session?.permissions || [];
  res.locals.roles = req.session?.roles || [];
  res.locals.currentPath = req.path;
  next();
}

async function refreshSessionAuthorization(req, res, next) {
  if (!req.session?.user) return next();
  try {
    const repository = require('../modules/auth/auth.repository');
    const user = await repository.findActiveUserById(req.session.user.id);
    const sessionAuthVersion = Number(req.session.authVersion || 0);
    const currentAuthVersion = Number(user?.auth_version || 0);
    if (!user || sessionAuthVersion !== currentAuthVersion) {
      await new Promise((resolve) => req.session.destroy(() => resolve()));
      if (isApiRequest(req) || req.method !== 'GET') {
        return res.status(401).json({
          success: false,
          error: { code: 'SESSION_REVOKED', message: 'Sesi tidak lagi aktif' },
        });
      }
      return res.redirect('/login?error=session_expired');
    }
    const authorization = await repository.getAuthorization(user.id);
    req.session.user = { id: user.id, name: user.name, email: user.email };
    req.session.authVersion = currentAuthVersion;
    req.session.roles = authorization.roles;
    req.session.permissions = authorization.permissions;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireAuth(req, res, next) {
  if (req.session?.user || req.apiKey) return next();
  if (isApiRequest(req) || req.method !== 'GET') {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHENTICATED', message: 'Silakan login terlebih dahulu' },
    });
  }
  return res.redirect('/login');
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.session?.user && !req.apiKey) return requireAuth(req, res, next);
    const permissions = req.apiKey?.scopes || req.session.permissions || [];
    if (permissions.includes(permission)) return next();
    if (isApiRequest(req) || req.method !== 'GET') {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Anda tidak memiliki izin untuk aksi ini' },
      });
    }
    const error = new Error('Anda tidak memiliki izin untuk membuka halaman ini');
    error.status = 403;
    return next(error);
  };
}

function requireAnyPermission(requiredPermissions) {
  const expected = Array.isArray(requiredPermissions) ? requiredPermissions : [];
  return (req, res, next) => {
    if (!req.session?.user && !req.apiKey) return requireAuth(req, res, next);
    const permissions = req.apiKey?.scopes || req.session.permissions || [];
    if (expected.some((permission) => permissions.includes(permission))) return next();
    if (isApiRequest(req) || req.method !== 'GET') {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Anda tidak memiliki izin untuk aksi ini' },
      });
    }
    const error = new Error('Anda tidak memiliki izin untuk membuka halaman ini');
    error.status = 403;
    return next(error);
  };
}

module.exports = {
  exposeCurrentUser,
  refreshSessionAuthorization,
  requireAuth,
  requirePermission,
  requireAnyPermission,
};
