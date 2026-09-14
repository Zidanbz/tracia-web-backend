const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  passwordSchema,
} = require('../src/modules/auth/password-policy');

test('kebijakan password menerima minimal 6 karakter', () => {
  assert.equal(PASSWORD_MIN_LENGTH, 6);
  assert.equal(PASSWORD_MAX_LENGTH, 128);
  assert.equal(passwordSchema.safeParse('abc123').success, true);
});

test('kebijakan password menolak kurang dari 6 dan lebih dari 128 karakter', () => {
  assert.equal(passwordSchema.safeParse('abc12').success, false);
  assert.equal(passwordSchema.safeParse('a'.repeat(129)).success, false);
});
