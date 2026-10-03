import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function envValues() {
  const values = {};
  for (const line of (await fsp.readFile(path.join(projectRoot, '.env'), 'utf8')).split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const index = text.indexOf('=');
    if (index > 0) values[text.slice(0, index).trim()] = text.slice(index + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return values;
}

async function canConnect(values) {
  try {
    const connection = await mysql.createConnection({ host: values.MYSQL_HOST || '127.0.0.1', port: Number(values.MYSQL_PORT || 3306), user: values.MYSQL_USER, password: values.MYSQL_PASSWORD, database: values.MYSQL_DATABASE });
    await connection.end();
    return true;
  } catch { return false; }
}

export async function ensureMysql57() {
  const values = await envValues();
  const localRoot = path.resolve(projectRoot, '..', '..');
  const baseDir = values.MYSQL57_BASE_DIR || path.join(localRoot, 'mysql57');
  const dataDir = values.MYSQL57_DATA_DIR || path.join(localRoot, 'mysql57-data');
  const runtimeDir = values.MYSQL57_RUNTIME_DIR || path.join(localRoot, 'mysql57-runtime');
  const binary = path.join(baseDir, 'bin', 'mysqld');
  const socket = path.join(runtimeDir, 'mysql.sock');
  const pidFile = path.join(runtimeDir, 'mysql.pid');
  const errorLog = path.join(runtimeDir, 'mysql.err');
  const bindAddress = values.MYSQL_BIND_ADDRESS || '127.0.0.1';
  if ((values.MYSQL_HOST || '127.0.0.1') !== '127.0.0.1' || !fs.existsSync(binary)) return false;
  if (await canConnect(values)) { console.log('MySQL 5.7 已在运行'); return true; }
  await fsp.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const child = spawn(binary, [
    `--basedir=${baseDir}`, `--datadir=${dataDir}`, '--user=root', `--bind-address=${bindAddress}`,
    `--port=${values.MYSQL_PORT || 3306}`, `--socket=${socket}`, `--pid-file=${pidFile}`, `--log-error=${errorLog}`,
    '--skip-name-resolve'
  ], { detached: true, stdio: 'ignore', env: { ...process.env, LD_LIBRARY_PATH: path.join(baseDir, 'lib') } });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await canConnect(values)) { console.log('MySQL 5.7 已启动'); return true; }
  }
  throw new Error('MySQL 5.7 启动超时，请查看 ' + errorLog);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await ensureMysql57();
}
