exports.up = async function up(knex) {
  await knex.schema.alterTable('campaigns', (table) => {
    table.dropColumn('reply_window_hours');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('campaigns', (table) => {
    table.integer('reply_window_hours').unsigned().notNullable().defaultTo(168).after('status');
  });
};
