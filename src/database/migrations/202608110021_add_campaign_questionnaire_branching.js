const crypto = require('crypto');
const { createTracerStudyQuestionnaire } = require('../../modules/campaigns/tracer-questionnaire');

exports.up = async function up(knex) {
  await knex.schema.createTable('campaign_questionnaires', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('public_id', 36).notNullable().unique();
    table.bigInteger('campaign_id').unsigned().notNullable();
    table.integer('version').unsigned().notNullable();
    table.string('name', 180).notNullable();
    table.boolean('is_current').notNullable().defaultTo(false);
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('campaign_id').references('campaigns.id').onDelete('CASCADE');
    table.unique(['campaign_id', 'version'], 'campaign_questionnaires_version_unique');
    table.index(['campaign_id', 'is_current'], 'campaign_questionnaires_current_idx');
  });

  await knex.schema.alterTable('campaign_questions', (table) => {
    table.bigInteger('questionnaire_id').unsigned().nullable().after('campaign_id');
  });
  const campaigns = await knex('campaigns').select('id');
  for (const campaign of campaigns) {
    const [questionnaireId] = await knex('campaign_questionnaires').insert({
      public_id: crypto.randomUUID(),
      campaign_id: campaign.id,
      version: 1,
      name: 'Questionnaire Legacy',
      is_current: true,
    });
    await knex('campaign_questions').where({ campaign_id: campaign.id }).update({ questionnaire_id: questionnaireId });
  }
  await knex.schema.alterTable('campaign_questions', (table) => {
    table.dropUnique([], 'campaign_questions_position_unique');
    table.unique(['questionnaire_id', 'position'], 'campaign_questions_version_position_unique');
    table.foreign('questionnaire_id', 'campaign_questions_questionnaire_fk')
      .references('campaign_questionnaires.id').onDelete('CASCADE');
    table.index(['questionnaire_id', 'is_active', 'position'], 'campaign_questions_version_active_idx');
  });

  await knex.schema.alterTable('campaign_question_options', (table) => {
    table.enum('action_type', ['next', 'goto', 'review', 'complete'])
      .notNullable().defaultTo('next').after('answer_text');
    table.bigInteger('next_question_id').unsigned().nullable().after('action_type');
    table.foreign('next_question_id', 'campaign_question_options_next_fk')
      .references('campaign_questions.id').onDelete('SET NULL');
    table.index('next_question_id', 'campaign_question_options_next_idx');
  });

  await knex.schema.alterTable('campaign_contact_progress', (table) => {
    table.enum('status', ['not_started', 'in_progress', 'completed', 'stopped', 'needs_review'])
      .notNullable().defaultTo('not_started').alter();
  });

  for (const campaign of campaigns) {
    await createTracerStudyQuestionnaire(knex, campaign.id, {
      name: 'Tracer Study Alumni 2026',
      makeCurrent: true,
    });
  }
};

exports.down = async function down(knex) {
  const newerQuestions = knex('campaign_questions as question')
    .join('campaign_questionnaires as questionnaire', 'questionnaire.id', 'question.questionnaire_id')
    .where('questionnaire.version', '>', 1).select('question.id');
  const [progressUse, answerUse, reviewUse] = await Promise.all([
    knex('campaign_contact_progress').whereIn('current_question_id', newerQuestions.clone()).first('id'),
    knex('campaign_incoming_messages').whereIn('campaign_question_id', newerQuestions.clone()).first('id'),
    knex('campaign_contact_progress').where({ status: 'needs_review' }).first('id'),
  ]);
  if (progressUse || answerUse || reviewUse) {
    throw new Error('Rollback questionnaire branching dibatalkan: versi baru sudah digunakan oleh progres atau histori alumni');
  }

  await knex('campaign_questionnaires').where('version', '>', 1).delete();
  await knex('campaign_questionnaires').where({ version: 1 }).update({ is_current: true });
  await knex.schema.alterTable('campaign_contact_progress', (table) => {
    table.enum('status', ['not_started', 'in_progress', 'completed', 'stopped'])
      .notNullable().defaultTo('not_started').alter();
  });
  await knex.schema.alterTable('campaign_question_options', (table) => {
    table.dropIndex([], 'campaign_question_options_next_idx');
    table.dropForeign([], 'campaign_question_options_next_fk');
    table.dropColumns('next_question_id', 'action_type');
  });
  await knex.schema.alterTable('campaign_questions', (table) => {
    table.dropIndex([], 'campaign_questions_version_active_idx');
    table.dropForeign([], 'campaign_questions_questionnaire_fk');
    table.dropUnique([], 'campaign_questions_version_position_unique');
    table.unique(['campaign_id', 'position'], 'campaign_questions_position_unique');
    table.dropColumn('questionnaire_id');
  });
  await knex.schema.dropTableIfExists('campaign_questionnaires');
};
