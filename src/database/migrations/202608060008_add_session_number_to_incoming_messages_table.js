exports.up = async function up(knex) {
  const hasColumn = await knex.schema.hasColumn('incoming_messages', 'session_number');
  if (!hasColumn) {
    await knex.schema.table('incoming_messages', (table) => {
      table.integer('session_number').unsigned().notNullable().defaultTo(1);
      table.index('session_number');
    });
  }
};

exports.down = async function down(knex) {
  const hasColumn = await knex.schema.hasColumn('incoming_messages', 'session_number');
  if (hasColumn) {
    await knex.schema.table('incoming_messages', (table) => {
      table.dropIndex('session_number');
      table.dropColumn('session_number');
    });
  }
};
