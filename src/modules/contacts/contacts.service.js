const { z } = require('zod');
const knex = require('../../database/knex');
const { normalizePhone } = require('../../shared/phone');
const env = require('../../config/env');
const { resolveSelectedGrouping } = require('../contact-groups/group-hierarchy');

const optionalGroupId = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? null : value),
  z.coerce.number().int().positive().nullable(),
);

const createSchema = z.object({
  name: z.string().trim().min(2).max(150),
  phone: z.union([z.string(), z.number()]),
  university_group_id: z.coerce.number().int().positive(),
  faculty_group_id: optionalGroupId.optional(),
  consent_status: z.enum(['unknown', 'granted', 'revoked']).default('unknown'),
  consent_source: z.string().trim().max(100).nullable().optional(),
  custom_fields: z.record(z.string(), z.unknown()).optional(),
}).superRefine((value, context) => {
  if (value.consent_status === 'granted' && !value.consent_source) {
    context.addIssue({ code: 'custom', path: ['consent_source'], message: 'Sumber consent wajib diisi ketika consent diberikan' });
  }
});

const updateSchema = z.object({
  name: z.string().trim().min(2).max(150).optional(),
  status: z.enum(['active', 'invalid', 'blocked', 'opted_out']).optional(),
  consent_status: z.enum(['unknown', 'granted', 'revoked']).optional(),
  consent_source: z.string().trim().max(100).nullable().optional(),
  custom_fields: z.record(z.string(), z.unknown()).optional(),
  university_group_id: z.coerce.number().int().positive().optional(),
  faculty_group_id: optionalGroupId.optional(),
}).refine((value) => Object.keys(value).length > 0, 'Minimal satu field harus diubah')
  .superRefine((value, context) => {
    if (value.consent_status === 'granted' && !value.consent_source) {
      context.addIssue({ code: 'custom', path: ['consent_source'], message: 'Sumber consent wajib diisi ketika consent diberikan' });
    }
    if (Object.hasOwn(value, 'faculty_group_id') && !Object.hasOwn(value, 'university_group_id')) {
      context.addIssue({ code: 'custom', path: ['university_group_id'], message: 'Universitas wajib dikirim saat mengubah fakultas' });
    }
  });

function invalidGrouping(message, code) {
  const error = new Error(message);
  error.status = 422;
  error.code = code;
  return error;
}

async function validateGrouping({ universityGroupId, facultyGroupId }, database) {
  const groupIds = [universityGroupId, facultyGroupId].filter(Boolean);
  const groups = await database('contact_groups')
    .whereIn('id', groupIds)
    .select('id', 'parent_id', 'type', 'code', 'name', 'status', 'path_key')
    .forUpdate();
  const grouping = resolveSelectedGrouping({
    universityId: universityGroupId,
    facultyId: facultyGroupId,
  }, groups);
  if (grouping.valid) return grouping;
  const errors = {
    UNIVERSITY_REQUIRED: ['Universitas wajib dipilih', 'UNIVERSITY_REQUIRED'],
    UNIVERSITY_NOT_FOUND_OR_INACTIVE: ['Universitas tidak ditemukan atau sudah nonaktif', 'UNIVERSITY_NOT_FOUND_OR_INACTIVE'],
    FACULTY_NOT_FOUND_OR_INACTIVE: ['Fakultas tidak ditemukan atau sudah nonaktif', 'FACULTY_NOT_FOUND_OR_INACTIVE'],
    FACULTY_UNIVERSITY_MISMATCH: ['Fakultas yang dipilih bukan bagian dari universitas tersebut', 'FACULTY_UNIVERSITY_MISMATCH'],
  };
  const [message, code] = errors[grouping.errorCode] || ['Pilihan pengelompokan tidak valid', 'INVALID_CONTACT_GROUPING'];
  throw invalidGrouping(message, code);
}

async function replaceHierarchyMembership(database, contactId, grouping) {
  const hierarchyGroupIds = await database('contact_groups')
    .whereIn('type', ['university', 'faculty'])
    .pluck('id');
  if (hierarchyGroupIds.length) {
    await database('contact_group_members')
      .where({ contact_id: contactId })
      .whereIn('contact_group_id', hierarchyGroupIds)
      .del();
  }
  await database('contact_group_members').insert({
    contact_group_id: grouping.faculty?.id || grouping.university.id,
    contact_id: contactId,
  });
}

