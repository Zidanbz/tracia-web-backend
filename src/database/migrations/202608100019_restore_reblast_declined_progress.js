function declinedCampaignContactIds(knex) {
  return knex('campaign_incoming_messages')
    .distinct('campaign_contact_id')
    .where({
      interaction_type: 'reblast_confirmation',
      reblast_decision: 'declined',
    })
    .whereNotNull('campaign_contact_id');
}

exports.up = async function up(knex) {
  const contactIds = declinedCampaignContactIds(knex);
  await knex('campaign_contact_progress')
    .whereIn('campaign_contact_id', contactIds.clone())
    .where({ status: 'stopped', current_session_number: 0 })
    .update({ status: 'not_started', updated_at: knex.fn.now(3) });
  await knex('campaign_contact_progress')
    .whereIn('campaign_contact_id', contactIds.clone())
    .where('status', 'stopped')
    .where('current_session_number', '>', 0)
    .update({ status: 'in_progress', updated_at: knex.fn.now(3) });
};

exports.down = async function down(knex) {
  await knex('campaign_contact_progress')
    .whereIn('campaign_contact_id', declinedCampaignContactIds(knex))
    .whereIn('status', ['not_started', 'in_progress'])
    .update({ status: 'stopped', updated_at: knex.fn.now(3) });
};
