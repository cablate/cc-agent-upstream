const net = require('node:net');

function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  const mapped = candidate.match(/^::ffff:(\d{1,3}(?:[.]\d{1,3}){3})$/i);
  if (mapped && net.isIP(mapped[1]) === 4) return mapped[1];
  return net.isIP(candidate) ? candidate : null;
}

function isLoopback(value) {
  const ip = normalizeIp(value);
  if (!ip) return false;
  if (net.isIP(ip) === 4) return ip.startsWith('127.');
  return ip === '::1';
}

function singleCloudflareIp(headers = {}) {
  const value = headers['cf-connecting-ip'];
  if (Array.isArray(value)) {
    if (value.length !== 1) return null;
    return normalizeIp(value[0]);
  }
  if (typeof value !== 'string' || value.includes(',')) return null;
  return normalizeIp(value);
}

function resolveClientIp(req = {}) {
  // Express trust-proxy remains disabled. Production is loopback-only, so a
  // Cloudflare identity header is accepted only from a direct local peer.
  // Every non-loopback peer is always keyed by its
  // socket address; X-Forwarded-For is deliberately ignored.
  const remote = normalizeIp(
    req.socket?.remoteAddress || req.connection?.remoteAddress,
  ) || 'unknown';
  if (!isLoopback(remote)) return remote;
  return singleCloudflareIp(req.headers) || remote;
}

module.exports = {
  isLoopback,
  normalizeIp,
  resolveClientIp,
  singleCloudflareIp,
};
