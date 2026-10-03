import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnvFile(file) {
  const values = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const item = line.trim();
      if (!item || item.startsWith('#')) continue;
      const index = item.indexOf('=');
      if (index < 1) continue;
      const key = item.slice(0, index).trim();
      let value = item.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[key] = value;
    }
  } catch {}
  return values;
}

const config = {};
for (const file of [process.env.ORBIT_CONFIG_FILE, path.join(root, '.env'), '/etc/orbit-dca/environment']) {
  if (!file) continue;
  for (const [key, value] of Object.entries(readEnvFile(file))) {
    if (!(key in config)) config[key] = value;
  }
}
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) config[key] = value;
}

const input = fs.readFileSync(0, 'utf8').split(/\r?\n/);
const username = String(config.ORBIT_RESET_USERNAME || input[0] || 'admin').trim();
const password = String(config.ORBIT_RESET_PASSWORD || input[1] || '');
if (!username || /\s/.test(username) || username.length > 255) throw new Error('用户名不能为空且不能包含空格');
if (password.length < 8) throw new Error('密码至少需要 8 个字符');

const db = {
  host: config.MYSQL_HOST || '127.0.0.1',
  port: Number(config.MYSQL_PORT || 3306),
  user: config.MYSQL_USER || '',
  password: config.MYSQL_PASSWORD || '',
  database: config.MYSQL_DATABASE || 'orbit_dca'
};
if (!db.user || !db.password) throw new Error('未配置 MYSQL_USER 或 MYSQL_PASSWORD');

const pool = mysql.createPool({ ...db, waitForConnections: true, connectionLimit: 2, charset: 'utf8mb4' });
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS auth_credentials (
    id TINYINT PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    algorithm VARCHAR(32) NOT NULL,
    salt VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    updated_at VARCHAR(40) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  await pool.query(
    `INSERT INTO auth_credentials (id,username,algorithm,salt,password_hash,updated_at)
     VALUES (1,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE username=VALUES(username),algorithm=VALUES(algorithm),salt=VALUES(salt),password_hash=VALUES(password_hash),updated_at=VALUES(updated_at)`,
    [username, 'scrypt', salt.toString('base64'), hash.toString('base64'), new Date().toISOString()]
  );
  console.log(`登录密码已重置，用户名：${username}`);
} finally {
  await pool.end();
}
