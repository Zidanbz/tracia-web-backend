exports.up = async function up(knex) {
  let legacyOffsetSeconds = 0;
  try {
    // Versi sebelumnya memakai mysql2 UTC serialization, tetapi membiarkan
    // session MySQL mengikuti SYSTEM. Ambil offset lama sebelum menormalkan
    // received_at/created_at yang ditulis dari JavaScript Date.
    await knex.raw("SET time_zone = 'SYSTEM'");
    const [rows] = await knex.raw(
      'SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), NOW(3)) AS offset_seconds',
    );
    legacyOffsetSeconds = Number(rows?.[0]?.offset_seconds || 0);
    if (!Number.isInteger(legacyOffsetSeconds) || Math.abs(legacyOffsetSeconds) > 50400) {
      throw new Error(`Offset timezone database lama tidak valid: ${legacyOffsetSeconds}`);
    }
    if (legacyOffsetSeconds !== 0) {
      await knex('incoming_messages').update({
        received_at: knex.raw('DATE_ADD(received_at, INTERVAL ? SECOND)', [legacyOffsetSeconds]),
        created_at: knex.raw('DATE_ADD(created_at, INTERVAL ? SECOND)', [legacyOffsetSeconds]),
      });
    }
  } finally {
    await knex.raw("SET time_zone = '+00:00'");
  }
};

exports.down = async function down() {
  throw new Error('Rollback normalisasi timestamp dibatalkan karena dapat menggeser data baru yang sudah ditulis dalam UTC');
};
