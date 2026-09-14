exports.up = async function up(knex) {
  await knex.schema.alterTable('contact_groups', (table) => {
    table.enum('type', ['university', 'faculty', 'study_program', 'custom'])
      .notNullable().defaultTo('custom').alter();
  });

  await knex.schema.createTable('campaigns', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('public_id', 36).notNullable().unique();
    table.string('title', 180).notNullable();
    table.text('description', 'text').nullable();
    table.bigInteger('university_group_id').unsigned().notNullable();
    table.bigInteger('faculty_group_id').unsigned().nullable();
    table.bigInteger('study_program_group_id').unsigned().nullable();
    table.bigInteger('operator_user_id').unsigned().notNullable();
    table.enum('status', ['draft', 'active', 'paused', 'completed', 'archived'])
      .notNullable().defaultTo('draft');
    table.enum('archived_from_status', ['draft', 'active', 'paused', 'completed']).nullable();
    table.integer('reply_window_hours').unsigned().notNullable().defaultTo(168);
    table.bigInteger('created_by').unsigned().nullable();
    table.bigInteger('updated_by').unsigned().nullable();
    table.timestamp('archived_at', { precision: 3 }).nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));

    table.foreign('university_group_id').references('contact_groups.id').onDelete('RESTRICT');
    table.foreign('faculty_group_id').references('contact_groups.id').onDelete('RESTRICT');
    table.foreign('study_program_group_id').references('contact_groups.id').onDelete('RESTRICT');
    table.foreign('operator_user_id').references('users.id').onDelete('RESTRICT');
    table.foreign('created_by').references('users.id').onDelete('SET NULL');
    table.foreign('updated_by').references('users.id').onDelete('SET NULL');
    table.index(['status', 'updated_at'], 'campaigns_status_updated_idx');
    table.index(['operator_user_id', 'status'], 'campaigns_operator_status_idx');
    table.index(
      ['university_group_id', 'faculty_group_id', 'study_program_group_id'],
      'campaigns_academic_scope_idx',
    );
  });

  await knex.schema.createTable('campaign_contacts', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.bigInteger('campaign_id').unsigned().notNullable();
    table.bigInteger('contact_id').unsigned().notNullable();
    table.bigInteger('source_import_id').unsigned().nullable();
    table.enum('status', ['active', 'excluded', 'completed']).notNullable().defaultTo('active');
    table.string('exclusion_reason', 100).nullable();
    table.bigInteger('added_by').unsigned().nullable();
    table.timestamp('added_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('excluded_at', { precision: 3 }).nullable();
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));

    table.foreign('campaign_id').references('campaigns.id').onDelete('CASCADE');
    table.foreign('contact_id').references('contacts.id').onDelete('CASCADE');
    table.foreign('source_import_id').references('contact_imports.id').onDelete('SET NULL');
    table.foreign('added_by').references('users.id').onDelete('SET NULL');
    table.unique(['campaign_id', 'contact_id'], 'campaign_contacts_unique');
    table.index(['campaign_id', 'status'], 'campaign_contacts_status_idx');
  });

  await knex.schema.createTable('campaign_contact_progress', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.bigInteger('campaign_contact_id').unsigned().notNullable().unique();
    table.integer('current_session_number').unsigned().notNullable().defaultTo(0);
    table.enum('status', ['not_started', 'in_progress', 'completed', 'stopped'])
      .notNullable().defaultTo('not_started');
    table.bigInteger('last_incoming_message_id').unsigned().nullable();
    table.bigInteger('last_outbound_message_id').unsigned().nullable();
    table.timestamp('started_at', { precision: 3 }).nullable();
    table.timestamp('completed_at', { precision: 3 }).nullable();
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));

    table.foreign('campaign_contact_id').references('campaign_contacts.id').onDelete('CASCADE');
    table.foreign('last_incoming_message_id').references('incoming_messages.id').onDelete('SET NULL');
    table.foreign('last_outbound_message_id').references('messages.id').onDelete('SET NULL');
    table.index(['status', 'current_session_number'], 'campaign_progress_status_idx');
  });

  await knex.schema.alterTable('contact_imports', (table) => {
    table.bigInteger('campaign_id').unsigned().nullable().after('id');
    table.foreign('campaign_id', 'contact_imports_campaign_fk').references('campaigns.id').onDelete('RESTRICT');
    table.index(['campaign_id', 'status'], 'contact_imports_campaign_status_idx');
  });

  await knex.schema.alterTable('contact_import_rows', (table) => {
    table.bigInteger('study_program_group_id').unsigned().nullable().after('faculty_group_id');
    table.string('study_program_code', 32).nullable().after('faculty_code');
    table.string('study_program_name_snapshot', 150).nullable().after('faculty_name_snapshot');
    table.foreign('study_program_group_id', 'contact_import_rows_program_fk')
      .references('contact_groups.id').onDelete('SET NULL');
  });

  await knex.schema.alterTable('broadcasts', (table) => {
    table.bigInteger('campaign_id').unsigned().nullable().after('public_id');
    table.string('campaign_idempotency_key', 100).nullable().after('campaign_id');
    table.foreign('campaign_id', 'broadcasts_campaign_fk').references('campaigns.id').onDelete('RESTRICT');
    table.unique(['campaign_id', 'campaign_idempotency_key'], 'broadcasts_campaign_idempotency_unique');
    table.index(['campaign_id', 'status'], 'broadcasts_campaign_status_idx');
  });

  await knex.schema.alterTable('messages', (table) => {
    table.bigInteger('campaign_id').unsigned().nullable().after('broadcast_id');
    table.enum('source', ['dashboard', 'broadcast', 'api', 'campaign']).notNullable().alter();
    table.foreign('campaign_id', 'messages_campaign_fk').references('campaigns.id').onDelete('RESTRICT');
    table.index(['campaign_id', 'status'], 'messages_campaign_status_idx');
  });

  await knex.schema.alterTable('incoming_messages', (table) => {
    table.string('quoted_wa_message_id', 255).nullable().after('wa_message_id');
    table.index('quoted_wa_message_id', 'incoming_messages_quoted_idx');
  });

  await knex.schema.createTable('campaign_incoming_messages', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.bigInteger('incoming_message_id').unsigned().notNullable().unique();
    table.bigInteger('campaign_id').unsigned().notNullable();
    table.bigInteger('campaign_contact_id').unsigned().nullable();
    table.enum('attribution_method', ['quoted_message', 'latest_outbound', 'manual']).notNullable();
    table.bigInteger('attributed_by').unsigned().nullable();
    table.timestamp('attributed_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));

    table.foreign('incoming_message_id').references('incoming_messages.id').onDelete('CASCADE');
    table.foreign('campaign_id').references('campaigns.id').onDelete('RESTRICT');
    table.foreign('campaign_contact_id').references('campaign_contacts.id').onDelete('SET NULL');
    table.foreign('attributed_by').references('users.id').onDelete('SET NULL');
    table.index(['campaign_id', 'attributed_at'], 'campaign_incoming_campaign_time_idx');
  });
};

