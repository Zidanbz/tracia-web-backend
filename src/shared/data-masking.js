function shouldMaskPersonalData(req) {
  if (req.apiKey) return false;
  const roles = req.session?.roles || [];
  return roles.includes('viewer') && !roles.some((role) => ['operator', 'super_admin'].includes(role));
}

function maskPhone(phone) {
  const value = String(phone || '');
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}

function maskEmail(email) {
  const value = String(email || '').trim();
  const separator = value.lastIndexOf('@');
  if (separator <= 0) return value ? '[MASKED]' : '';
  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  const visible = local.length > 2 ? `${local[0]}${'*'.repeat(Math.min(6, local.length - 2))}${local.at(-1)}` : `${local[0]}*`;
  return `${visible}@${domain}`;
}

function maskMessage(message) {
  return {
    ...message,
    recipient_phone_e164: maskPhone(message.recipient_phone_e164),
    body: message.body === undefined ? undefined : '[MASKED]',
  };
}

module.exports = { shouldMaskPersonalData, maskEmail, maskPhone, maskMessage };
