const { csrfSync } = require('csrf-sync');

const {
  csrfSynchronisedProtection,
  generateToken,
  revokeToken,
} = csrfSync({
  getTokenFromRequest: (req) =>
    req.headers['x-csrf-token'] || req.body?._csrf,
  errorConfig: {
    statusCode: 403,
    message: 'CSRF token tidak valid atau sudah kedaluwarsa',
    code: 'INVALID_CSRF_TOKEN',
  },
  skipCsrfProtection: (req) => Boolean(req.apiKey),
});

function exposeCsrfToken(req, res, next) {
  // API key tidak memakai browser cookie/CSRF. Jangan membuat session baru untuk
  // request machine-to-machine yang sudah diautentikasi dengan Bearer key.
  res.locals.csrfToken = req.apiKey ? null : generateToken(req);
  next();
}

module.exports = {
  csrfProtection: csrfSynchronisedProtection,
  exposeCsrfToken,
  revokeCsrfToken: revokeToken,
};
