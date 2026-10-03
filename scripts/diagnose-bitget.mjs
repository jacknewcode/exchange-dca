import dns from 'node:dns/promises';
import fs from 'node:fs';
import mysql from 'mysql2/promise';
import { BitgetClient } from '../src/bitget-client.mjs';

const root = new URL('..', import.meta.url);
const envPath = new URL('.env', root);
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const text = line.trim();
  if (!text || text.startsWith('#')) continue;
  const index = text.indexOf('=');
  if (index > 0) env[text.slice(0, index).trim()] = text.slice(index + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
}
// Read credentials from MySQL without creating tables or modifying runtime state.
if (env.MYSQL_HOST && env.MYSQL_USER) {
  let connection;
  try {
    connection = await mysql.createConnection({
      host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306),
      user: env.MYSQL_USER, password: env.MYSQL_PASSWORD,
      database: env.MYSQL_DATABASE || 'orbit_dca', connectTimeout: 5000
    });
    const [rows] = await connection.query('SELECT api_key, secret_key, passphrase FROM bitget_credentials WHERE id=1');
    if (rows[0]) {
      env.BITGET_API_KEY = rows[0].api_key;
      env.BITGET_SECRET_KEY = rows[0].secret_key;
      env.BITGET_PASSPHRASE = rows[0].passphrase;
    }
  } catch (error) {
    console.error('数据库密钥读取失败:', error.code || '连接失败');
  } finally { await connection?.end(); }
}

const base = (env.BITGET_BASE_URL || 'https://api.bitget.com').replace(/\/+$/, '');
const endpoint = base + '/api/v3/market/instruments?category=SPOT';
console.log('Bitget 地址:', base);
try {
  const host = new URL(base).hostname;
  console.log('DNS:', host, (await dns.lookup(host)).address);
} catch (error) {
  console.error('DNS 失败:', error.message);
  console.error('请检查服务器 DNS 或网络出口；这一步与 API 密钥无关。');
  process.exitCode = 2;
}

try {
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
  const payload = await response.json();
  const rows = Array.isArray(payload.data) ? payload.data : [];
  console.log('公共交易对接口:', response.status, payload.code, '返回', rows.length, '条');

} catch (error) {
  console.error('公共交易对接口失败:', error.message);
  process.exitCode = 3;
}

const client = new BitgetClient({
  baseUrl: base,
  apiKey: env.BITGET_API_KEY,
  secretKey: env.BITGET_SECRET_KEY,
  passphrase: env.BITGET_PASSPHRASE,
  locale: env.BITGET_LOCALE || 'zh-CN'
});
if (client.isConfigured) {
  try {
    const assets = await client.getAssets('USDT');
    console.log('私有账户接口: 正常，返回', assets.length, '条资产');
  } catch (error) {
    console.error('私有账户接口失败:', error.message, error.code || '');
    process.exitCode ||= 4;
  }
} else {
  console.log('私有账户接口: 未配置完整密钥');
}
