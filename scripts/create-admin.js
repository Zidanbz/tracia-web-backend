const bcrypt = require('bcrypt');
const { z } = require('zod');
const knex = require('../src/database/knex');
const { passwordSchema } = require('../src/modules/auth/password-policy');

const inputSchema = z.object({
  name: z.string().trim().min(2).max(150),
  email: z.email().transform((value) => value.toLowerCase()),
  password: passwordSchema,
});

async function main() {
  const input = inputSchema.parse({
    name: process.env.ADMIN_NAME,
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  const passwordHash = await bcrypt.hash(input.password, 12);

  await knex.transaction(async (trx) => {
    const role = await trx('roles').where({ name: 'super_admin' }).first();
    if (!role) {
      throw new Error('Role super_admin belum tersedia. Jalankan migration dan seed terlebih dahulu.');
    }
    const existing = await trx('users').where({ email: input.email }).first();
    if (existing) throw new Error('Email admin sudah terdaftar');

    const [userId] = await trx('users').insert({
      name: input.name,
      email: input.email,
      password_hash: passwordHash,
      status: 'active',
    });
    await trx('user_roles').insert({ user_id: userId, role_id: role.id });
  });

  console.log(`Super admin berhasil dibuat untuk ${input.email}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await knex.destroy();
  });
