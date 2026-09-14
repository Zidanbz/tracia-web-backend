exports.up = async function up(knex) {
  await knex.schema.createTable('incoming_messages', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('public_id', 36).notNullable().unique();
    table.bigInteger('contact_id').unsigned().nullable();
    table.string('from_phone', 32).notNullable();
    table.string('from_name', 255).nullable();
    table.text('body', 'text').nullable();
    table.boolean('has_media').notNullable().defaultTo(false);
    table.string('media_type', 50).nullable();
    table.string('wa_message_id', 255).nullable();
    table.boolean('is_read').notNullable().defaultTo(false);
    table.timestamp('received_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));

    table.foreign('contact_id').references('contacts.id').onDelete('SET NULL');
    table.index(['is_read', 'received_at']);
    table.index('from_phone');
    table.index('wa_message_id');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('incoming_messages');
};
