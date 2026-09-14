const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_STORE = 'memory';

const app = require('../app');
const {
  parseFilters,
  assertAcademicHierarchy,
  buildTrendSeries,
} = require('../src/modules/campus-dashboard/campus-dashboard.service');

const groups = [
  { id: 1, parent_id: null, type: 'university' },
  { id: 2, parent_id: 1, type: 'faculty' },
  { id: 3, parent_id: 2, type: 'study_program' },
  { id: 4, parent_id: 1, type: 'faculty' },
];

test('filter Dashboard Kampus menormalisasi id dan menolak parameter asing', () => {
  assert.deepEqual(parseFilters({
    campaign_public_id: '',
    university_group_id: '1',
    faculty_group_id: '2',
    study_program_group_id: '3',
    ignored: 'value',
  }), {
    campaign_public_id: undefined,
    university_group_id: 1,
    faculty_group_id: 2,
    study_program_group_id: 3,
    trend_days: 30,
  });
});

test('tren Dashboard Kampus mengisi tanggal tanpa jawaban dengan nilai nol', () => {
  assert.deepEqual(buildTrendSeries([
    { report_date: '2026-08-16', answer_count: 4, respondent_count: 2 },
    { report_date: '2026-08-18', answer_count: 3, respondent_count: 3 },
  ], 3, '2026-08-18'), [
    { report_date: '2026-08-16', answer_count: 4, respondent_count: 2 },
    { report_date: '2026-08-17', answer_count: 0, respondent_count: 0 },
    { report_date: '2026-08-18', answer_count: 3, respondent_count: 3 },
  ]);
});

test('filter Dashboard Kampus memvalidasi hierarki universitas, fakultas, dan prodi', () => {
  assert.doesNotThrow(() => assertAcademicHierarchy({
    university_group_id: 1,
    faculty_group_id: 2,
    study_program_group_id: 3,
  }, groups));
  assert.throws(() => assertAcademicHierarchy({ faculty_group_id: 2 }, groups), {
    code: 'FACULTY_REQUIRES_UNIVERSITY',
  });
  assert.throws(() => assertAcademicHierarchy({
    university_group_id: 1,
    faculty_group_id: 4,
    study_program_group_id: 3,
  }, groups), {
    code: 'STUDY_PROGRAM_FACULTY_MISMATCH',
  });
});

test('halaman Dashboard Kampus merender filter dan menu hanya dengan campaigns.monitor', async () => {
  const html = await new Promise((resolve, reject) => {
    app.render('campus-dashboard/index', {
      title: 'Dashboard Kampus',
      csrfToken: 'test-token',
      currentUser: { id: 7, name: 'Operator' },
      currentPath: '/campus-dashboard',
      roles: ['operator'],
      permissions: ['campaigns.view', 'campaigns.monitor'],
    }, (error, output) => (error ? reject(error) : resolve(output)));
  });

  assert.match(html, /id="campus-dashboard-page"/);
  assert.match(html, /id="campus-filter-faculty"/);
  assert.match(html, /id="campus-filter-program"/);
  assert.match(html, /id="campus-filter-trend-days"/);
  assert.match(html, /id="campus-academic-chart"/);
  assert.match(html, /id="campus-progress-chart"/);
  assert.match(html, /id="campus-trend-chart"/);
  assert.match(html, /id="campus-question-chart"/);
  assert.match(html, /Dashboard Kampus/);
  assert.match(html, /assets\/js\/campus-dashboard\.js/);
  assert.match(html, /assets\/css\/campus-dashboard\.css/);
  assert.match(html, /nav-item active/);

  const withoutPermission = await new Promise((resolve, reject) => {
    app.render('dashboard', {
      title: 'Dashboard',
      csrfToken: 'test-token',
      currentUser: { id: 8, name: 'Viewer' },
      currentPath: '/dashboard',
      roles: ['viewer'],
      permissions: ['dashboard.view'],
    }, (error, output) => (error ? reject(error) : resolve(output)));
  });
  assert.doesNotMatch(withoutPermission, /href="\/campus-dashboard"/);
});
