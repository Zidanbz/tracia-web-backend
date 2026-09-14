#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

const RULES = [
  {
    code: 'HARDCODED_MYSQL_CLIENT',
    description: 'Koneksi utama masih mengunci client Knex ke mysql2',
    pattern: /client\s*:\s*['"]mysql2['"]/g,
  },
  {
    code: 'MYSQL_SESSION_STORE',
    description: 'Session middleware masih memakai express-mysql-session',
    pattern: /express-mysql-session|createMySQLStore/g,
  },
  {
    code: 'MYSQL_ONLY_PRODUCTION_SESSION',
    description: 'Validasi production masih mewajibkan session store MySQL',
    pattern: /sessionStore\s*!==\s*['"]mysql['"]/g,
  },
  {
    code: 'MYSQL_SQL_DIALECT',
    description: 'Query masih memakai fungsi atau sintaks khusus MySQL',
    pattern: /\b(?:UTC_TIMESTAMP|DATE_SUB|DATE_FORMAT|CONVERT_TZ|GROUP_CONCAT|CURRENT_DATE)\s*\(|\bINTERVAL\s+\?/gi,
  },
  {
    code: 'MYSQL_INSERT_RESULT',
    description: 'Insert masih mengasumsikan Knex mengembalikan array ID ala MySQL',
    pattern: /const\s+\[\s*[A-Za-z_$][\w$]*\s*\]\s*=\s*await[\s\S]{0,500}?\.insert\s*\(/g,
  },
];

function walkSource(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules'
      || entry.name === 'storage'
      || (entry.name === 'migrations' && path.basename(directory) === 'database')
    ) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkSource(absolute));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

function auditRuntime(projectRoot) {
  const roots = ['src', 'app.js']
    .map((item) => path.join(projectRoot, item))
    .filter((item) => fs.existsSync(item));
  const files = roots.flatMap((item) => (
    fs.statSync(item).isDirectory() ? walkSource(item) : [item]
  ));
  const findings = [];

  for (const filename of files) {
    const content = fs.readFileSync(filename, 'utf8');
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      for (const match of content.matchAll(rule.pattern)) {
        findings.push({
          code: rule.code,
          description: rule.description,
          file: path.relative(projectRoot, filename),
          line: lineNumberAt(content, match.index),
        });
      }
    }
  }

  const uniqueFindings = [...new Map(findings.map((finding) => [
    `${finding.code}:${finding.file}:${finding.line}`,
    finding,
  ])).values()];

  return uniqueFindings.sort((left, right) => (
    left.file.localeCompare(right.file) || left.line - right.line || left.code.localeCompare(right.code)
  ));
}

function summarize(findings) {
  return findings.reduce((result, finding) => {
    result[finding.code] = (result[finding.code] || 0) + 1;
    return result;
  }, {});
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const findings = auditRuntime(projectRoot);
  const report = {
    ready_for_postgresql_runtime: findings.length === 0,
    blocker_count: findings.length,
    blockers_by_code: summarize(findings),
    findings,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (findings.length > 0) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { RULES, auditRuntime, summarize };
