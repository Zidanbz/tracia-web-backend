exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (table) => {
    table.integer('auth_version').unsigned().notNullable().defaultTo(0).after('password_hash');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('auth_version');
  });
};
