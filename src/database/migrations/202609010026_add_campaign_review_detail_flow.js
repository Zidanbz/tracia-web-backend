exports.up = async function up(knex) {
  await knex.schema.alterTable('campaign_contact_progress', (table) => {
    table.enum('status', [
      'not_started', 'in_progress', 'review_pending_details',
      'completed', 'stopped', 'needs_review',
    ]).notNullable().defaultTo('not_started').alter();
    table.json('review_fields').nullable().after('status');
  });
  await knex.schema.alterTable('campaign_incoming_messages', (table) => {
    table.enum('interaction_type', [
      'session_answer', 'reblast_confirmation', 'start_command', 'review_detail',
    ]).notNullable().defaultTo('session_answer').alter();
  });
};

exports.down = async function down(knex) {
  const [pendingDetail, storedFields, detailReply] = await Promise.all([
    knex('campaign_contact_progress').where({ status: 'review_pending_details' }).first('id'),
    knex('campaign_contact_progress').whereNotNull('review_fields').first('id'),
    knex('campaign_incoming_messages').where({ interaction_type: 'review_detail' }).first('id'),
  ]);
  if (pendingDetail || storedFields || detailReply) {
    throw new Error('Rollback review detail dibatalkan: alur pemilihan data koreksi sudah digunakan');
  }
  await knex.schema.alterTable('campaign_incoming_messages', (table) => {
    table.enum('interaction_type', ['session_answer', 'reblast_confirmation', 'start_command'])
      .notNullable().defaultTo('session_answer').alter();
  });
  await knex.schema.alterTable('campaign_contact_progress', (table) => {
    table.dropColumn('review_fields');
    table.enum('status', ['not_started', 'in_progress', 'completed', 'stopped', 'needs_review'])
      .notNullable().defaultTo('not_started').alter();
  });
};
