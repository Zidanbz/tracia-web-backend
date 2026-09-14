exports.up = async function up(knex) {
  await knex.schema.alterTable('campaign_contact_progress', (table) => {
    table.timestamp('reset_at', { precision: 3 }).nullable().after('completed_at');
    table.integer('reset_count').unsigned().notNullable().defaultTo(0).after('reset_at');
  });
};

exports.down = async function down(knex) {
  const resetProgress = await knex('campaign_contact_progress').whereNotNull('reset_at').first('id');
  if (resetProgress) {
    throw new Error('Rollback reset boundary dibatalkan: progres Campaign sudah pernah direset');
  }
  await knex.schema.alterTable('campaign_contact_progress', (table) => {
    table.dropColumns('reset_count', 'reset_at');
  });
};
