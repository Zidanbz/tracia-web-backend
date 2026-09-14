const crypto = require('crypto');

function assertInterval(value, label) {
  const interval = Number(value);
  if (!Number.isSafeInteger(interval) || interval <= 0) {
    throw new TypeError(`${label} harus berupa integer positif`);
  }
  return interval;
}

function randomIntervalMs(minimumMs, maximumMs, randomInt = crypto.randomInt) {
  const minimum = assertInterval(minimumMs, 'Minimum interval');
  const maximum = assertInterval(maximumMs, 'Maximum interval');
  if (maximum < minimum) {
    throw new RangeError('Maximum interval tidak boleh lebih kecil dari minimum interval');
  }
  if (maximum === minimum) return minimum;
  return randomInt(minimum, maximum + 1);
}

function parsePacingMetadata(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function nextSendNotBefore(latestDelivery, fallbackMinimumMs) {
  if (!latestDelivery?.sent_at) return null;
  const sentAtMs = new Date(latestDelivery.sent_at).getTime();
  if (!Number.isFinite(sentAtMs)) return null;
  const fallback = assertInterval(fallbackMinimumMs, 'Fallback minimum interval');
  const fallbackNextMs = sentAtMs + fallback;

  const metadata = parsePacingMetadata(latestDelivery.pacing_metadata);
  const persistedNextMs = metadata?.next_send_not_before
    ? new Date(metadata.next_send_not_before).getTime()
    : Number.NaN;
  if (Number.isFinite(persistedNextMs) && persistedNextMs >= sentAtMs) {
    return new Date(Math.max(persistedNextMs, fallbackNextMs));
  }

  return new Date(fallbackNextMs);
}

function buildPacingMetadata(sentAt, minimumMs, maximumMs, randomInt = crypto.randomInt) {
  const sentAtMs = new Date(sentAt).getTime();
  if (!Number.isFinite(sentAtMs)) throw new TypeError('Timestamp pengiriman tidak valid');
  const delayMs = randomIntervalMs(minimumMs, maximumMs, randomInt);
  return {
    pacing_delay_ms: delayMs,
    next_send_not_before: new Date(sentAtMs + delayMs).toISOString(),
  };
}

module.exports = {
  randomIntervalMs,
  parsePacingMetadata,
  nextSendNotBefore,
  buildPacingMetadata,
};
