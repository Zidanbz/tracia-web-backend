const CRITICAL_TABLES = Object.freeze([
  'roles',
  'permissions',
  'users',
  'role_permissions',
  'user_roles',
  'sessions',
  'login_attempts',
  'password_reset_tokens',
  'audit_logs',
  'whatsapp_accounts',
  'whatsapp_connection_events',
  'contacts',
  'contact_groups',
  'contact_group_members',
  'contact_imports',
  'contact_import_rows',
  'contact_academic_profiles',
  'media_assets',
  'message_templates',
  'broadcasts',
  'broadcast_recipients',
  'messages',
  'message_events',
  'message_jobs',
  'incoming_messages',
  'api_keys',
  'webhooks',
  'webhook_deliveries',
  'api_request_logs',
  'qa_session_questions',
  'campaigns',
  'campaign_contacts',
  'campaign_contact_progress',
  'campaign_questionnaires',
  'campaign_questions',
  'campaign_question_options',
  'campaign_incoming_messages',
  'application_settings',
]);

const STATUS_COLUMNS = Object.freeze({
  users: ['status'],
  whatsapp_accounts: ['status'],
  contacts: ['status', 'consent_status', 'wa_registration_status'],
  contact_imports: ['status', 'verification_status'],
  contact_import_rows: ['status', 'wa_registration_status'],
  message_templates: ['status'],
  broadcasts: ['status'],
  broadcast_recipients: ['status'],
  messages: ['status'],
  message_jobs: ['status'],
  campaigns: ['status'],
  campaign_contacts: ['status'],
  campaign_contact_progress: ['status'],
  api_keys: ['status'],
  webhooks: ['status'],
});

const ORPHAN_CHECKS = Object.freeze([
  ['role_permission.role', 'role_permissions', 'role_id', 'roles', 'id'],
  ['role_permission.permission', 'role_permissions', 'permission_id', 'permissions', 'id'],
  ['user_role.user', 'user_roles', 'user_id', 'users', 'id'],
  ['user_role.role', 'user_roles', 'role_id', 'roles', 'id'],
  ['password_reset.user', 'password_reset_tokens', 'user_id', 'users', 'id'],
  ['contact_group_member.group', 'contact_group_members', 'contact_group_id', 'contact_groups', 'id'],
  ['contact_group_member.contact', 'contact_group_members', 'contact_id', 'contacts', 'id'],
  ['contact_import_row.import', 'contact_import_rows', 'contact_import_id', 'contact_imports', 'id'],
  ['campaign_contacts.campaign', 'campaign_contacts', 'campaign_id', 'campaigns', 'id'],
  ['campaign_contacts.contact', 'campaign_contacts', 'contact_id', 'contacts', 'id'],
  ['campaign_progress.membership', 'campaign_contact_progress', 'campaign_contact_id', 'campaign_contacts', 'id'],
  ['campaign_questionnaire.campaign', 'campaign_questionnaires', 'campaign_id', 'campaigns', 'id'],
  ['campaign_question.campaign', 'campaign_questions', 'campaign_id', 'campaigns', 'id'],
  ['campaign_question.questionnaire', 'campaign_questions', 'questionnaire_id', 'campaign_questionnaires', 'id'],
  ['campaign_option.question', 'campaign_question_options', 'campaign_question_id', 'campaign_questions', 'id'],
  ['message.broadcast', 'messages', 'broadcast_id', 'broadcasts', 'id'],
  ['message.contact', 'messages', 'contact_id', 'contacts', 'id'],
  ['message.account', 'messages', 'whatsapp_account_id', 'whatsapp_accounts', 'id'],
  ['message.campaign', 'messages', 'campaign_id', 'campaigns', 'id'],
  ['message_job.message', 'message_jobs', 'message_id', 'messages', 'id'],
  ['message_event.message', 'message_events', 'message_id', 'messages', 'id'],
  ['broadcast_recipient.broadcast', 'broadcast_recipients', 'broadcast_id', 'broadcasts', 'id'],
  ['broadcast_recipient.message', 'broadcast_recipients', 'message_id', 'messages', 'id'],
  ['broadcast_recipient.contact', 'broadcast_recipients', 'contact_id', 'contacts', 'id'],
  ['campaign_incoming.incoming', 'campaign_incoming_messages', 'incoming_message_id', 'incoming_messages', 'id'],
  ['campaign_incoming.campaign', 'campaign_incoming_messages', 'campaign_id', 'campaigns', 'id'],
  ['campaign_incoming.membership', 'campaign_incoming_messages', 'campaign_contact_id', 'campaign_contacts', 'id'],
  ['academic_profile.contact', 'contact_academic_profiles', 'contact_id', 'contacts', 'id'],
  ['academic_profile.university', 'contact_academic_profiles', 'university_group_id', 'contact_groups', 'id'],
  ['webhook_delivery.webhook', 'webhook_deliveries', 'webhook_id', 'webhooks', 'id'],
  ['api_request.api_key', 'api_request_logs', 'api_key_id', 'api_keys', 'id'],
]);

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusTotal(snapshot, table, statuses, column = 'status') {
  const distribution = snapshot.status_counts?.[table]?.[column] || {};
  return statuses.reduce((total, status) => total + numeric(distribution[status]), 0);
}

