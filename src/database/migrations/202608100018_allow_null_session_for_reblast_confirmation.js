exports.up = async function up(knex) {
  await knex.schema.alterTable('incoming_messages', (table) => {
    table.integer('session_number').unsigned().nullable().defaultTo(null).alter();
  });
};

exports.down = async function down(knex) {
  await knex('incoming_messages').whereNull('session_number').update({ session_number: 1 });
  await knex.schema.alterTable('incoming_messages', (table) => {
    table.integer('session_number').unsigned().notNullable().defaultTo(1).alter();
  });
};
