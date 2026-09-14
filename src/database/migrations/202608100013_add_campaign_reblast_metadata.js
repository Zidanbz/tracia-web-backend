exports.up = async function up(knex) {
  await knex.schema.alterTable('broadcasts', (table) => {
    table.enum('campaign_delivery_type', ['blast', 'reblast_no_reply', 'reblast_stalled'])
      .nullable().after('campaign_idempotency_key');
    table.integer('campaign_target_session').unsigned().nullable().after('campaign_delivery_type');
    table.index(
      ['campaign_id', 'campaign_delivery_type', 'created_at'],
      'broadcasts_campaign_delivery_idx',
    );
  });
  await knex('broadcasts').whereNotNull('campaign_id').whereNull('campaign_delivery_type')
    .update({ campaign_delivery_type: 'blast' });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('broadcasts', (table) => {
    table.dropIndex([], 'broadcasts_campaign_delivery_idx');
    table.dropColumns('campaign_target_session', 'campaign_delivery_type');
  });
};
