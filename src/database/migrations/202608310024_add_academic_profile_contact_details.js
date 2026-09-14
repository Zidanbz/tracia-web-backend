exports.up = async function up(knex) {
  await knex.schema.alterTable('contact_academic_profiles', (table) => {
    table.string('email', 254).nullable().after('entry_year');
    table.string('graduation_period', 30).nullable().after('email');
  });

  await knex.schema.alterTable('contact_import_rows', (table) => {
    table.string('email', 254).nullable().after('raw_study_program');
    table.string('graduation_period', 30).nullable().after('email');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('contact_import_rows', (table) => {
    table.dropColumns('graduation_period', 'email');
  });
  await knex.schema.alterTable('contact_academic_profiles', (table) => {
    table.dropColumns('graduation_period', 'email');
  });
};
