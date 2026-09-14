const test = require('node:test');
const assert = require('node:assert/strict');
const { applySessionLifetime } = require('../src/modules/auth/session-lifetime');

test('login biasa memakai TTL session standar', () => {
  const session = { cookie: {} };
  const ttl = applySessionLifetime(session, {
    rememberMe: false,
    standardTtlSeconds: 28800,
    rememberedTtlSeconds: 2592000,
  });

  assert.equal(ttl, 28800);
  assert.equal(session.cookie.maxAge, 28800000);
  assert.equal(session.rememberMe, false);
});

test('ingat saya memakai TTL session panjang tanpa menyimpan kredensial', () => {
  const session = { cookie: {} };
  const ttl = applySessionLifetime(session, {
    rememberMe: true,
    standardTtlSeconds: 28800,
    rememberedTtlSeconds: 2592000,
  });

  assert.equal(ttl, 2592000);
  assert.equal(session.cookie.maxAge, 2592000000);
  assert.equal(session.rememberMe, true);
  assert.equal(session.password, undefined);
  assert.equal(session.email, undefined);
});
