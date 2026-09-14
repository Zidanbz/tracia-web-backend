const REVIEW_FIELDS = Object.freeze([
  Object.freeze({ key: 'name', label: 'Nama', aliases: ['nama'] }),
  Object.freeze({ key: 'study_program', label: 'Program Studi', aliases: ['program studi', 'prodi', 'jurusan'] }),
  Object.freeze({ key: 'email', label: 'Email', aliases: ['email', 'surel'] }),
  Object.freeze({
    key: 'phone', label: 'No. HP/WhatsApp',
    aliases: ['nomor', 'nomor hp', 'nomor whatsapp', 'no hp', 'hp', 'whatsapp', 'wa'],
  }),
  Object.freeze({ key: 'entry_year', label: 'Tahun Masuk', aliases: ['tahun masuk', 'angkatan'] }),
]);

const REVIEW_DETAIL_PROMPT = [
  'Baik, Kak. Supaya tim kami memperbaiki bagian yang tepat, boleh beri tahu data mana yang belum sesuai? 😊',
  '',
  ...REVIEW_FIELDS.map((field, index) => `${index + 1}. ${field.label}`),
  '',
  'Kakak boleh memilih satu atau beberapa nomor, misalnya 1 atau 1,3.',
  'Jika semua data tidak sesuai, balas SEMUA ya.',
].join('\n');

const REVIEW_DETAIL_RETRY_PROMPT = [
  'Maaf, Kak, bagian yang perlu diperbaiki belum terbaca.',
  'Balas dengan satu atau beberapa nomor, misalnya 1 atau 1,3. Jika semuanya tidak sesuai, balas SEMUA ya.',
  '',
  ...REVIEW_FIELDS.map((field, index) => `${index + 1}. ${field.label}`),
].join('\n');

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('id-ID')
    .replace(/\./g, '')
    .replace(/[.!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function allReviewFieldKeys() {
  return REVIEW_FIELDS.map((field) => field.key);
}

function parseReviewFieldSelection(value) {
  const normalized = normalize(value);
  if (!normalized) return { valid: false, fields: [], all: false };
  if (/^(?:semua|semuanya|semua data|seluruhnya|seluruh data)(?:\s+(?:salah|tidak sesuai))?$/.test(normalized)) {
    return { valid: true, fields: allReviewFieldKeys(), all: true };
  }

  const numericInput = normalized
    .replace(/\b(?:dan|serta)\b/g, ',')
    .replace(/[&+]/g, ',');
  if (/^[\d,\s]+$/.test(numericInput)) {
    const numbers = numericInput.split(/[\s,]+/).filter(Boolean).map(Number);
    if (!numbers.length || numbers.some((number) => !Number.isInteger(number) || number < 1 || number > REVIEW_FIELDS.length)) {
      return { valid: false, fields: [], all: false };
    }
    return {
      valid: true,
      fields: [...new Set(numbers)].map((number) => REVIEW_FIELDS[number - 1].key),
      all: false,
    };
  }

  const textParts = normalized.split(/\s*(?:,|\/|\bdan\b|\bserta\b|&|\+)\s*/).filter(Boolean);
  const fields = textParts.map((part) => REVIEW_FIELDS.find((field) => field.aliases.includes(part))?.key);
  if (!fields.length || fields.some((field) => !field)) return { valid: false, fields: [], all: false };
  return { valid: true, fields: [...new Set(fields)], all: false };
}

function parseStoredReviewFields(value) {
  if (!value) return [];
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const allowed = new Set(allReviewFieldKeys());
  return [...new Set(parsed.map(String).filter((field) => allowed.has(field)))];
}

function reviewFieldLabels(fields) {
  const selected = new Set(parseStoredReviewFields(fields));
  return REVIEW_FIELDS.filter((field) => selected.has(field.key)).map((field) => field.label);
}

function formatReviewAcknowledgement(fields) {
  const labels = reviewFieldLabels(fields);
  return [
    'Terima kasih sudah menjelaskan, Kak 😊',
    '',
    `Bagian yang akan diperiksa oleh tim kami: ${labels.join(', ')}.`,
    'Pengisian Tracer Study dijeda sementara. Setelah datanya diperbaiki, kami akan mengirim ulang konfirmasi agar Kakak dapat memeriksanya kembali.',
  ].join('\n');
}

function buildReviewDetailReply(value) {
  const selection = parseReviewFieldSelection(value);
  if (!selection.valid) {
    return {
      valid: false,
      fields: [],
      response_body: REVIEW_DETAIL_RETRY_PROMPT,
      progress_update: {},
    };
  }
  return {
    valid: true,
    fields: selection.fields,
    response_body: formatReviewAcknowledgement(selection.fields),
    progress_update: {
      status: 'needs_review',
      review_fields: JSON.stringify(selection.fields),
    },
  };
}

module.exports = {
  REVIEW_DETAIL_PROMPT,
  REVIEW_DETAIL_RETRY_PROMPT,
  REVIEW_FIELDS,
  allReviewFieldKeys,
  buildReviewDetailReply,
  formatReviewAcknowledgement,
  parseReviewFieldSelection,
  parseStoredReviewFields,
  reviewFieldLabels,
};
