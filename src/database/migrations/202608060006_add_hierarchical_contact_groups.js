function legacyCode(id) {
  return `LEGACY_${id}`;
}

exports.up = async function up(knex) {
  await knex.schema.alterTable('contact_groups', (table) => {
    table.dropUnique(['name']);
    table.bigInteger('parent_id').unsigned().nullable().after('id');
    table.enum('type', ['university', 'faculty', 'custom']).notNullable().defaultTo('custom').after('parent_id');
    table.string('code', 32).nullable().after('type');
    table.string('path_key', 191).nullable().after('code');
    table.enum('status', ['active', 'inactive']).notNullable().defaultTo('active').after('description');
  });

  const legacyGroups = await knex('contact_groups').select('id');
  for (const group of legacyGroups) {
    const code = legacyCode(group.id);
    await knex('contact_groups').where({ id: group.id }).update({
      type: 'custom',
      code,
      path_key: `CUSTOM/${code}`,
    });
  }

  await knex.schema.alterTable('contact_groups', (table) => {
    table.string('code', 32).notNullable().alter();
    table.string('path_key', 191).notNullable().alter();
    table.unique(['path_key'], 'contact_groups_path_key_unique');
    table.index(['parent_id', 'type', 'status'], 'contact_groups_hierarchy_idx');
    table.foreign('parent_id', 'contact_groups_parent_fk')
      .references('contact_groups.id')
      .onDelete('RESTRICT');
  });

  await knex.schema.alterTable('contact_import_rows', (table) => {
    table.bigInteger('university_group_id').unsigned().nullable().after('normalized_phone');
    table.bigInteger('faculty_group_id').unsigned().nullable().after('university_group_id');
    table.string('university_code', 32).nullable().after('faculty_group_id');
    table.string('faculty_code', 32).nullable().after('university_code');
    table.string('university_name_snapshot', 150).nullable().after('faculty_code');
    table.string('faculty_name_snapshot', 150).nullable().after('university_name_snapshot');
    table.enum('grouping_status', ['not_applicable', 'valid', 'invalid'])
      .notNullable().defaultTo('not_applicable').after('status');
    table.string('grouping_error_code', 100).nullable().after('grouping_status');
    table.index(['contact_import_id', 'grouping_status'], 'contact_import_rows_grouping_idx');
    table.foreign('university_group_id', 'contact_import_rows_university_fk')
      .references('contact_groups.id')
      .onDelete('SET NULL');
    table.foreign('faculty_group_id', 'contact_import_rows_faculty_fk')
      .references('contact_groups.id')
      .onDelete('SET NULL');
  });
};

exports.down = async function down(knex) {
  const duplicateName = await knex('contact_groups')
    .select('name')
    .count({ count: '*' })
    .groupBy('name')
    .havingRaw('COUNT(*) > 1')
    .first();
  if (duplicateName) {
    throw new Error('Rollback hierarki dibatalkan: terdapat nama contact group duplikat yang tidak kompatibel dengan schema lama');
  }
  await knex.schema.alterTable('contact_import_rows', (table) => {
    table.dropForeign([], 'contact_import_rows_faculty_fk');
    table.dropForeign([], 'contact_import_rows_university_fk');
    table.dropIndex([], 'contact_import_rows_grouping_idx');
    table.dropColumns(
      'grouping_error_code',
      'grouping_status',
      'faculty_name_snapshot',
      'university_name_snapshot',
      'faculty_code',
      'university_code',
      'faculty_group_id',
      'university_group_id',
    );
  });

  await knex.schema.alterTable('contact_groups', (table) => {
    table.dropForeign([], 'contact_groups_parent_fk');
    table.dropIndex([], 'contact_groups_hierarchy_idx');
    table.dropUnique([], 'contact_groups_path_key_unique');
    table.dropColumns('status', 'path_key', 'code', 'type', 'parent_id');
    table.unique(['name']);
  });
};