exports.down = async function down(knex) {
  const [{ count: campaignCount }] = await knex('campaigns').count({ count: '*' });
  const [{ count: programCount }] = await knex('contact_groups').where({ type: 'study_program' }).count({ count: '*' });
  if (Number(campaignCount) || Number(programCount)) {
    throw new Error('Rollback Campaign dibatalkan: arsipkan/backup dan hapus data Campaign serta program studi secara eksplisit terlebih dahulu');
  }

  await knex.schema.dropTableIfExists('campaign_incoming_messages');
  await knex.schema.alterTable('incoming_messages', (table) => {
    table.dropIndex([], 'incoming_messages_quoted_idx');
    table.dropColumn('quoted_wa_message_id');
  });
  await knex.schema.alterTable('messages', (table) => {
    table.dropForeign([], 'messages_campaign_fk');
    table.dropIndex([], 'messages_campaign_status_idx');
    table.dropColumn('campaign_id');
    table.enum('source', ['dashboard', 'broadcast', 'api']).notNullable().alter();
  });
  await knex.schema.alterTable('broadcasts', (table) => {
    table.dropForeign([], 'broadcasts_campaign_fk');
    table.dropIndex([], 'broadcasts_campaign_status_idx');
    table.dropUnique([], 'broadcasts_campaign_idempotency_unique');
    table.dropColumns('campaign_idempotency_key', 'campaign_id');
  });
  await knex.schema.alterTable('contact_import_rows', (table) => {
    table.dropForeign([], 'contact_import_rows_program_fk');
    table.dropColumns('study_program_name_snapshot', 'study_program_code', 'study_program_group_id');
  });
  await knex.schema.alterTable('contact_imports', (table) => {
    table.dropForeign([], 'contact_imports_campaign_fk');
    table.dropIndex([], 'contact_imports_campaign_status_idx');
    table.dropColumn('campaign_id');
  });
  await knex.schema.dropTableIfExists('campaign_contact_progress');
  await knex.schema.dropTableIfExists('campaign_contacts');
  await knex.schema.dropTableIfExists('campaigns');
  await knex.schema.alterTable('contact_groups', (table) => {
    table.enum('type', ['university', 'faculty', 'custom']).notNullable().defaultTo('custom').alter();
  });
};