function normalizedDistribution(distribution = {}) {
  return Object.fromEntries(
    Object.entries(distribution)
      .map(([status, count]) => [status, numeric(count)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function distributionsMatch(left, right) {
  return JSON.stringify(normalizedDistribution(left)) === JSON.stringify(normalizedDistribution(right));
}

function assessSourceReadiness(snapshot, pendingMigrations = [], options = {}) {
  const writesFrozen = options.writesFrozen === true;
  const blockers = [];
  const warnings = [];
  const queueWaiting = statusTotal(snapshot, 'message_jobs', ['pending']);
  const queueReserved = statusTotal(snapshot, 'message_jobs', ['reserved']);
  const queueProcessing = statusTotal(snapshot, 'message_jobs', ['processing']);
  const verificationPending = numeric(snapshot.operational?.contact_verification_claimable_pending);
  const verificationChecking = numeric(snapshot.operational?.contact_verification_checking);
  const verificationWaiting = verificationPending + verificationChecking;
  const historicalVerificationPending = Math.max(
    0,
    statusTotal(snapshot, 'contact_import_rows', ['pending'], 'wa_registration_status')
      - verificationPending,
  );
  const activeBroadcasts = statusTotal(snapshot, 'broadcasts', ['scheduled', 'running']);
  const activeCampaigns = statusTotal(snapshot, 'campaigns', ['active']);
  const unfinishedProgress = statusTotal(
    snapshot,
    'campaign_contact_progress',
    ['not_started', 'in_progress', 'review_pending_details', 'needs_review'],
  );

  if (snapshot.missing_tables.length) {
    blockers.push({ code: 'SOURCE_SCHEMA_INCOMPLETE', tables: snapshot.missing_tables });
  }
  if (pendingMigrations.length) {
    blockers.push({ code: 'SOURCE_MIGRATIONS_PENDING', count: pendingMigrations.length });
  }
  if (queueReserved || queueProcessing) {
    blockers.push({
      code: 'OUTBOUND_IN_FLIGHT',
      count: queueReserved + queueProcessing,
      reserved: queueReserved,
      processing: queueProcessing,
    });
  }
  if (queueWaiting) blockers.push({ code: 'OUTBOUND_QUEUE_PENDING', count: queueWaiting });
  if (verificationWaiting) blockers.push({ code: 'CONTACT_VERIFICATION_IN_FLIGHT', count: verificationWaiting });
  if (activeBroadcasts) blockers.push({ code: 'BROADCAST_DELIVERY_ACTIVE', count: activeBroadcasts });
  if (activeCampaigns || unfinishedProgress) {
    warnings.push({
      code: 'CAMPAIGN_STATE_MUST_BE_MIGRATED',
      active_campaigns: activeCampaigns,
      unfinished_progress: unfinishedProgress,
    });
  }
  if (historicalVerificationPending) {
    warnings.push({
      code: 'HISTORICAL_CONTACT_VERIFICATION_PENDING',
      count: historicalVerificationPending,
    });
  }

  const integrityFailures = Object.entries(snapshot.integrity || {})
    .filter(([, count]) => numeric(count) > 0)
    .map(([check, count]) => ({ check, count: numeric(count) }));
  if (integrityFailures.length) {
    blockers.push({ code: 'SOURCE_REFERENTIAL_INTEGRITY_FAILED', checks: integrityFailures });
  }

  const readyForMaintenanceWindow = blockers.length === 0;
  if (!writesFrozen) {
    blockers.push({ code: 'WRITE_FREEZE_NOT_CONFIRMED' });
  }

  return {
    ready_for_maintenance_window: readyForMaintenanceWindow,
    ready_for_final_copy: blockers.length === 0,
    blockers,
    warnings,
    observed: {
      queue_pending: queueWaiting,
      queue_reserved: queueReserved,
      queue_processing: queueProcessing,
      contact_verification_in_flight: verificationWaiting,
      contact_verification_claimable_pending: verificationPending,
      contact_verification_checking: verificationChecking,
      historical_contact_verification_pending: historicalVerificationPending,
      active_broadcasts: activeBroadcasts,
      active_campaigns: activeCampaigns,
      unfinished_campaign_progress: unfinishedProgress,
    },
  };
}

async function collectOperationalMetrics(database, metadata) {
  const metrics = {};
  if (metadata.contact_imports && metadata.contact_import_rows) {
    const claimable = await database('contact_import_rows as import_row')
      .join('contact_imports as import_batch', 'import_batch.id', 'import_row.contact_import_id')
      .where({
        'import_row.status': 'valid',
        'import_row.wa_registration_status': 'pending',
        'import_batch.status': 'previewed',
      })
      .where((builder) => builder
        .whereNull('import_batch.campaign_id')
        .orWhereRaw(`import_batch.id = (
          SELECT MAX(latest_import.id)
          FROM contact_imports AS latest_import
          WHERE latest_import.campaign_id = import_batch.campaign_id
        )`))
      .count({ count: '*' })
      .first();
    const checking = await database('contact_import_rows')
      .where({ wa_registration_status: 'checking' })
      .count({ count: '*' })
      .first();
    metrics.contact_verification_claimable_pending = numeric(claimable?.count);
    metrics.contact_verification_checking = numeric(checking?.count);
  }
  return metrics;
}

async function tableMetadata(database, table) {
  if (!await database.schema.hasTable(table)) return null;
  return database(table).columnInfo();
}

async function countRows(database, table) {
  const result = await database(table).count({ count: '*' }).first();
  return numeric(result?.count);
}

async function statusDistribution(database, table, column) {
  const rows = await database(table)
    .select(column)
    .count({ count: '*' })
    .groupBy(column)
    .orderBy(column);
  return Object.fromEntries(rows.map((row) => [String(row[column] ?? 'null'), numeric(row.count)]));
}

async function orphanCount(database, check, metadata) {
  const [name, childTable, childColumn, parentTable, parentColumn] = check;
  if (!metadata[childTable] || !metadata[parentTable]) return [name, null];
  if (!metadata[childTable][childColumn] || !metadata[parentTable][parentColumn]) return [name, null];
  const childAlias = 'child_row';
  const parentAlias = 'parent_row';
  const result = await database(`${childTable} as ${childAlias}`)
    .leftJoin(
      `${parentTable} as ${parentAlias}`,
      `${parentAlias}.${parentColumn}`,
      `${childAlias}.${childColumn}`,
    )
    .whereNotNull(`${childAlias}.${childColumn}`)
    .whereNull(`${parentAlias}.${parentColumn}`)
    .count({ count: '*' })
    .first();
  return [name, numeric(result?.count)];
}

async function collectDatabaseSnapshot(database, label) {
  const metadata = {};
  const tableCounts = {};
  const statusCounts = {};
  const missingTables = [];

  for (const table of CRITICAL_TABLES) {
    metadata[table] = await tableMetadata(database, table);
    if (!metadata[table]) {
      missingTables.push(table);
      continue;
    }
    tableCounts[table] = await countRows(database, table);
    const columns = STATUS_COLUMNS[table] || [];
    for (const column of columns) {
      if (!metadata[table][column]) continue;
      statusCounts[table] ||= {};
      statusCounts[table][column] = await statusDistribution(database, table, column);
    }
  }

  const integrity = {};
  for (const check of ORPHAN_CHECKS) {
    const [name, count] = await orphanCount(database, check, metadata);
    if (count !== null) integrity[name] = count;
  }

  const operational = await collectOperationalMetrics(database, metadata);

  return {
    label,
    generated_at: new Date().toISOString(),
    missing_tables: missingTables,
    table_counts: tableCounts,
    status_counts: statusCounts,
    integrity,
    operational,
  };
}

function compareSnapshots(source, target) {
  const differences = [];
  for (const table of CRITICAL_TABLES) {
    const sourceMissing = source.missing_tables.includes(table);
    const targetMissing = target.missing_tables.includes(table);
    if (sourceMissing || targetMissing) {
      differences.push({
        type: 'table_missing',
        table,
        source_missing: sourceMissing,
        target_missing: targetMissing,
      });
      continue;
    }
    if (numeric(source.table_counts[table]) !== numeric(target.table_counts[table])) {
      differences.push({
        type: 'row_count',
        table,
        source: numeric(source.table_counts[table]),
        target: numeric(target.table_counts[table]),
      });
    }
    const columns = STATUS_COLUMNS[table] || [];
    for (const column of columns) {
      const sourceDistribution = source.status_counts?.[table]?.[column];
      const targetDistribution = target.status_counts?.[table]?.[column];
      if (!sourceDistribution && !targetDistribution) continue;
      if (!distributionsMatch(sourceDistribution, targetDistribution)) {
        differences.push({
          type: 'status_distribution',
          table,
          column,
          source: sourceDistribution || {},
          target: targetDistribution || {},
        });
      }
    }
  }

  const targetIntegrityFailures = Object.entries(target.integrity || {})
    .filter(([, count]) => numeric(count) > 0)
    .map(([check, count]) => ({ check, count: numeric(count) }));
  if (targetIntegrityFailures.length) {
    differences.push({ type: 'target_referential_integrity', checks: targetIntegrityFailures });
  }

  return {
    matches: differences.length === 0,
    differences,
  };
}

module.exports = {
  CRITICAL_TABLES,
  STATUS_COLUMNS,
  assessSourceReadiness,
  collectDatabaseSnapshot,
  compareSnapshots,
  distributionsMatch,
  normalizedDistribution,
};
