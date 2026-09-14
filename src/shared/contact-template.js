const VARIABLE_PATTERN = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
const SUPPORTED_CONTACT_VARIABLES = new Set(['nama', 'nomor']);

function variablesFromBody(body) {
  return [...new Set([...String(body).matchAll(VARIABLE_PATTERN)].map((match) => match[1]))];
}

function unsupportedVariables(body) {
  return variablesFromBody(body).filter((variable) => !SUPPORTED_CONTACT_VARIABLES.has(variable));
}

function renderContactTemplate(body, contact) {
  const unsupported = unsupportedVariables(body);
  if (unsupported.length) {
    const error = new Error(`Variabel broadcast tidak didukung: ${unsupported.join(', ')}`);
    error.status = 422;
    error.code = 'UNSUPPORTED_BROADCAST_VARIABLES';
    throw error;
  }

  const values = {
    nama: String(contact?.name || '').trim(),
    nomor: String(contact?.phone_e164 || '').trim(),
  };
  const missing = variablesFromBody(body).filter((variable) => !values[variable]);
  if (missing.length) {
    const error = new Error(`Data kontak untuk variabel tidak tersedia: ${missing.join(', ')}`);
    error.status = 422;
    error.code = 'MISSING_CONTACT_TEMPLATE_DATA';
    throw error;
  }

  return String(body).replace(VARIABLE_PATTERN, (_, variable) => values[variable]);
}

module.exports = {
  variablesFromBody,
  unsupportedVariables,
  renderContactTemplate,
};
