const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_STORE = 'memory';

const app = require('../app');

test('layout dashboard dapat dirender dan menyembunyikan menu tanpa permission', async () => {
  const html = await new Promise((resolve, reject) => {
    app.render('dashboard', {
      title: 'Dashboard',
      csrfToken: 'test-token',
      currentUser: { id: 1, name: 'Tester' },
      currentPath: '/dashboard',
      permissions: ['dashboard.view', 'whatsapp.view'],
    }, (error, output) => (error ? reject(error) : resolve(output)));
  });

  assert.match(html, /WA Service/);
  assert.match(html, /Koneksi WhatsApp/);
  assert.match(html, /dashboard-page/);
  assert.match(html, /assets\/js\/dashboard\.js/);
  assert.match(html, /assets\/css\/wa-skeuomorphic\.css/);
  assert.match(html, /nav-item active/);
  assert.match(html, /<label>Utama<\/label>/);
  assert.match(html, /<label>Komunikasi<\/label>/);
  assert.doesNotMatch(html, /<label>Data &amp; Konten<\/label>/);
  assert.doesNotMatch(html, /<label>Monitoring<\/label>/);
  assert.doesNotMatch(html, /<label>Administrasi<\/label>/);
  assert.doesNotMatch(html, /Pengguna &amp; Akses/);
});

