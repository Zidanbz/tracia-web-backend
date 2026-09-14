const dns = require('dns/promises');
const net = require('net');

function isPrivateIp(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) || parts[0] === 0;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) return isPrivateIp(normalized.slice(7));
    return normalized === '::' || normalized === '::1' ||
      normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') ||
      normalized.startsWith('ff');
  }
  return true;
}

async function assertPublicHttpsUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password) throw unsafeUrl();
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) throw unsafeUrl();
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) throw unsafeUrl();
  return url.toString();
}

function unsafeUrl() {
  const error = new Error('Webhook URL harus HTTPS publik dan tidak boleh mengarah ke jaringan privat');
  error.status = 422;
  error.code = 'UNSAFE_WEBHOOK_URL';
  return error;
}

module.exports = { assertPublicHttpsUrl, isPrivateIp };
