exports.up = async function up(knex) {
  await knex.schema.alterTable('campaign_questions', (table) => {
    table.bigInteger('next_question_id').unsigned().nullable().after('answer_type');
    table.foreign('next_question_id', 'campaign_questions_next_fk')
      .references('campaign_questions.id').onDelete('SET NULL');
    table.index('next_question_id', 'campaign_questions_next_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('campaign_questions', (table) => {
    table.dropIndex([], 'campaign_questions_next_idx');
    table.dropForeign([], 'campaign_questions_next_fk');
    table.dropColumn('next_question_id');
  });
};
