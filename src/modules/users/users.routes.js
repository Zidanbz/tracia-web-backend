const express = require('express');
const bcrypt = require('bcrypt');
const { z } = require('zod');
const knex = require('../../database/knex');
const asyncHandler = require('../../shared/async-handler');
const { requirePermission } = require('../../middleware/auth');
const { writeRequestAudit } = require('../audit/audit.repository');
const { passwordSchema } = require('../auth/password-policy');

const router = express.Router();
const createSchema = z.object({
  name: z.string().trim().min(2).max(150),
  email: z.email().transform((value) => value.toLowerCase()),
  password: passwordSchema,
  role: z.enum(['super_admin', 'operator', 'viewer']),
});

router.get('/', requirePermission('users.view'), asyncHandler(async (req, res) => {
  const data = await knex('users')
    .leftJoin('user_roles', 'user_roles.user_id', 'users.id')
    .leftJoin('roles', 'roles.id', 'user_roles.role_id')
    .whereNull('users.deleted_at')
    .select('users.id', 'users.name', 'users.email', 'users.status', 'users.last_login_at', 'users.created_at')
    .select(knex.raw('GROUP_CONCAT(roles.name ORDER BY roles.name) AS roles'))
    .groupBy('users.id')
    .orderBy('users.id', 'desc');
  res.json({ success: true, data });
}));
router.post('/', requirePermission('users.manage'), asyncHandler(async (req, res) => {
  const value = createSchema.parse(req.body);
  const passwordHash = await bcrypt.hash(value.password, 12);
  let data;
  try {
    data = await knex.transaction(async (trx) => {
      const role = await trx('roles').where({ name: value.role }).first();
      const [id] = await trx('users').insert({
        name: value.name, email: value.email, password_hash: passwordHash, status: 'active',
      });
      await trx('user_roles').insert({ user_id: id, role_id: role.id });
      return trx('users').where({ id }).select('id', 'name', 'email', 'status', 'created_at').first();
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      error.status = 409;
      error.code = 'USER_EMAIL_EXISTS';
      error.message = 'Email sudah digunakan';
    }
    throw error;
  }
  await writeRequestAudit(req, { action: 'user.created', entityType: 'user', entityId: String(data.id) });
  res.status(201).json({ success: true, data });
}));
router.patch('/:id/status', requirePermission('users.manage'), asyncHandler(async (req, res) => {
  const status = z.enum(['active', 'inactive', 'locked']).parse(req.body.status);
  if (Number(req.params.id) === Number(req.session.user.id) && status !== 'active') {
    const error = new Error('Anda tidak dapat menonaktifkan akun sendiri'); error.status = 409; throw error;
  }
  const affected = await knex('users').where({ id: req.params.id }).whereNull('deleted_at').update({ status, updated_at: knex.fn.now(3) });
  if (!affected) { const error = new Error('User tidak ditemukan'); error.status = 404; throw error; }
  await writeRequestAudit(req, { action: 'user.status_changed', entityType: 'user', entityId: String(req.params.id), afterData: { status } });
  res.json({ success: true, data: { id: req.params.id, status } });
}));
router.patch('/:id/role', requirePermission('users.manage'), asyncHandler(async (req, res) => {
  const roleName = z.enum(['super_admin', 'operator', 'viewer']).parse(req.body.role);
  const data = await knex.transaction(async (trx) => {
    const user = await trx('users').where({ id: req.params.id }).whereNull('deleted_at').first();
    const role = await trx('roles').where({ name: roleName }).first();
    if (!user || !role) { const error = new Error('User atau role tidak ditemukan'); error.status = 404; throw error; }
    const currentRoles = await trx('user_roles').join('roles', 'roles.id', 'user_roles.role_id').where('user_roles.user_id', user.id).pluck('roles.name');
    if (currentRoles.includes('super_admin') && roleName !== 'super_admin') {
      const [{ count }] = await trx('user_roles').join('roles', 'roles.id', 'user_roles.role_id')
        .join('users', 'users.id', 'user_roles.user_id')
        .where('roles.name', 'super_admin').where('users.status', 'active').whereNull('users.deleted_at')
        .countDistinct({ count: 'users.id' });
      if (Number(count) <= 1) { const error = new Error('Super admin aktif terakhir tidak dapat diturunkan'); error.status = 409; throw error; }
    }
    await trx('user_roles').where({ user_id: user.id }).del();
    await trx('user_roles').insert({ user_id: user.id, role_id: role.id });
    return { id: user.id, role: roleName };
  });
  await writeRequestAudit(req, { action: 'user.role_changed', entityType: 'user', entityId: String(data.id), afterData: { role: data.role } });
  res.json({ success: true, data });
}));

const resetPasswordSchema = z.object({ password: passwordSchema });
router.patch('/:id/password', requirePermission('users.manage'), asyncHandler(async (req, res) => {
  const userId = z.coerce.number().int().positive().parse(req.params.id);
  const value = resetPasswordSchema.parse(req.body);
  const passwordHash = await bcrypt.hash(value.password, 12);
  const affected = await knex('users')
    .where({ id: userId })
    .whereNull('deleted_at')
    .update({
      password_hash: passwordHash,
      auth_version: knex.raw('auth_version + 1'),
      updated_at: knex.fn.now(3),
    });
  if (!affected) {
    const error = new Error('User tidak ditemukan');
    error.status = 404;
    throw error;
  }
  await writeRequestAudit(req, {
    action: 'user.password_reset',
    entityType: 'user',
    entityId: String(userId),
  });
  res.json({
    success: true,
    data: {
      id: userId,
      requires_reauthentication: Number(req.session?.user?.id || 0) === userId,
    },
  });
}));

module.exports = router;
