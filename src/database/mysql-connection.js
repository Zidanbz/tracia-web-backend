function setUtcSession(connection, done) {
  connection.query("SET time_zone = '+00:00'", (error) => done(error, connection));
}

function createPoolConfig(min, max) {
  return { min, max, afterCreate: setUtcSession };
}

module.exports = { setUtcSession, createPoolConfig };
