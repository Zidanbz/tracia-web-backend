const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_STORE = 'memory';

const app = require('../app');

async function withServer(run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('route utama mengarahkan user anonim ke login', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
  });
});

test('form login memiliki CSRF dan menolak POST tanpa token', async () => {
  await withServer(async (baseUrl) => {
    const loginPage = await fetch(`${baseUrl}/login`);
    assert.equal(loginPage.status, 200);
    const html = await loginPage.text();
    const cookie = loginPage.headers.get('set-cookie');
    const token = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert.ok(cookie);
    assert.ok(token);

    const rejected = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'email=invalid&password=',
    });
    assert.equal(rejected.status, 403);

    const acceptedByCsrf = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ email: 'invalid', password: '', _csrf: token }),
    });
    assert.equal(acceptedByCsrf.status, 302);
    assert.equal(acceptedByCsrf.headers.get('location'), '/login?error=invalid');
  });
});
