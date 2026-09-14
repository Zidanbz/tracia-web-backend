exports.up = async function up(knex) {
  await knex.schema.createTable('contact_academic_profiles', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.bigInteger('contact_id').unsigned().notNullable();
    table.bigInteger('university_group_id').unsigned().notNullable();
    table.bigInteger('faculty_group_id').unsigned().notNullable();
    table.bigInteger('study_program_group_id').unsigned().notNullable();
    table.string('student_number', 64).notNullable();
    table.smallint('entry_year').unsigned().notNullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));

    table.foreign('contact_id').references('contacts.id').onDelete('CASCADE');
    table.foreign('university_group_id').references('contact_groups.id').onDelete('RESTRICT');
    table.foreign('faculty_group_id').references('contact_groups.id').onDelete('RESTRICT');
    table.foreign('study_program_group_id').references('contact_groups.id').onDelete('RESTRICT');
    table.unique(['contact_id', 'university_group_id'], 'contact_academic_profile_contact_university_unique');
    table.unique(['university_group_id', 'student_number'], 'contact_academic_profile_university_nim_unique');
    table.index(['faculty_group_id', 'study_program_group_id'], 'contact_academic_profile_scope_idx');
    table.index(['entry_year'], 'contact_academic_profile_entry_year_idx');
  });

  await knex.schema.alterTable('contact_import_rows', (table) => {
    table.string('student_number', 64).nullable().after('normalized_phone');
    table.smallint('entry_year').unsigned().nullable().after('student_number');
    table.string('raw_faculty', 150).nullable().after('entry_year');
    table.string('raw_study_program', 150).nullable().after('raw_faculty');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('contact_import_rows', (table) => {
    table.dropColumns('raw_study_program', 'raw_faculty', 'entry_year', 'student_number');
  });
  await knex.schema.dropTableIfExists('contact_academic_profiles');
};
