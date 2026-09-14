const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_STORE = 'memory';

const app = require('../app');
const {
  parseFilters,
  calculateOverview,
} = require('../src/modules/campaign-monitoring/campaign-monitoring.service');

test('filter Monitoring Campaign menormalisasi input operasional', () => {
  assert.deepEqual(parseFilters({
    search: '  tracer  ',
    campaign_public_id: '',
    status: 'active',
    operator_user_id: '7',
    university_group_id: '1',
    faculty_group_id: '2',
    study_program_group_id: '3',
    page: '2',
    limit: '50',
    ignored: 'value',
  }), {
    search: 'tracer',
    campaign_public_id: undefined,
    status: 'active',
    operator_user_id: 7,
    university_group_id: 1,
    faculty_group_id: 2,
    study_program_group_id: 3,
    page: 2,
    limit: 50,
  });
  assert.throws(() => parseFilters({ status: 'unknown' }));
});

test('ringkasan Monitoring Campaign memisahkan response, completion, dan pekerjaan operasional', () => {
  const base = {
    operator_name: 'Operator', status: 'active', last_activity_at: '2026-09-02T01:00:00.000Z',
  };
  const result = calculateOverview([
    {
      ...base, public_id: 'one', title: 'Campaign One', attention_count: 5,
      metrics: {
        target: 10, responded: 4, not_started: 6, in_progress: 2, completed: 2,
        review_pending_details: 1, needs_review: 2, failed_messages: 1, stuck_jobs: 1, active_jobs: 2,
      },
    },
    {
      ...base, public_id: 'two', title: 'Campaign Two', status: 'paused', attention_count: 0,
      metrics: {
        target: 5, responded: 5, not_started: 0, in_progress: 0, completed: 5,
        review_pending_details: 0, needs_review: 0, failed_messages: 0, stuck_jobs: 0, active_jobs: 0,
      },
    },
  ]);
  assert.deepEqual(result.metrics, {
    campaign_count: 2,
    active_campaigns: 1,
    alumni_memberships: 15,
    responded: 9,
    not_started: 6,
    in_progress: 2,
    completed: 7,
    needs_attention: 3,
    failed_messages: 1,
    stuck_jobs: 1,
    active_jobs: 2,
    response_rate: 60,
    completion_rate: 46.7,
  });
  assert.equal(result.action_items.length, 1);
  assert.deepEqual(result.action_items[0], {
    campaign_public_id: 'one',
    campaign_title: 'Campaign One',
    operator_name: 'Operator',
    status: 'active',
    correction_count: 3,
    failed_message_count: 1,
    stuck_job_count: 1,
    total: 5,
  });
});

test('halaman Monitoring Campaign merender overview operasional dan menu terscope', async () => {
  const html = await new Promise((resolve, reject) => {
    app.render('campaign-monitoring/index', {
      title: 'Monitoring Campaign',
      csrfToken: 'test-token',
      currentUser: { id: 7, name: 'Operator' },
      currentPath: '/campaign-monitoring',
      roles: ['operator'],
      permissions: ['campaigns.view', 'campaigns.monitor'],
    }, (error, output) => (error ? reject(error) : resolve(output)));
  });
  assert.match(html, /id="campaign-monitoring-page"/);
  assert.match(html, /id="campaign-monitoring-filter"/);
  assert.match(html, /id="campaign-monitoring-export"/);
  assert.match(html, /id="campaign-monitoring-kpi-response-rate"/);
  assert.match(html, /id="campaign-monitoring-action-list"/);
  assert.match(html, /id="campaign-monitoring-campaign-body"/);
  assert.match(html, /href="\/campaign-monitoring"/);
  assert.match(html, /nav-item active/);
  assert.match(html, /assets\/css\/campaign-monitoring\.css/);
  assert.match(html, /assets\/js\/campaign-monitoring\.js/);

  const noPermission = await new Promise((resolve, reject) => {
    app.render('dashboard', {
      title: 'Dashboard', csrfToken: 'test-token', currentUser: { id: 8, name: 'Viewer' },
      currentPath: '/dashboard', roles: ['viewer'], permissions: ['dashboard.view'],
    }, (error, output) => (error ? reject(error) : resolve(output)));
  });
  assert.doesNotMatch(noPermission, /href="\/campaign-monitoring"/);
});
