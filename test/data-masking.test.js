const test = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldMaskPersonalData, maskEmail, maskPhone, maskMessage,
} = require('../src/shared/data-masking');

test('data pribadi dimasking untuk viewer dashboard', () => {
  assert.equal(shouldMaskPersonalData({ session: { roles: ['viewer'] } }), true);
  assert.equal(shouldMaskPersonalData({ session: { roles: ['operator'] } }), false);
  assert.equal(shouldMaskPersonalData({ apiKey: { id: 1 }, session: {} }), false);
  assert.equal(maskPhone('628123456789'), '********6789');
  assert.equal(maskEmail('alumni@example.com'), 'a****i@example.com');
  assert.deepEqual(maskMessage({ recipient_phone_e164: '628123456789', body: 'rahasia' }), {
    recipient_phone_e164: '********6789',
    body: '[MASKED]',
  });
});
