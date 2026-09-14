const test = require('node:test');
const assert = require('node:assert/strict');

const { createPoolConfig, setUtcSession } = require('../src/database/mysql-connection');

test('koneksi database mengatur session timezone ke UTC', async () => {
  const calls = [];
  const connection = {
    query(sql, callback) {
      calls.push(sql);
      callback(null);
    },
  };
  const returnedConnection = await new Promise((resolve, reject) => {
    setUtcSession(connection, (error, value) => (error ? reject(error) : resolve(value)));
  });
  assert.equal(returnedConnection, connection);
  assert.deepEqual(calls, ["SET time_zone = '+00:00'"]);
  assert.equal(createPoolConfig(2, 10).afterCreate, setUtcSession);
});
