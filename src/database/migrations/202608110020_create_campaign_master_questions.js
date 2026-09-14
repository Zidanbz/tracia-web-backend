const crypto = require('crypto');

exports.up = async function up(knex) {
  await knex.schema.createTable('campaign_questions', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('public_id', 36).notNullable().unique();
    table.bigInteger('campaign_id').unsigned().notNullable();
    table.integer('position').unsigned().notNullable();
    table.string('title', 180).notNullable();
    table.text('question_text', 'text').notNullable();
    table.enum('answer_type', ['free_text', 'choice']).notNullable().defaultTo('choice');
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));

    table.foreign('campaign_id').references('campaigns.id').onDelete('CASCADE');
    table.unique(['campaign_id', 'position'], 'campaign_questions_position_unique');
    table.index(['campaign_id', 'is_active', 'position'], 'campaign_questions_active_idx');
  });

  await knex.schema.createTable('campaign_question_options', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('public_id', 36).notNullable().unique();
    table.bigInteger('campaign_question_id').unsigned().notNullable();
    table.integer('position').unsigned().notNullable();
    table.string('answer_text', 500).notNullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));

    table.foreign('campaign_question_id').references('campaign_questions.id').onDelete('CASCADE');
    table.unique(['campaign_question_id', 'position'], 'campaign_question_options_position_unique');
  });

  await knex.schema.alterTable('campaign_contact_progress', (table) => {
    table.bigInteger('current_question_id').unsigned().nullable().after('current_session_number');
    table.foreign('current_question_id', 'campaign_progress_question_fk')
      .references('campaign_questions.id').onDelete('SET NULL');
    table.index('current_question_id', 'campaign_progress_question_idx');
  });

  await knex.schema.alterTable('campaign_incoming_messages', (table) => {
    table.bigInteger('campaign_question_id').unsigned().nullable().after('campaign_contact_id');
    table.bigInteger('campaign_question_option_id').unsigned().nullable().after('campaign_question_id');
    table.foreign('campaign_question_id', 'campaign_incoming_question_fk')
      .references('campaign_questions.id').onDelete('SET NULL');
    table.foreign('campaign_question_option_id', 'campaign_incoming_option_fk')
      .references('campaign_question_options.id').onDelete('SET NULL');
    table.index(['campaign_question_id', 'campaign_question_option_id'], 'campaign_incoming_answer_idx');
  });

  const [campaigns, defaults] = await Promise.all([
    knex('campaigns').select('id'),
    knex('qa_session_questions').orderBy('session_number'),
  ]);
  for (const campaign of campaigns) {
    for (const question of defaults) {
      await knex('campaign_questions').insert({
        public_id: crypto.randomUUID(),
        campaign_id: campaign.id,
        position: question.session_number,
        title: question.title,
        question_text: question.question_text || question.title,
        answer_type: 'free_text',
        is_active: question.is_active,
      });
    }
  }

  await knex.raw(`
    UPDATE campaign_contact_progress progress
    JOIN campaign_contacts membership ON membership.id = progress.campaign_contact_id
    JOIN campaign_questions question
      ON question.campaign_id = membership.campaign_id
     AND question.position = progress.current_session_number
    SET progress.current_question_id = question.id
    WHERE progress.current_session_number > 0
  `);
  await knex.raw(`
    UPDATE campaign_incoming_messages attribution
    JOIN incoming_messages incoming ON incoming.id = attribution.incoming_message_id
    JOIN campaign_questions question
      ON question.campaign_id = attribution.campaign_id
     AND question.position = incoming.session_number
    SET attribution.campaign_question_id = question.id
    WHERE incoming.session_number IS NOT NULL
      AND attribution.interaction_type = 'session_answer'
  `);
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('campaign_incoming_messages', (table) => {
    table.dropIndex([], 'campaign_incoming_answer_idx');
    table.dropForeign([], 'campaign_incoming_option_fk');
    table.dropForeign([], 'campaign_incoming_question_fk');
    table.dropColumns('campaign_question_option_id', 'campaign_question_id');
  });
  await knex.schema.alterTable('campaign_contact_progress', (table) => {
    table.dropIndex([], 'campaign_progress_question_idx');
    table.dropForeign([], 'campaign_progress_question_fk');
    table.dropColumn('current_question_id');
  });
  await knex.schema.dropTableIfExists('campaign_question_options');
  await knex.schema.dropTableIfExists('campaign_questions');
};