test('sidebar mengelompokkan seluruh menu sesuai alur kerja', async () => {
  const html = await new Promise((resolve, reject) => {
    app.render('dashboard', {
      title: 'Dashboard', csrfToken: 'test-token', currentUser: { id: 1, name: 'Administrator' },
      currentPath: '/dashboard', roles: ['super_admin'],
      permissions: [
        'dashboard.view', 'whatsapp.view', 'messages.send', 'messages.view', 'queue.view',
        'broadcasts.view', 'campaigns.view', 'contacts.view', 'templates.view', 'qa_session.view',
        'inbox.view', 'reports.view', 'integrations.view', 'users.view', 'settings.view',
      ],
    }, (error, output) => (error ? reject(error) : resolve(output)));
  });

  const labels = ['Utama', 'Komunikasi', 'Data &amp; Konten', 'Monitoring', 'Administrasi'];
  labels.forEach((label) => assert.match(html, new RegExp(`<label>${label}<\\/label>`)));
  const positions = labels.map((label) => html.indexOf(`<label>${label}</label>`));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

test('halaman login memakai tema lokal tanpa dependency font eksternal', async () => {
  const html = await new Promise((resolve, reject) => {
    app.render('login', {
      csrfToken: 'test-token',
      currentUser: null,
      errorMessage: null,
    }, (error, output) => (error ? reject(error) : resolve(output)));
  });

  assert.match(html, /assets\/css\/login-skeuomorphic\.css/);
  assert.match(html, /class="wa-glass-auth wa-modern-auth"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /name="remember_me"/);
  assert.match(html, /Gunakan hanya pada perangkat pribadi/);
  assert.doesNotMatch(html, /fonts\.cdnfonts\.com/);
});

test('halaman koneksi WhatsApp memakai layout dashboard', async () => {
  const html = await new Promise((resolve, reject) => {
    app.render('index', {
      title: 'Koneksi WhatsApp',
      csrfToken: 'test-token',
      currentUser: { id: 1, name: 'Administrator' },
      permissions: ['dashboard.view', 'whatsapp.view', 'whatsapp.manage'],
      canManageWhatsApp: true,
      status: 'idle',
      URL: 'http://localhost:3000',
    }, (error, output) => (error ? reject(error) : resolve(output)));
  });

  assert.match(html, /WA Service/);
  assert.match(html, /Koneksi WhatsApp/);
  assert.match(html, /Hubungkan/);
  assert.ok(html.includes('href="/dashboard"'));
});

test('halaman operasional inti memakai view khusus dan layout dashboard', async () => {
  const pages = [
    ['contacts/index', { canManageContacts: true }, 'contact-import-export-valid'],
    ['contact-groups/index', { canManageContactGroups: true, currentPath: '/contact-groups' }, 'contact-groups-page'],
    ['templates/index', { canManageTemplates: true }, 'template-form'],
    ['messages/index', {}, 'message-form'],
    ['broadcasts/index', { canManageBroadcasts: true }, 'broadcast-form'],
    ['message-activity/index', {
      initialTab: 'history', canViewHistory: true, canViewQueue: true,
      canRetryMessages: true, canManageQueue: true,
    }, 'message-activity-page'],
    ['users-management/index', { canManageUsers: true }, 'user-form'],
    ['integrations/index', { canManageIntegrations: true }, 'api-key-form'],
    ['reports/index', {}, 'reports-filter'],
    ['settings/index', { canManageSettings: true }, 'settings-form'],
    ['guidebook', {}, 'guidebook-readiness'],
  ];
  for (const [view, extraLocals, expectedId] of pages) {
    const html = await new Promise((resolve, reject) => {
      app.render(view, {
        title: 'Test', csrfToken: 'test-token', currentUser: { id: 1, name: 'Administrator' },
        permissions: ['dashboard.view', 'whatsapp.view', 'messages.view', 'messages.send', 'messages.retry', 'broadcasts.view', 'broadcasts.manage', 'contacts.view', 'contacts.manage', 'templates.view', 'templates.manage', 'queue.view', 'queue.manage', 'users.view', 'users.manage', 'integrations.view', 'integrations.manage', 'reports.view', 'settings.view', 'settings.manage'],
        ...extraLocals,
      }, (error, output) => (error ? reject(error) : resolve(output)));
    });
    assert.match(html, /WA Service/);
    assert.match(html, /wa-skeuo wa-glass/);
    assert.doesNotMatch(html, /icon-(send|code|book-open)/);
    assert.ok(html.includes(`id="${expectedId}"`));
    if (view === 'contacts/index') {
      assert.ok(!html.includes('id="contact-group-form"'));
      assert.ok(!html.includes('id="contact-universities-table"'));
      assert.ok(!html.includes('id="contact-faculties-table"'));
      assert.ok(html.includes('id="contact-import-university"'));
      assert.ok(html.includes('id="contact-import-faculty"'));
      assert.ok(html.includes('id="contact-university"'));
      assert.ok(html.includes('id="contact-faculty"'));
      assert.ok(!html.includes('id="contact-import-export-grouping"'));
      assert.match(html, /assets\/css\/contacts\.css/);
      assert.ok(html.includes('class="contact-import-actions contact-import-toolbar"'));
      assert.ok(!html.includes('class="btn contact-action-template"'));
      assert.ok(html.includes('class="contact-import-footer"'));
      assert.ok(html.includes('class="btn contact-action-valid"'));
      assert.ok(html.includes('class="btn contact-action-invalid"'));
    }
    if (view === 'contact-groups/index') {
      assert.ok(html.includes('id="university-form"'));
      assert.ok(html.includes('id="faculty-form"'));
      assert.ok(html.includes('id="universities-table"'));
      assert.ok(html.includes('id="faculties-table"'));
      assert.ok(html.includes('id="study-program-form"'));
      assert.ok(html.includes('id="programs-table"'));
      assert.match(html, /assets\/css\/contact-groups\.css/);
      assert.match(html, /assets\/js\/contact-groups\.js/);
      assert.match(html, /href="\/contact-groups"/);
      assert.match(html, /nav-item active/);
    }
    assert.match(html, /assets\/js\/wa-api\.js/);
    if (view === 'users-management/index') {
      assert.match(html, /id="users-password-dialog"/);
      assert.match(html, /minlength="6"/);
      assert.match(html, /assets\/css\/users-management\.css/);
    }
    if (view === 'message-activity/index') {
      assert.match(html, /id="history-filter"/);
      assert.match(html, /id="queue-filter"/);
      assert.match(html, /Aktivitas Pesan/);
      assert.match(html, /assets\/js\/message-activity\.js/);
    }
  }
});

test('halaman daftar dan detail Campaign memakai workspace terintegrasi', async () => {
  const common = {
    title: 'Campaign', csrfToken: 'test-token', currentUser: { id: 1, name: 'Administrator' },
    permissions: ['campaigns.view', 'campaigns.manage', 'campaigns.operate', 'campaigns.monitor'],
    roles: ['super_admin'], currentPath: '/campaigns',
  };
  const listHtml = await new Promise((resolve, reject) => {
    app.render('campaigns/index', { ...common, canManageCampaigns: true }, (error, output) => (error ? reject(error) : resolve(output)));
  });
  assert.match(listHtml, /id="campaign-list-page"/);
  assert.match(listHtml, /Tambah Campaign/);
  assert.match(listHtml, /assets\/js\/campaigns\.js/);
  assert.match(listHtml, /nav-item active/);

  const detailHtml = await new Promise((resolve, reject) => {
    app.render('campaigns/detail', {
      ...common,
      currentPath: '/campaigns/example-id',
      campaignPublicId: 'example-id',
      canManageCampaigns: true,
      canOperateCampaigns: true,
      canMonitorCampaigns: true,
      canAttributeCampaignReplies: true,
      showCampaignDevelopmentTools: true,
    }, (error, output) => (error ? reject(error) : resolve(output)));
  });
  assert.match(detailHtml, /id="campaign-detail-page"/);
  assert.match(detailHtml, /Kontak &amp; Import/);
  assert.match(detailHtml, /id="campaign-import-file-name"/);
  assert.match(detailHtml, /id="campaign-import-upload"[^>]*disabled/);
  assert.match(detailHtml, /template 8 kolom identitas atau file lengkap 13 kolom/);
  assert.match(detailHtml, /proses tersimpan di Campaign dan tetap dapat dilanjutkan setelah pindah menu atau refresh/);
  assert.match(detailHtml, /id="campaign-import-preview-category"/);
  assert.match(detailHtml, /<option value="all">Semua<\/option>/);
  assert.match(detailHtml, /Terdaftar WhatsApp/);
  assert.match(detailHtml, /Tidak Terdaftar/);
  assert.match(detailHtml, /Data Invalid/);
  assert.match(detailHtml, /id="campaign-import-preview-body"/);
  assert.match(detailHtml, /id="campaign-import-export-not-registered"[^>]*disabled/);
  assert.match(detailHtml, /campaigns\.css\?v=20260902-1/);
  assert.match(detailHtml, /campaign-detail\.js\?v=20260902-2/);
  assert.match(detailHtml, /<th>NIM<\/th>/);
  assert.match(detailHtml, /<th>Email<\/th>/);
  assert.match(detailHtml, /<th>Periode Wisuda<\/th>/);
  assert.match(detailHtml, /id="campaign-blast-form"/);
  assert.match(detailHtml, /href="#campaign-reblast"/);
  assert.match(detailHtml, /id="campaign-reblast-form"/);
  assert.match(detailHtml, /Belum menjawab sesi sama sekali/);
  assert.match(detailHtml, /Sudah membalas, tetapi belum selesai/);
  assert.match(detailHtml, /alumni tetap dapat di-Reblast lagi/);
  assert.match(detailHtml, /ditambahkan otomatis dan terlihat pada preview/);
  assert.doesNotMatch(detailHtml, /id="campaign-reblast-session"/);
  assert.match(detailHtml, /Preview Target &amp; Alumni/);
  assert.match(detailHtml, /id="campaign-reblast-target-list"/);
  assert.match(detailHtml, /id="campaign-reblast-person-preview-modal"/);
  assert.match(detailHtml, /Pesan final yang akan dikirim/);
  assert.match(detailHtml, /Tidak ada pesan atau job yang dibuat/);
  assert.match(detailHtml, /href="#campaign-questions"/);
  assert.match(detailHtml, /id="campaign-question-source-select"/);
  assert.match(detailHtml, /id="campaign-question-source-load"/);
  assert.match(detailHtml, /Muat dari Campaign Lain/);
  assert.match(detailHtml, /Perubahan berikutnya tidak saling memengaruhi/);
  assert.match(detailHtml, /id="campaign-question-form"/);
  assert.match(detailHtml, /Pilihan jawaban dan alur/);
  assert.match(detailHtml, /\{\{nama\}\}, \{\{nomor\}\}, \{\{nomor_masked\}\}, \{\{email\}\}, \{\{email_masked\}\}/);
  assert.match(detailHtml, /value="needs_review"/);
  assert.match(detailHtml, /value="review_pending_details"/);
  assert.match(detailHtml, /id="campaign-questions-body"/);
  assert.doesNotMatch(detailHtml, /Semua Sesi \(1–10\)/);
  assert.match(detailHtml, /id="campaign-monitoring"/);
  assert.match(detailHtml, /id="monitor-contact-total"/);
  assert.match(detailHtml, /id="monitor-contact-stopped"/);
  assert.match(detailHtml, /id="campaign-monitor-filter"/);
  assert.match(detailHtml, /id="campaign-monitor-export"/);
  assert.match(detailHtml, /Export Excel/);
  assert.match(detailHtml, /id="campaign-monitor-contacts-body"/);
  assert.doesNotMatch(detailHtml, /id="campaign-monitor-messages-body"/);
  assert.match(detailHtml, /id="campaign-monitor-contact-modal"/);
  assert.match(detailHtml, /Riwayat Balasan/);
  assert.match(detailHtml, /id="campaign-monitor-detail-read-all"/);
  assert.match(detailHtml, /href="#campaign-data-corrections"/);
  assert.match(detailHtml, /id="campaign-data-correction-body"/);
  assert.match(detailHtml, /id="campaign-data-correction-form"/);
  assert.match(detailHtml, /Data Tidak Sesuai/);
  assert.match(detailHtml, /id="campaign-data-correction-reported-fields"/);
  assert.match(detailHtml, /Simpan &amp; Kirim Konfirmasi Ulang/);
  assert.match(detailHtml, /id="campaign-development-reset-progress"/);
  assert.match(detailHtml, /Reset Progress Campaign Ini/);
  assert.doesNotMatch(detailHtml, /Perlu Atribusi Manual/);
  assert.doesNotMatch(detailHtml, /id="monitor-unattributed-list"/);
  assert.doesNotMatch(detailHtml, /id="campaign-monitor-clear-all"/);
  assert.doesNotMatch(detailHtml, /id="campaign-quick-(?:import|monitoring)"/);
  assert.match(detailHtml, /assets\/js\/campaign-detail\.js/);

  const operatorDetailHtml = await new Promise((resolve, reject) => {
    app.render('campaigns/detail', {
      ...common,
      permissions: ['campaigns.view', 'campaigns.operate', 'campaigns.monitor'],
      roles: ['operator'],
      currentPath: '/campaigns/example-id',
      campaignPublicId: 'example-id',
      canManageCampaigns: false,
      canOperateCampaigns: true,
      canMonitorCampaigns: true,
      canAttributeCampaignReplies: false,
      showCampaignDevelopmentTools: true,
    }, (error, output) => (error ? reject(error) : resolve(output)));
  });
  assert.doesNotMatch(operatorDetailHtml, /id="campaign-development-reset-progress"/);
  assert.doesNotMatch(operatorDetailHtml, /id="campaign-question-source-load"/);

  const productionDetailHtml = await new Promise((resolve, reject) => {
    app.render('campaigns/detail', {
      ...common,
      currentPath: '/campaigns/example-id',
      campaignPublicId: 'example-id',
      canManageCampaigns: true,
      canOperateCampaigns: true,
      canMonitorCampaigns: true,
      canAttributeCampaignReplies: true,
      showCampaignDevelopmentTools: false,
    }, (error, output) => (error ? reject(error) : resolve(output)));
  });
  assert.doesNotMatch(productionDetailHtml, /id="campaign-development-reset-progress"/);
});

test('preview Reblast per alumni memakai hasil render server tanpa membuat enqueue dari browser', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../wa-service-fe/public/assets/js/campaign-detail.js'), 'utf8');
  assert.match(source, /reblasts\/targets\/\$\{contact\.membership_id\}\/preview/);
  assert.match(source, /body: \{ mode, body: messageBody \}/);
  assert.match(source, /person-preview-body'\)\.textContent = preview\.body/);
  assert.match(source, /Lihat Preview/);
  assert.doesNotMatch(source, /previewReblastTarget[\s\S]{0,2500}idempotency_key/);
});

test('halaman aktivitas pesan hanya merender tab yang diizinkan', async () => {
  const html = await new Promise((resolve, reject) => {
    app.render('message-activity/index', {
      title: 'Aktivitas Pesan', csrfToken: 'test-token', currentUser: { id: 2, name: 'Viewer' },
      permissions: ['queue.view'], initialTab: 'queue', canViewHistory: false, canViewQueue: true,
      canRetryMessages: false, canManageQueue: false,
    }, (error, output) => (error ? reject(error) : resolve(output)));
  });

  assert.match(html, /id="queue-filter"/);
  assert.doesNotMatch(html, /id="history-filter"/);
  assert.doesNotMatch(html, /message-history\.js/);
});
