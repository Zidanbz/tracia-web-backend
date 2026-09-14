exports.up = async function up(knex) {
  await knex.schema.createTable('contacts', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('name', 150).notNullable();
    table.string('phone_e164', 20).notNullable().unique();
    table.string('country_code', 4).notNullable();
    table.enum('status', ['active', 'invalid', 'blocked', 'opted_out']).notNullable().defaultTo('active');
    table.enum('consent_status', ['unknown', 'granted', 'revoked']).notNullable().defaultTo('unknown');
    table.string('consent_source', 100).nullable();
    table.timestamp('consent_at', { precision: 3 }).nullable();
    table.timestamp('opted_out_at', { precision: 3 }).nullable();
    table.json('custom_fields').nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('deleted_at', { precision: 3 }).nullable();
    table.index(['status', 'deleted_at']);
  });

  await knex.schema.createTable('contact_groups', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('name', 150).notNullable().unique();
    table.string('description', 255).nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
  });

  await knex.schema.createTable('contact_group_members', (table) => {
    table.bigInteger('contact_group_id').unsigned().notNullable();
    table.bigInteger('contact_id').unsigned().notNullable();
    table.primary(['contact_group_id', 'contact_id']);
    table.foreign('contact_group_id').references('contact_groups.id').onDelete('CASCADE');
    table.foreign('contact_id').references('contacts.id').onDelete('CASCADE');
  });

  await knex.schema.createTable('contact_imports', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('original_filename', 255).notNullable();
    table.enum('status', ['processing', 'previewed', 'committed', 'failed']).notNullable();
    table.integer('total_count').unsigned().notNullable().defaultTo(0);
    table.integer('valid_count').unsigned().notNullable().defaultTo(0);
    table.integer('invalid_count').unsigned().notNullable().defaultTo(0);
    table.integer('duplicate_count').unsigned().notNullable().defaultTo(0);
    table.json('error_summary').nullable();
    table.bigInteger('created_by').unsigned().nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('created_by').references('users.id').onDelete('SET NULL');
  });

  await knex.schema.createTable('contact_import_rows', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.bigInteger('contact_import_id').unsigned().notNullable();
    table.integer('row_number').unsigned().notNullable();
    table.string('name', 150).nullable();
    table.string('raw_phone', 100).nullable();
    table.string('normalized_phone', 20).nullable();
    table.enum('status', ['valid', 'invalid', 'duplicate']).notNullable();
    table.string('reason', 120).nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('contact_import_id').references('contact_imports.id').onDelete('CASCADE');
    table.unique(['contact_import_id', 'row_number']);
    table.index(['contact_import_id', 'status']);
  });

  await knex.schema.createTable('media_assets', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('storage_key', 512).notNullable().unique();
    table.string('original_filename', 255).notNullable();
    table.string('mime_type', 120).notNullable();
    table.bigInteger('size_bytes').unsigned().notNullable();
    table.string('checksum_sha256', 64).notNullable();
    table.bigInteger('created_by').unsigned().nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('created_by').references('users.id').onDelete('SET NULL');
  });

  await knex.schema.createTable('message_templates', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('name', 150).notNullable().unique();
    table.text('body', 'text').notNullable();
    table.json('variables').nullable();
    table.enum('status', ['draft', 'active', 'archived']).notNullable().defaultTo('draft');
    table.bigInteger('created_by').unsigned().nullable();
    table.bigInteger('updated_by').unsigned().nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('created_by').references('users.id').onDelete('SET NULL');
    table.foreign('updated_by').references('users.id').onDelete('SET NULL');
    table.index('status');
  });

  await knex.schema.createTable('broadcasts', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('public_id', 36).notNullable().unique();
    table.string('name', 180).notNullable();
    table.bigInteger('whatsapp_account_id').unsigned().notNullable();
    table.text('body_snapshot', 'text').notNullable();
    table.bigInteger('media_asset_id').unsigned().nullable();
    table.enum('status', ['draft', 'scheduled', 'running', 'paused', 'completed', 'partially_failed', 'cancelled']).notNullable().defaultTo('draft');
    table.timestamp('scheduled_at', { precision: 3 }).nullable();
    table.timestamp('started_at', { precision: 3 }).nullable();
    table.timestamp('completed_at', { precision: 3 }).nullable();
    table.integer('total_count').unsigned().notNullable().defaultTo(0);
    table.integer('queued_count').unsigned().notNullable().defaultTo(0);
    table.integer('sent_count').unsigned().notNullable().defaultTo(0);
    table.integer('failed_count').unsigned().notNullable().defaultTo(0);
    table.integer('skipped_count').unsigned().notNullable().defaultTo(0);
    table.bigInteger('created_by').unsigned().nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('whatsapp_account_id').references('whatsapp_accounts.id');
    table.foreign('media_asset_id').references('media_assets.id').onDelete('SET NULL');
    table.foreign('created_by').references('users.id').onDelete('SET NULL');
    table.index(['status', 'scheduled_at']);
  });

  await knex.schema.createTable('messages', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('public_id', 36).notNullable().unique();
    table.bigInteger('whatsapp_account_id').unsigned().notNullable();
    table.bigInteger('contact_id').unsigned().nullable();
    table.bigInteger('broadcast_id').unsigned().nullable();
    table.string('recipient_phone_e164', 20).notNullable();
    table.enum('message_type', ['text', 'image', 'document']).notNullable().defaultTo('text');
    table.text('body', 'text').notNullable();
    table.bigInteger('media_asset_id').unsigned().nullable();
    table.enum('source', ['dashboard', 'broadcast', 'api']).notNullable();
    table.enum('status', ['draft', 'queued', 'processing', 'sent', 'failed', 'cancelled']).notNullable().defaultTo('draft');
    table.timestamp('scheduled_at', { precision: 3 }).nullable();
    table.timestamp('sent_at', { precision: 3 }).nullable();
    table.timestamp('failed_at', { precision: 3 }).nullable();
    table.string('external_message_id', 255).nullable();
    table.string('idempotency_key', 100).nullable();
    table.bigInteger('created_by').unsigned().nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('whatsapp_account_id').references('whatsapp_accounts.id');
    table.foreign('contact_id').references('contacts.id').onDelete('SET NULL');
    table.foreign('broadcast_id').references('broadcasts.id').onDelete('SET NULL');
    table.foreign('media_asset_id').references('media_assets.id').onDelete('SET NULL');
    table.foreign('created_by').references('users.id').onDelete('SET NULL');
    table.unique(['source', 'idempotency_key']);
    table.index(['status', 'scheduled_at']);
    table.index(['recipient_phone_e164', 'created_at']);
  });

  await knex.schema.createTable('message_events', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.bigInteger('message_id').unsigned().notNullable();
    table.string('event_type', 80).notNullable();
    table.string('error_code', 100).nullable();
    table.json('metadata').nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('message_id').references('messages.id').onDelete('CASCADE');
    table.index(['message_id', 'created_at']);
  });

  await knex.schema.createTable('message_jobs', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.bigInteger('message_id').unsigned().notNullable().unique();
    table.enum('status', ['pending', 'reserved', 'processing', 'completed', 'failed', 'cancelled']).notNullable().defaultTo('pending');
    table.timestamp('available_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('locked_at', { precision: 3 }).nullable();
    table.string('locked_by', 100).nullable();
    table.integer('attempts').unsigned().notNullable().defaultTo(0);
    table.integer('max_attempts').unsigned().notNullable().defaultTo(3);
    table.string('last_error_code', 100).nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('message_id').references('messages.id').onDelete('CASCADE');
    table.index(['status', 'available_at']);
    table.index(['locked_at', 'locked_by']);
  });

  await knex.schema.createTable('broadcast_recipients', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.bigInteger('broadcast_id').unsigned().notNullable();
    table.bigInteger('contact_id').unsigned().nullable();
    table.bigInteger('message_id').unsigned().nullable();
    table.string('recipient_phone_e164', 20).notNullable();
    table.enum('status', ['pending', 'queued', 'sent', 'failed', 'skipped']).notNullable().defaultTo('pending');
    table.string('skip_reason', 100).nullable();
    table.foreign('broadcast_id').references('broadcasts.id').onDelete('CASCADE');
    table.foreign('contact_id').references('contacts.id').onDelete('SET NULL');
    table.foreign('message_id').references('messages.id').onDelete('SET NULL');
    table.unique(['broadcast_id', 'recipient_phone_e164']);
  });

  await knex.schema.createTable('api_keys', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('name', 150).notNullable();
    table.string('key_prefix', 16).notNullable().unique();
    table.string('key_hash', 64).notNullable().unique();
    table.json('scopes').notNullable();
    table.enum('status', ['active', 'revoked']).notNullable().defaultTo('active');
    table.timestamp('expires_at', { precision: 3 }).nullable();
    table.timestamp('last_used_at', { precision: 3 }).nullable();
    table.bigInteger('created_by').unsigned().nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('created_by').references('users.id').onDelete('SET NULL');
  });

  await knex.schema.createTable('webhooks', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('url', 2048).notNullable();
    table.text('signing_secret_encrypted', 'text').notNullable();
    table.json('subscribed_events').notNullable();
    table.enum('status', ['active', 'inactive']).notNullable().defaultTo('active');
    table.bigInteger('created_by').unsigned().nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('created_by').references('users.id').onDelete('SET NULL');
  });

  await knex.schema.createTable('webhook_deliveries', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.bigInteger('webhook_id').unsigned().notNullable();
    table.string('event_name', 120).notNullable();
    table.json('payload').notNullable();
    table.integer('response_status').unsigned().nullable();
    table.integer('attempts').unsigned().notNullable().defaultTo(0);
    table.timestamp('next_retry_at', { precision: 3 }).nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('webhook_id').references('webhooks.id').onDelete('CASCADE');
    table.index(['next_retry_at', 'attempts']);
  });

  await knex.schema.createTable('api_request_logs', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.bigInteger('api_key_id').unsigned().nullable();
    table.string('request_id', 64).notNullable();
    table.string('method', 10).notNullable();
    table.string('endpoint', 255).notNullable();
    table.integer('response_status').unsigned().notNullable();
    table.integer('duration_ms').unsigned().notNullable();
    table.string('ip_address', 45).nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('api_key_id').references('api_keys.id').onDelete('SET NULL');
    table.index(['api_key_id', 'created_at']);
  });

  await knex.schema.createTable('application_settings', (table) => {
    table.string('setting_key', 120).primary();
    table.enum('value_type', ['string', 'number', 'boolean', 'json']).notNullable();
    table.text('setting_value', 'text').notNullable();
    table.string('category', 80).notNullable();
    table.bigInteger('updated_by').unsigned().nullable();
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('updated_by').references('users.id').onDelete('SET NULL');
    table.index('category');
  });
};

exports.down = async function down(knex) {
  const tables = [
    'application_settings', 'api_request_logs', 'webhook_deliveries', 'webhooks',
    'api_keys', 'broadcast_recipients', 'message_jobs', 'message_events', 'messages',
    'broadcasts', 'message_templates', 'media_assets', 'contact_import_rows', 'contact_imports',
    'contact_group_members', 'contact_groups', 'contacts',
  ];
  for (const table of tables) await knex.schema.dropTableIfExists(table);
};
