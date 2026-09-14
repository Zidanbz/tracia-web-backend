const permissions = [
  'dashboard.view',
  'whatsapp.view', 'whatsapp.manage',
  'messages.view', 'messages.send', 'messages.retry',
  'broadcasts.view', 'broadcasts.manage',
  'contacts.view', 'contacts.manage',
  'templates.view', 'templates.manage',
  'queue.view', 'queue.manage',
  'integrations.view', 'integrations.manage',
  'users.view', 'users.manage',
  'reports.view', 'reports.export',
  'settings.view', 'settings.manage',
  'audit.view',
  'inbox.view', 'inbox.manage',
  'qa_session.view', 'qa_session.manage',
  'campaigns.view', 'campaigns.manage', 'campaigns.operate',
  'campaigns.monitor', 'campaigns.attribute_replies',
];

const roleDefinitions = {
  super_admin: permissions,
  operator: [
    'dashboard.view', 'whatsapp.view',
    'messages.view', 'messages.send', 'messages.retry',
    'broadcasts.view', 'broadcasts.manage',
    'contacts.view', 'contacts.manage',
    'templates.view', 'templates.manage',
    'queue.view', 'reports.view',
    'inbox.view', 'inbox.manage',
    'qa_session.view', 'qa_session.manage',
    'campaigns.view', 'campaigns.operate', 'campaigns.monitor',
  ],
  viewer: [
    'dashboard.view', 'whatsapp.view', 'messages.view',
    'broadcasts.view', 'contacts.view', 'templates.view',
    'queue.view', 'reports.view',
    'inbox.view', 'qa_session.view',
  ],
};

exports.seed = async function seed(knex) {
  await knex('permissions')
    .insert(permissions.map((code) => ({ code, description: code })))
    .onConflict('code')
    .ignore();

  await knex('roles')
    .insert(Object.keys(roleDefinitions).map((name) => ({ name, description: name })))
    .onConflict('name')
    .ignore();

  const roleRows = await knex('roles').select('id', 'name');
  const permissionRows = await knex('permissions').select('id', 'code');
  const roleIds = new Map(roleRows.map((role) => [role.name, role.id]));
  const permissionIds = new Map(permissionRows.map((permission) => [permission.code, permission.id]));
  const links = Object.entries(roleDefinitions).flatMap(([roleName, codes]) =>
    codes.map((code) => ({ role_id: roleIds.get(roleName), permission_id: permissionIds.get(code) })),
  );

  await knex('role_permissions')
    .insert(links)
    .onConflict(['role_id', 'permission_id'])
    .ignore();
};
