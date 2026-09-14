const env = require('../config/env');

function normalizePhone(input, countryCode = env.defaultCountryCode) {
  if (input === null || input === undefined) throw validationError();
  let digits = String(input).trim().replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  digits = digits.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `${countryCode}${digits.slice(1)}`;
  else if (digits.startsWith('8') && countryCode === '62') digits = `${countryCode}${digits}`;
  if (!/^\d{8,15}$/.test(digits)) throw validationError();
  return digits;
}

function validationError() {
  const error = new Error('Nomor telepon tidak valid');
  error.code = 'INVALID_PHONE_NUMBER';
  error.status = 422;
  return error;
}

module.exports = { normalizePhone };
