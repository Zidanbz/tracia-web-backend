const express = require('express');
const { z } = require('zod');
const knex = require('../../database/knex');
const asyncHandler = require('../../shared/async-handler');
const { requirePermission } = require('../../middleware/auth');
const { writeRequestAudit } = require('../audit/audit.repository');
const { GROUP_CODE_PATTERN, buildPathKey, normalizeGroupCode } = require('./group-hierarchy');

const router = express.Router();
const codeSchema = z.string().trim().min(2).max(32)
  .transform(normalizeGroupCode)
  .refine((value) => GROUP_CODE_PATTERN.test(value), 'Kode hanya boleh berisi A-Z, 0-9, underscore, atau tanda hubung');
const createGroupSchema = z.object({
  type: z.enum(['university', 'faculty', 'study_program', 'custom']),
  code: codeSchema,
  name: z.string().trim().min(2).max(150),
  parent_id: z.coerce.number().int().positive().nullable().optional(),
  description: z.string().trim().max(255).nullable().optional(),
});
const updateGroupSchema = z.object({
  name: z.string().trim().min(2).max(150).optional(),
  description: z.string().trim().max(255).nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
}).refine((input) => Object.keys(input).length > 0, 'Minimal satu field harus diubah');

function notFound() {
  const error = new Error('Group kontak tidak ditemukan');
  error.status = 404;
  return error;
}

function conflict(message, code = 'CONTACT_GROUP_CONFLICT') {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  return error;
}

async function getGroup(id, database = knex) {
  return database('contact_groups').where({ id }).first();
}

router.get('/', requirePermission('contacts.view'), asyncHandler(async (req, res) => {
  const data = await knex('contact_groups as groups')
    .leftJoin('contact_groups as parent', 'parent.id', 'groups.parent_id')
    .select(
      'groups.id', 'groups.parent_id', 'groups.type', 'groups.code', 'groups.path_key',
      'groups.name', 'groups.description', 'groups.status', 'groups.created_at',
      'parent.code as parent_code', 'parent.name as parent_name',
      knex.raw('(SELECT COUNT(*) FROM contact_group_members AS members WHERE members.contact_group_id = groups.id) AS member_count'),
    )
    .orderByRaw("FIELD(groups.type, 'university', 'faculty', 'study_program', 'custom')")
    .orderBy('parent.name')
    .orderBy('groups.name');
  res.json({
    success: true,
    data: data.map((row) => ({ ...row, member_count: Number(row.member_count) })),
  });
}));

router.post('/', requirePermission('contacts.manage'), asyncHandler(async (req, res) => {
  const value = createGroupSchema.parse(req.body);
  let parent = null;
  if (value.type === 'university' && value.parent_id) {
    throw conflict('Universitas tidak boleh memiliki parent', 'INVALID_GROUP_HIERARCHY');
  }
  if (value.type === 'faculty') {
    if (!value.parent_id) throw conflict('Fakultas wajib berada di bawah universitas', 'INVALID_GROUP_HIERARCHY');
    parent = await getGroup(value.parent_id);
    if (!parent || parent.type !== 'university' || parent.status !== 'active') {
      throw conflict('Parent fakultas harus berupa universitas aktif', 'INVALID_GROUP_HIERARCHY');
    }
  } else if (value.type === 'study_program') {
    if (!value.parent_id) throw conflict('Program studi wajib berada di bawah fakultas', 'INVALID_GROUP_HIERARCHY');
    parent = await getGroup(value.parent_id);
    if (!parent || parent.type !== 'faculty' || parent.status !== 'active') {
      throw conflict('Parent program studi harus berupa fakultas aktif', 'INVALID_GROUP_HIERARCHY');
    }
    const university = await getGroup(parent.parent_id);
    if (!university || university.type !== 'university' || university.status !== 'active') {
      throw conflict('Universitas induk program studi harus aktif', 'INVALID_GROUP_HIERARCHY');
    }
  } else if (value.type === 'custom' && value.parent_id) {
    parent = await getGroup(value.parent_id);
    if (!parent || parent.status !== 'active') throw conflict('Parent group tidak ditemukan atau nonaktif');
  }
  const pathKey = buildPathKey({ type: value.type, code: value.code, parent });
  try {
    const [id] = await knex('contact_groups').insert({
      parent_id: parent?.id || null,
      type: value.type,
      code: value.code,
      path_key: pathKey,
      name: value.name,
      description: value.description || null,
      status: 'active',
    });
    await writeRequestAudit(req, {
      action: 'contact_group.created',
      entityType: 'contact_group',
      entityId: String(id),
      afterData: { type: value.type, code: value.code, parent_id: parent?.id || null },
    });
    res.status(201).json({ success: true, data: await getGroup(id) });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw conflict('Kode group sudah digunakan pada hierarki tersebut', 'GROUP_CODE_ALREADY_EXISTS');
    throw error;
  }
}));

