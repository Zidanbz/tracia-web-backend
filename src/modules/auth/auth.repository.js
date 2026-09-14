const crypto = require('crypto');
const knex = require('../../database/knex');
const env = require('../../config/env');

function hashEmail(email) {
  return crypto
    .createHmac('sha256', env.session.secret)
    .update(email.trim().toLowerCase())
    .digest('hex');
}

async function findUserByEmail(email) {
  return knex('users')
    .select('id', 'name', 'email', 'password_hash', 'status', 'auth_version')
    .where({ email: email.toLowerCase() })
    .whereNull('deleted_at')
    .first();
}

async function findActiveUserById(id) {
  return knex('users')
    .where({ id, status: 'active' })
    .whereNull('deleted_at')
    .select('id', 'name', 'email', 'auth_version')
    .first();
}

async function getAuthorization(userId) {
  const roleRows = await knex('user_roles')
    .join('roles', 'roles.id', 'user_roles.role_id')
    .where('user_roles.user_id', userId)
    .pluck('roles.name');
  const permissionRows = await knex('user_roles')
    .join('role_permissions', 'role_permissions.role_id', 'user_roles.role_id')
    .join('permissions', 'permissions.id', 'role_permissions.permission_id')
    .where('user_roles.user_id', userId)
    .distinct()
    .pluck('permissions.code');
  return { roles: roleRows, permissions: permissionRows };
}

async function recordLoginAttempt({ userId = null, email, ipAddress, successful, failureReason = null }) {
  await knex('login_attempts').insert({
    user_id: userId,
    email_hash: hashEmail(email),
    ip_address: ipAddress,
    was_successful: successful,
    failure_reason: failureReason,
  });
}

async function updateLastLogin(userId) {
  await knex('users').where({ id: userId }).update({ last_login_at: knex.fn.now(3) });
}

module.exports = { findUserByEmail, findActiveUserById, getAuthorization, recordLoginAttempt, updateLastLogin };
