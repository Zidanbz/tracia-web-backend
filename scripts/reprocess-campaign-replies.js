#!/usr/bin/env node

const knex = require('../src/database/knex');
const { resolveCampaign, attributeAndAdvance } = require('../src/modules/campaigns/campaign-attribution');

const shouldCommit = process.argv.includes('--commit');

async function run() {
  const incomingRows = await knex('incoming_messages as incoming')
    .leftJoin('campaign_incoming_messages as attribution', 'attribution.incoming_message_id', 'incoming.id')
    .whereNull('attribution.id')
    .whereNotNull('incoming.contact_id')
    .select('incoming.*')
    .orderBy('incoming.received_at')
    .orderBy('incoming.id');

  const summary = { inspected: incomingRows.length, eligible: 0, attributed: 0, queued: 0, skipped: 0 };
  for (const incoming of incomingRows) {
    const resolved = await resolveCampaign(incoming, knex);
    if (!resolved) {
      summary.skipped += 1;
      continue;
    }
    summary.eligible += 1;
    if (!shouldCommit) continue;
    const result = await attributeAndAdvance(incoming);
    if (result.duplicate) continue;
    summary.attributed += 1;
    if (result.auto_reply_message_id) summary.queued += 1;
  }

  process.stdout.write(`${JSON.stringify({ mode: shouldCommit ? 'commit' : 'dry-run', ...summary })}\n`);
}

run()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => knex.destroy());
