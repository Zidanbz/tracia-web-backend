exports.up = async function up(knex) {
  await knex.schema.alterTable('campaign_incoming_messages', (table) => {
    table.enum('interaction_type', ['session_answer', 'reblast_confirmation'])
      .notNullable().defaultTo('session_answer').after('attribution_method');
    table.enum('reblast_decision', ['accepted', 'declined', 'invalid'])
      .nullable().after('interaction_type');
    table.bigInteger('reply_to_message_id').unsigned().nullable().after('reblast_decision');
    table.foreign('reply_to_message_id', 'campaign_incoming_reply_message_fk')
      .references('messages.id').onDelete('SET NULL');
    table.index(
      ['campaign_id', 'interaction_type', 'reblast_decision'],
      'campaign_incoming_interaction_idx',
    );
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('campaign_incoming_messages', (table) => {
    table.dropIndex([], 'campaign_incoming_interaction_idx');
    table.dropForeign([], 'campaign_incoming_reply_message_fk');
    table.dropColumns('reply_to_message_id', 'reblast_decision', 'interaction_type');
  });
};
