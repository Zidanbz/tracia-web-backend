exports.up = async function up(knex) {
  await knex.schema.createTable('whatsapp_accounts', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('public_id', 64).notNullable().unique();
    table.string('name', 120).notNullable();
    table.string('phone_number', 32).nullable();
    table.enum('status', [
      'idle', 'initializing', 'awaiting_qr', 'ready', 'disconnected', 'error',
    ]).notNullable().defaultTo('idle');
    table.timestamp('last_connected_at', { precision: 3 }).nullable();
    table.timestamp('last_disconnected_at', { precision: 3 }).nullable();
    table.string('last_error_code', 100).nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.index('status');
  });

  await knex.schema.createTable('whatsapp_connection_events', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.bigInteger('whatsapp_account_id').unsigned().notNullable();
    table.string('event_type', 80).notNullable();
    table.json('metadata').nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('whatsapp_account_id').references('whatsapp_accounts.id').onDelete('CASCADE');
    table.index(['whatsapp_account_id', 'created_at']);
  });

  await knex('whatsapp_accounts').insert({
    public_id: 'default',
    name: 'WhatsApp Utama',
    status: 'idle',
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('whatsapp_connection_events');
  await knex.schema.dropTableIfExists('whatsapp_accounts');
};
