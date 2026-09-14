exports.up = async function up(knex) {
  await knex.schema.createTable('qa_session_questions', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.integer('session_number').unsigned().notNullable().unique();
    table.string('title', 255).notNullable();
    table.text('question_text', 'text').nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('qa_session_questions');
};
