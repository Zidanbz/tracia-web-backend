const DELIVERY_SAFETY_CODES = Object.freeze({
  RESULT_MISSING: 'WHATSAPP_SEND_RESULT_MISSING',
  RESULT_AMBIGUOUS: 'WHATSAPP_SEND_RESULT_AMBIGUOUS',
  ACK_ERROR: 'WHATSAPP_ACK_ERROR',
  ACK_TIMEOUT: 'WHATSAPP_ACK_TIMEOUT',
  CONNECTION_CHANGED: 'WHATSAPP_CONNECTION_CHANGED_DURING_SEND',
});

const DELIVERY_SAFETY_CODE_SET = new Set(Object.values(DELIVERY_SAFETY_CODES));

function createDeliverySafetyError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.deliveryUnconfirmed = true;
  return error;
}

function isDeliverySafetyError(errorOrCode) {
  if (errorOrCode?.deliveryUnconfirmed === true) return true;
  const code = typeof errorOrCode === 'string' ? errorOrCode : errorOrCode?.code;
  return DELIVERY_SAFETY_CODE_SET.has(code);
}

module.exports = {
  DELIVERY_SAFETY_CODES,
  createDeliverySafetyError,
  isDeliverySafetyError,
};
