const crypto = require('crypto');
const bcrypt = require('bcrypt');
const repository = require('./auth.repository');

const dummyHashPromise = bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);

async function authenticate({ email, password, ipAddress }) {
  const user = await repository.findUserByEmail(email);
  const hash = user?.password_hash || (await dummyHashPromise);
  const passwordMatches = await bcrypt.compare(password, hash);

  if (!user || !passwordMatches || user.status !== 'active') {
    await repository.recordLoginAttempt({
      userId: user?.id || null,
      email,
      ipAddress,
      successful: false,
      failureReason: user && user.status !== 'active' ? 'USER_NOT_ACTIVE' : 'INVALID_CREDENTIALS',
    });
    return null;
  }

  const authorization = await repository.getAuthorization(user.id);
  await Promise.all([
    repository.updateLastLogin(user.id),
    repository.recordLoginAttempt({
      userId: user.id,
      email,
      ipAddress,
      successful: true,
    }),
  ]);

  return {
    user: { id: user.id, name: user.name, email: user.email },
    authVersion: Number(user.auth_version || 0),
    ...authorization,
  };
}

module.exports = { authenticate };
