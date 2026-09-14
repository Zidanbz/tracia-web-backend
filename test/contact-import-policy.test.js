const test = require('node:test');
const assert = require('node:assert/strict');

const {
  IMPORTED_CONTACT_CONSENT,
  buildImportedConsent,
  isLatestCampaignImport,
} = require('../src/modules/contact-imports/contact-import-policy');

test('kontak hasil commit import mendapat consent granted dengan sumber admin', () => {
  const consentAt = new Date('2026-08-06T00:00:00.000Z');
  assert.deepEqual(IMPORTED_CONTACT_CONSENT, {
    status: 'granted',
    source: 'excel_import_admin',
  });
  assert.deepEqual(buildImportedConsent(consentAt), {
    consent_status: 'granted',
    consent_source: 'excel_import_admin',
    consent_at: consentAt,
  });
});

test('hanya preview terbaru yang boleh diproses untuk Campaign yang sama', () => {
  assert.equal(isLatestCampaignImport({ id: 35, campaign_id: 11 }, { id: 35 }), true);
  assert.equal(isLatestCampaignImport({ id: 34, campaign_id: 11 }, { id: 35 }), false);
  assert.equal(isLatestCampaignImport({ id: 7, campaign_id: null }, null), true);
});
