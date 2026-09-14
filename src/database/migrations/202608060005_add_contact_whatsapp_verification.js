exports.up = async function up(knex) {
  await knex.schema.alterTable('contact_imports', (table) => {
    table.enum('verification_status', [
      'pending', 'running', 'completed', 'completed_with_errors',
    ]).notNullable().defaultTo('pending').after('status');
  });

  await knex.schema.alterTable('contact_import_rows', (table) => {
    table.enum('wa_registration_status', [
      'not_applicable', 'pending', 'checking', 'registered', 'not_registered', 'check_failed',
    ]).notNullable().defaultTo('not_applicable').after('status');
    table.integer('wa_check_attempts').unsigned().notNullable().defaultTo(0);
    table.timestamp('wa_check_available_at', { precision: 3 }).nullable();
    table.timestamp('wa_checked_at', { precision: 3 }).nullable();
    table.string('wa_error_code', 100).nullable();
    table.timestamp('wa_locked_at', { precision: 3 }).nullable();
    table.string('wa_locked_by', 100).nullable();
    table.index(['wa_registration_status', 'wa_check_available_at'], 'contact_import_rows_wa_queue_idx');
    table.index(['contact_import_id', 'wa_registration_status'], 'contact_import_rows_wa_result_idx');
  });

  await knex.schema.alterTable('contacts', (table) => {
    table.enum('wa_registration_status', [
      'unknown', 'registered', 'not_registered', 'check_failed',
    ]).notNullable().defaultTo('unknown').after('status');
    table.timestamp('wa_registration_checked_at', { precision: 3 }).nullable();
    table.index(['wa_registration_status', 'deleted_at'], 'contacts_wa_registration_idx');
  });

  // Import lama yang belum di-commit ikut masuk antrean agar kebijakan baru
  // tidak dapat dilewati. Import yang sudah final tidak diubah datanya.
  const previewedImports = knex('contact_imports').select('id').where({ status: 'previewed' });
  await knex('contact_import_rows')
    .whereIn('contact_import_id', previewedImports)
    .where({ status: 'valid' })
    .update({
      wa_registration_status: 'pending',
      wa_check_available_at: knex.fn.now(3),
    });
  await knex('contact_imports').whereIn('status', ['committed', 'failed']).update({ verification_status: 'completed' });
  await knex('contact_imports')
    .where({ status: 'previewed' })
    .whereNotIn('id', knex('contact_import_rows').distinct('contact_import_id').where({ status: 'valid' }))
    .update({ verification_status: 'completed' });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('contacts', (table) => {
    table.dropIndex(['wa_registration_status', 'deleted_at'], 'contacts_wa_registration_idx');
    table.dropColumn('wa_registration_checked_at');
    table.dropColumn('wa_registration_status');
  });

  await knex.schema.alterTable('contact_import_rows', (table) => {
    table.dropIndex(['contact_import_id', 'wa_registration_status'], 'contact_import_rows_wa_result_idx');
    table.dropIndex(['wa_registration_status', 'wa_check_available_at'], 'contact_import_rows_wa_queue_idx');
    table.dropColumns(
      'wa_locked_by',
      'wa_locked_at',
      'wa_error_code',
      'wa_checked_at',
      'wa_check_available_at',
      'wa_check_attempts',
      'wa_registration_status',
    );
  });

  await knex.schema.alterTable('contact_imports', (table) => {
    table.dropColumn('verification_status');
  });
};