router.patch('/:id', requirePermission('contacts.manage'), asyncHandler(async (req, res) => {
  const value = updateGroupSchema.parse(req.body);
  const group = await getGroup(req.params.id);
  if (!group) throw notFound();
  if (['faculty', 'study_program'].includes(group.type) && value.status === 'active') {
    const parent = await getGroup(group.parent_id);
    if (!parent || parent.status !== 'active') {
      throw conflict('Aktifkan group induk sebelum mengaktifkan child', 'PARENT_GROUP_INACTIVE');
    }
  }
  await knex.transaction(async (trx) => {
    await trx('contact_groups').where({ id: group.id }).update({ ...value, updated_at: trx.fn.now(3) });
    if (group.type === 'university' && value.status === 'inactive') {
      const facultyIds = await trx('contact_groups').where({ parent_id: group.id }).pluck('id');
      await trx('contact_groups').whereIn('parent_id', facultyIds).update({ status: 'inactive', updated_at: trx.fn.now(3) });
      await trx('contact_groups').where({ parent_id: group.id }).update({ status: 'inactive', updated_at: trx.fn.now(3) });
    }
    if (group.type === 'faculty' && value.status === 'inactive') {
      await trx('contact_groups').where({ parent_id: group.id }).update({ status: 'inactive', updated_at: trx.fn.now(3) });
    }
  });
  await writeRequestAudit(req, {
    action: 'contact_group.updated',
    entityType: 'contact_group',
    entityId: String(group.id),
    afterData: { fields: Object.keys(value) },
  });
  res.json({ success: true, data: await getGroup(group.id) });
}));

router.delete('/:id', requirePermission('contacts.manage'), asyncHandler(async (req, res) => {
  const group = await getGroup(req.params.id);
  if (!group) throw notFound();
  const [{ child_count: childCount }] = await knex('contact_groups').where({ parent_id: group.id }).count({ child_count: '*' });
  const [{ member_count: memberCount }] = await knex('contact_group_members').where({ contact_group_id: group.id }).count({ member_count: '*' });
  const campaignReference = await knex('campaigns')
    .where((builder) => builder.where({ university_group_id: group.id })
      .orWhere({ faculty_group_id: group.id })
      .orWhere({ study_program_group_id: group.id }))
    .first('id');
  if (Number(childCount) || Number(memberCount) || campaignReference) {
    throw conflict('Group yang memiliki child atau member tidak dapat dihapus; nonaktifkan group sebagai gantinya', 'GROUP_IN_USE');
  }
  await knex('contact_groups').where({ id: group.id }).del();
  await writeRequestAudit(req, { action: 'contact_group.deleted', entityType: 'contact_group', entityId: String(group.id) });
  res.status(204).end();
}));

router.post('/:id/members', requirePermission('contacts.manage'), asyncHandler(async (req, res) => {
  const contactIds = z.array(z.coerce.number().int().positive()).min(1).max(10000).parse(req.body.contact_ids);
  const group = await getGroup(req.params.id);
  if (!group) throw notFound();
  if (group.status !== 'active') throw conflict('Member tidak dapat ditambahkan ke group nonaktif', 'GROUP_INACTIVE');
  const validIds = await knex('contacts').whereIn('id', contactIds).whereNull('deleted_at').pluck('id');
  if (validIds.length !== new Set(contactIds.map(Number)).size) {
    const error = new Error('Satu atau lebih kontak tidak ditemukan'); error.status = 422; throw error;
  }
  await knex('contact_group_members').insert(validIds.map((contactId) => ({
    contact_group_id: group.id, contact_id: contactId,
  }))).onConflict(['contact_group_id', 'contact_id']).ignore();
  await writeRequestAudit(req, { action: 'contact_group.members_added', entityType: 'contact_group', entityId: String(group.id), afterData: { count: validIds.length } });
  res.json({ success: true, data: { group_id: group.id, added: validIds.length } });
}));

router.delete('/:id/members/:contactId', requirePermission('contacts.manage'), asyncHandler(async (req, res) => {
  const affected = await knex('contact_group_members').where({
    contact_group_id: req.params.id, contact_id: req.params.contactId,
  }).del();
  if (!affected) { const error = new Error('Member group tidak ditemukan'); error.status = 404; throw error; }
  await writeRequestAudit(req, { action: 'contact_group.member_removed', entityType: 'contact_group', entityId: String(req.params.id) });
  res.status(204).end();
}));

module.exports = router;
