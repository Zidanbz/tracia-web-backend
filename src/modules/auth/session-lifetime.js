function applySessionLifetime(session, {
  rememberMe,
  standardTtlSeconds,
  rememberedTtlSeconds,
}) {
  if (!session?.cookie) throw new TypeError('Session cookie tidak tersedia');

  const ttlSeconds = rememberMe ? rememberedTtlSeconds : standardTtlSeconds;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError('Session TTL harus berupa bilangan bulat positif');
  }

  session.cookie.maxAge = ttlSeconds * 1000;
  session.rememberMe = Boolean(rememberMe);
  return ttlSeconds;
}

module.exports = { applySessionLifetime };
