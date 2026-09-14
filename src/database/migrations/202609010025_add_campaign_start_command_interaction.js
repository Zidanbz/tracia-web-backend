exports.up = async function up(knex) {
  await knex.schema.alterTable('campaign_incoming_messages', (table) => {
    table.enum('interaction_type', ['session_answer', 'reblast_confirmation', 'start_command'])
      .notNullable().defaultTo('session_answer').alter();
  });
};

exports.down = async function down(knex) {
  await knex('campaign_incoming_messages')
    .where({ interaction_type: 'start_command' })
    .update({ interaction_type: 'session_answer' });
  await knex.schema.alterTable('campaign_incoming_messages', (table) => {
    table.enum('interaction_type', ['session_answer', 'reblast_confirmation'])
      .notNullable().defaultTo('session_answer').alter();
  });
};
