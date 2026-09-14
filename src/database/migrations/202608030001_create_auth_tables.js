exports.up = async function up(knex) {
  await knex.schema.createTable('roles', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('name', 64).notNullable().unique();
    table.string('description', 255).nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
  });

  await knex.schema.createTable('permissions', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('code', 100).notNullable().unique();
    table.string('description', 255).nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
  });

  await knex.schema.createTable('users', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.string('name', 150).notNullable();
    table.string('email', 255).notNullable().unique();
    table.string('password_hash', 255).notNullable();
    table.enum('status', ['active', 'inactive', 'locked']).notNullable().defaultTo('active');
    table.timestamp('last_login_at', { precision: 3 }).nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('updated_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.timestamp('deleted_at', { precision: 3 }).nullable();
    table.index(['status', 'deleted_at']);
  });

  await knex.schema.createTable('role_permissions', (table) => {
    table.bigInteger('role_id').unsigned().notNullable();
    table.bigInteger('permission_id').unsigned().notNullable();
    table.primary(['role_id', 'permission_id']);
    table.foreign('role_id').references('roles.id').onDelete('CASCADE');
    table.foreign('permission_id').references('permissions.id').onDelete('CASCADE');
  });

  await knex.schema.createTable('user_roles', (table) => {
    table.bigInteger('user_id').unsigned().notNullable();
    table.bigInteger('role_id').unsigned().notNullable();
    table.primary(['user_id', 'role_id']);
    table.foreign('user_id').references('users.id').onDelete('CASCADE');
    table.foreign('role_id').references('roles.id').onDelete('CASCADE');
  });

  await knex.schema.createTable('sessions', (table) => {
    table.string('session_id', 128).primary();
    table.integer('expires').unsigned().notNullable();
    table.text('data', 'mediumtext').nullable();
    table.index('expires');
  });

  await knex.schema.createTable('login_attempts', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.bigInteger('user_id').unsigned().nullable();
    table.string('email_hash', 64).notNullable();
    table.string('ip_address', 45).nullable();
    table.boolean('was_successful').notNullable().defaultTo(false);
    table.string('failure_reason', 64).nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('user_id').references('users.id').onDelete('SET NULL');
    table.index(['email_hash', 'created_at']);
    table.index(['ip_address', 'created_at']);
  });

  await knex.schema.createTable('password_reset_tokens', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.bigInteger('user_id').unsigned().notNullable();
    table.string('token_hash', 64).notNullable().unique();
    table.timestamp('expires_at', { precision: 3 }).notNullable();
    table.timestamp('used_at', { precision: 3 }).nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('user_id').references('users.id').onDelete('CASCADE');
    table.index(['user_id', 'expires_at']);
  });

  await knex.schema.createTable('audit_logs', (table) => {
    table.bigIncrements('id').unsigned().primary();
    table.bigInteger('actor_user_id').unsigned().nullable();
    table.string('actor_type', 32).notNullable().defaultTo('user');
    table.string('action', 120).notNullable();
    table.string('entity_type', 80).nullable();
    table.string('entity_id', 100).nullable();
    table.json('before_data').nullable();
    table.json('after_data').nullable();
    table.string('request_id', 64).nullable();
    table.string('ip_address', 45).nullable();
    table.string('user_agent', 512).nullable();
    table.timestamp('created_at', { precision: 3 }).notNullable().defaultTo(knex.fn.now(3));
    table.foreign('actor_user_id').references('users.id').onDelete('SET NULL');
    table.index(['actor_user_id', 'created_at']);
    table.index(['entity_type', 'entity_id']);
    table.index(['action', 'created_at']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('audit_logs');
  await knex.schema.dropTableIfExists('password_reset_tokens');
  await knex.schema.dropTableIfExists('login_attempts');
  await knex.schema.dropTableIfExists('sessions');
  await knex.schema.dropTableIfExists('user_roles');
  await knex.schema.dropTableIfExists('role_permissions');
  await knex.schema.dropTableIfExists('users');
  await knex.schema.dropTableIfExists('permissions');
  await knex.schema.dropTableIfExists('roles');
};
