exports.up = async function up(knex) {
  await knex.schema.alterTable('campaign_incoming_messages', (table) => {
    table.enum('attribution_method', ['quoted_message', 'single_active_campaign', 'latest_outbound', 'manual'])
      .notNullable().alter();
  });
};

exports.down = async function down(knex) {
  await knex('campaign_incoming_messages')
    .where({ attribution_method: 'single_active_campaign' })
    .update({ attribution_method: 'latest_outbound' });
  await knex.schema.alterTable('campaign_incoming_messages', (table) => {
    table.enum('attribution_method', ['quoted_message', 'latest_outbound', 'manual'])
      .notNullable().alter();
  });
};