async function list({ page = 1, limit = 25, search = '', status, university_id: universityId, faculty_id: facultyId }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const base = knex('contacts').whereNull('deleted_at');
  if (status) base.where('status', status);
  if (search) base.where((builder) => builder.whereLike('name', `%${search}%`).orWhereLike('phone_e164', `%${search}%`));
  const safeUniversityId = Number(universityId) > 0 ? Number(universityId) : null;
  const safeFacultyId = Number(facultyId) > 0 ? Number(facultyId) : null;
  if (safeFacultyId) {
    base.whereExists(knex('contact_group_members as filter_members')
      .join('contact_groups as filter_faculty', 'filter_faculty.id', 'filter_members.contact_group_id')
      .select(knex.raw('1'))
      .whereRaw('filter_members.contact_id = contacts.id')
      .where({
        'filter_members.contact_group_id': safeFacultyId,
        'filter_faculty.type': 'faculty',
        'filter_faculty.status': 'active',
      }));
    if (safeUniversityId) {
      base.whereExists(knex('contact_groups as selected_faculty')
        .select(knex.raw('1'))
        .where({
          'selected_faculty.id': safeFacultyId,
          'selected_faculty.parent_id': safeUniversityId,
          'selected_faculty.type': 'faculty',
          'selected_faculty.status': 'active',
        }));
    }
  } else if (safeUniversityId) {
    base.whereExists(knex('contact_group_members as filter_members')
      .join('contact_groups as filter_groups', 'filter_groups.id', 'filter_members.contact_group_id')
      .select(knex.raw('1'))
      .whereRaw('filter_members.contact_id = contacts.id')
      .where('filter_groups.status', 'active')
      .where((builder) => builder
        .where('filter_groups.id', safeUniversityId)
        .orWhere('filter_groups.parent_id', safeUniversityId)));
  }
  const [{ total }] = await base.clone().count({ total: '*' });
  const data = await base
    .select(
      'id', 'name', 'phone_e164', 'status', 'wa_registration_status',
      'wa_registration_checked_at', 'consent_status', 'consent_source', 'created_at',
    )
    .orderBy('id', 'desc')
    .limit(safeLimit)
    .offset((safePage - 1) * safeLimit);
  const contactIds = data.map((contact) => contact.id);
  const affiliations = contactIds.length ? await knex('contact_group_members as members')
    .join('contact_groups as groups', 'groups.id', 'members.contact_group_id')
    .leftJoin('contact_groups as parent', 'parent.id', 'groups.parent_id')
    .whereIn('members.contact_id', contactIds)
    .select(
      'members.contact_id', 'groups.id as group_id', 'groups.type as group_type',
      'groups.code as group_code', 'groups.name as group_name',
      'parent.id as parent_id', 'parent.code as parent_code', 'parent.name as parent_name',
    )
    .orderBy('groups.path_key') : [];
  const affiliationsByContact = new Map(contactIds.map((id) => [Number(id), []]));
  affiliations.forEach((row) => {
    affiliationsByContact.get(Number(row.contact_id))?.push({
      group_id: row.group_id,
      group_type: row.group_type,
      university_id: row.group_type === 'faculty' ? row.parent_id : (row.group_type === 'university' ? row.group_id : null),
      university_code: row.group_type === 'faculty' ? row.parent_code : (row.group_type === 'university' ? row.group_code : null),
      university_name: row.group_type === 'faculty' ? row.parent_name : (row.group_type === 'university' ? row.group_name : null),
      faculty_id: row.group_type === 'faculty' ? row.group_id : null,
      faculty_code: row.group_type === 'faculty' ? row.group_code : null,
      faculty_name: row.group_type === 'faculty' ? row.group_name : null,
      custom_name: row.group_type === 'custom' ? row.group_name : null,
    });
  });
  data.forEach((contact) => {
    contact.affiliations = affiliationsByContact.get(Number(contact.id)) || [];
  });
  return { data, meta: { page: safePage, limit: safeLimit, total: Number(total) } };
}

async function create(input) {
  const value = createSchema.parse(input);
  const phone = normalizePhone(value.phone);
  try {
    return await knex.transaction(async (trx) => {
      const grouping = await validateGrouping({
        universityGroupId: value.university_group_id,
        facultyGroupId: value.faculty_group_id,
      }, trx);
      const [id] = await trx('contacts').insert({
        name: value.name,
        phone_e164: phone,
        country_code: env.defaultCountryCode,
        consent_status: value.consent_status,
        consent_source: value.consent_source || null,
        consent_at: value.consent_status === 'granted' ? trx.fn.now(3) : null,
        custom_fields: value.custom_fields ? JSON.stringify(value.custom_fields) : null,
      });
      await replaceHierarchyMembership(trx, id, grouping);
      return trx('contacts').where({ id }).first();
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      error.status = 409;
      error.code = 'CONTACT_ALREADY_EXISTS';
      error.message = 'Nomor WhatsApp sudah terdaftar';
    }
    throw error;
  }
}

async function update(id, input) {
  const value = updateSchema.parse(input);
  const groupingRequested = Object.hasOwn(value, 'university_group_id');
  const {
    university_group_id: universityGroupId,
    faculty_group_id: facultyGroupId,
    ...contactFields
  } = value;
  return knex.transaction(async (trx) => {
    const contact = await trx('contacts').where({ id }).whereNull('deleted_at').forUpdate().first();
    if (!contact) throw notFound();
    const grouping = groupingRequested
      ? await validateGrouping({ universityGroupId, facultyGroupId }, trx)
      : null;
    const updates = { ...contactFields, updated_at: trx.fn.now(3) };
    if (contactFields.custom_fields) updates.custom_fields = JSON.stringify(contactFields.custom_fields);
    if (contactFields.status === 'opted_out') {
      updates.opted_out_at = trx.fn.now(3);
      updates.consent_status = 'revoked';
    }
    if (contactFields.consent_status === 'granted') updates.consent_at = trx.fn.now(3);
    await trx('contacts').where({ id }).update(updates);
    if (grouping) await replaceHierarchyMembership(trx, id, grouping);
    return trx('contacts').where({ id }).first();
  });
}

async function remove(id, database = knex) {
  const affected = await database('contacts').where({ id }).whereNull('deleted_at').del();
  if (!affected) throw notFound();
}

function notFound() {
  const error = new Error('Kontak tidak ditemukan');
  error.status = 404;
  error.code = 'CONTACT_NOT_FOUND';
  return error;
}

module.exports = { list, create, update, remove };
