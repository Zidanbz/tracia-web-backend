const IMPORTED_CONTACT_CONSENT = Object.freeze({
  status: 'granted',
  source: 'excel_import_admin',
});

function buildImportedConsent(consentAt) {
  return {
    consent_status: IMPORTED_CONTACT_CONSENT.status,
    consent_source: IMPORTED_CONTACT_CONSENT.source,
    consent_at: consentAt,
  };
}

function isLatestCampaignImport(record, latestRecord) {
  if (!record?.campaign_id) return true;
  return Boolean(latestRecord) && Number(record.id) === Number(latestRecord.id);
}

module.exports = {
  IMPORTED_CONTACT_CONSENT,
  buildImportedConsent,
  isLatestCampaignImport,
};
