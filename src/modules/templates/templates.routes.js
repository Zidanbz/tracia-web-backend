const express = require('express');
const { z } = require('zod');
const knex = require('../../database/knex');
const asyncHandler = require('../../shared/async-handler');
const { requirePermission } = require('../../middleware/auth');
const { writeRequestAudit } = require('../audit/audit.repository');

const router = express.Router();
const schema = z.object({
  name: z.string().trim().min(2).max(150),
  body: z.string().trim().min(1).max(10000),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
});
const updateSchema = z.object({
  name: z.string().trim().min(2).max(150).optional(),
  body: z.string().trim().min(1).max(10000).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
}).refine((input) => Object.keys(input).length > 0, 'Minimal satu field harus diubah');

function variablesFromBody(body) {
  return [...new Set([...body.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)].map((match) => match[1]))];
}

function notFound() {
  const error = new Error('Template tidak ditemukan');
  error.status = 404;
  return error;
}

function renderBody(body, input) {
  const variables = variablesFromBody(body);
  const missing = variables.filter((key) => input[key] === undefined || input[key] === null);
  if (missing.length) {
    const error = new Error(`Variabel belum diisi: ${missing.join(', ')}`);
    error.status = 422;
    error.code = 'MISSING_TEMPLATE_VARIABLES';
    throw error;
  }
  return body.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => String(input[key]));
}

router.get('/', requirePermission('templates.view'), asyncHandler(async (req, res) => {
  const data = await knex('message_templates').select('*').orderBy('id', 'desc');
  res.json({ success: true, data });
}));
router.get('/:id', requirePermission('templates.view'), asyncHandler(async (req, res) => {
  const data = await knex('message_templates').where({ id: req.params.id }).first();
  if (!data) throw notFound();
  res.json({ success: true, data });
}));
router.post('/', requirePermission('templates.manage'), asyncHandler(async (req, res) => {
  const value = schema.parse(req.body);
  const [id] = await knex('message_templates').insert({
    ...value,
    variables: JSON.stringify(variablesFromBody(value.body)),
    created_by: req.session.user.id,
    updated_by: req.session.user.id,
  });
  const data = await knex('message_templates').where({ id }).first();
  await writeRequestAudit(req, { action: 'template.created', entityType: 'message_template', entityId: String(id) });
  res.status(201).json({ success: true, data });
}));
router.patch('/:id', requirePermission('templates.manage'), asyncHandler(async (req, res) => {
  const value = updateSchema.parse(req.body);
  const updates = { ...value, updated_by: req.session.user.id, updated_at: knex.fn.now(3) };
  if (value.body) updates.variables = JSON.stringify(variablesFromBody(value.body));
  const affected = await knex('message_templates').where({ id: req.params.id }).update(updates);
  if (!affected) {
    const error = new Error('Template tidak ditemukan'); error.status = 404; throw error;
  }
  await writeRequestAudit(req, { action: 'template.updated', entityType: 'message_template', entityId: String(req.params.id) });
  res.json({ success: true, data: await knex('message_templates').where({ id: req.params.id }).first() });
}));
router.post('/:id/preview', requirePermission('templates.view'), asyncHandler(async (req, res) => {
  const template = await knex('message_templates').where({ id: req.params.id }).first();
  if (!template) throw notFound();
  const values = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).parse(req.body.variables || {});
  res.json({ success: true, data: { body: renderBody(template.body, values), variables: variablesFromBody(template.body) } });
}));
router.delete('/:id', requirePermission('templates.manage'), asyncHandler(async (req, res) => {
  const affected = await knex('message_templates').where({ id: req.params.id }).update({
    status: 'archived', updated_by: req.session.user.id, updated_at: knex.fn.now(3),
  });
  if (!affected) throw notFound();
  await writeRequestAudit(req, { action: 'template.archived', entityType: 'message_template', entityId: String(req.params.id) });
  res.status(204).end();
}));

module.exports = router;
