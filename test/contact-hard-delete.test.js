const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SESSION_STORE = 'memory';

const contactsService = require('../src/modules/contacts/contacts.service');

test('hapus kontak menjalankan hard delete pada tabel contacts', async () => {
  let deleted = false;
  const query = {
    where(criteria) {
      assert.deepEqual(criteria, { id: 42 });
      return this;
    },
    whereNull(column) {
      assert.equal(column, 'deleted_at');
      return this;
    },
    del() {
      deleted = true;
      return Promise.resolve(1);
    },
  };
  const database = (table) => {
    assert.equal(table, 'contacts');
    return query;
  };

  await contactsService.remove(42, database);
  assert.equal(deleted, true);
});

test('hapus permanen kontak yang tidak ditemukan menghasilkan 404', async () => {
  const query = {
    where() { return this; },
    whereNull() { return this; },
    del() { return Promise.resolve(0); },
  };
  await assert.rejects(
    contactsService.remove(999, () => query),
    (error) => error.status === 404 && error.code === 'CONTACT_NOT_FOUND',
  );
});
