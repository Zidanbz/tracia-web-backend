const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../src/config/env');

function escapeSqlValue(val) {
  if (val === null || val === undefined) {
    return 'NULL';
  }
  if (typeof val === 'boolean') {
    return val ? '1' : '0';
  }
  if (typeof val === 'number') {
    return Number.isFinite(val) ? String(val) : 'NULL';
  }
  if (val instanceof Date) {
    return `'${val.toISOString().slice(0, 19).replace('T', ' ')}'`;
  }
  if (Buffer.isBuffer(val)) {
    return `X'${val.toString('hex')}'`;
  }
  if (typeof val === 'object') {
    const jsonStr = JSON.stringify(val);
    return `'${jsonStr.replace(/[\0\x08\x09\x1a\n\r"'\\\%]/g, (char) => {
      switch (char) {
        case '\0': return '\\0';
        case '\x08': return '\\b';
        case '\x09': return '\\t';
        case '\x1a': return '\\z';
        case '\n': return '\\n';
        case '\r': return '\\r';
        case '"':
        case "'":
        case '\\':
        case '%':
          return `\\${char}`;
        default:
          return char;
      }
    })}'`;
  }

  // String escape
  const str = String(val);
  return `'${str.replace(/[\0\x08\x09\x1a\n\r"'\\\%]/g, (char) => {
    switch (char) {
      case '\0': return '\\0';
      case '\x08': return '\\b';
      case '\x09': return '\\t';
      case '\x1a': return '\\z';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '"':
      case "'":
      case '\\':
      case '%':
        return `\\${char}`;
      default:
        return char;
    }
  })}'`;
}

async function exportDatabase() {
  const dbConfig = config.database;
  const targetDir = path.resolve(__dirname, '../dumps');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const customFileName = process.argv[2];
  const outputFileName = customFileName || `wa_service_dump_${timestamp}.sql`;
  const outputPath = path.isAbsolute(outputFileName)
    ? outputFileName
    : path.resolve(targetDir, outputFileName);

  console.log(`\nConnecting to MySQL database '${dbConfig.database}' on ${dbConfig.host}:${dbConfig.port}...`);

  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    charset: 'utf8mb4',
    dateStrings: true,
  });

  const writeStream = fs.createWriteStream(outputPath, { encoding: 'utf8' });

  const write = (str) => {
    return new Promise((resolve, reject) => {
      if (!writeStream.write(str)) {
        writeStream.once('drain', resolve);
      } else {
        process.nextTick(resolve);
      }
    });
  };

  console.log('Fetching database tables...');
  const [tables] = await connection.query('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"');
  const tableKey = `Tables_in_${dbConfig.database}`;

  await write(`-- WA Service Database Dump\n`);
  await write(`-- Host: ${dbConfig.host}:${dbConfig.port} Database: ${dbConfig.database}\n`);
  await write(`-- Generated at: ${new Date().toISOString()}\n\n`);
  await write(`SET FOREIGN_KEY_CHECKS = 0;\n`);
  await write(`SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";\n`);
  await write(`SET NAMES utf8mb4;\n\n`);

  for (const tableObj of tables) {
    const tableName = tableObj[tableKey];
    console.log(`Processing table: ${tableName}...`);

    await write(`-- --------------------------------------------------------\n`);
    await write(`-- Table structure for table \`${tableName}\`\n`);
    await write(`-- --------------------------------------------------------\n\n`);
    await write(`DROP TABLE IF EXISTS \`${tableName}\`;\n`);

    const [[createTableResult]] = await connection.query(`SHOW CREATE TABLE \`${tableName}\``);
    const createTableSql = createTableResult['Create Table'];
    await write(`${createTableSql};\n\n`);

    // Fetch data
    const [rows] = await connection.query(`SELECT * FROM \`${tableName}\``);
    if (rows.length > 0) {
      await write(`-- Dumping data for table \`${tableName}\`\n`);
      await write(`LOCK TABLES \`${tableName}\` WRITE;\n`);

      const columnNames = Object.keys(rows[0]).map((col) => `\`${col}\``).join(', ');

      const batchSize = 100;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const valuesList = batch.map((row) => {
          const values = Object.values(row).map(escapeSqlValue).join(', ');
          return `(${values})`;
        }).join(',\n');

        await write(`INSERT INTO \`${tableName}\` (${columnNames}) VALUES\n${valuesList};\n`);
      }

      await write(`UNLOCK TABLES;\n\n`);
      console.log(`  -> Exported ${rows.length} rows`);
    } else {
      console.log(`  -> 0 rows (empty table)`);
    }
  }

  await write(`SET FOREIGN_KEY_CHECKS = 1;\n`);
  await write(`-- Dump completed on ${new Date().toISOString()}\n`);

  await new Promise((resolve) => writeStream.end(resolve));
  await connection.end();

  const stats = fs.statSync(outputPath);
  const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
  const sizeKb = (stats.size / 1024).toFixed(2);

  console.log(`\nExport successfully completed!`);
  console.log(`File: ${outputPath}`);
  console.log(`Size: ${stats.size > 1024 * 1024 ? `${sizeMb} MB` : `${sizeKb} KB`}\n`);
}

exportDatabase().catch((err) => {
  console.error('\nDatabase export failed:', err);
  process.exit(1);
});
