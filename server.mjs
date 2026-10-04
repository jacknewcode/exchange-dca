import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BitgetClient, BitgetApiError, normalizeSymbol } from './src/bitget-client.mjs';
import { createMysqlStore } from './src/mysql-store.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(ROOT, 'web');

function loadDotEnv() {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const item = line.trim();
      if (!item || item.startsWith('#')) continue;
      const index = item.indexOf('=');
      if (index < 1) continue;
      const key = item.slice(0, index).trim();
      let value = item.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {}
}

loadDotEnv();

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'orbit.json');
const MARKET_CACHE_FILE = path.join(DATA_DIR, 'markets.json');
const RUNTIME_CONFIG_FILE = path.join(DATA_DIR, 'runtime-config.json');
const CREDENTIALS_FILE = path.join(DATA_DIR, 'bitget-credentials.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'notification-settings.json');
const MYSQL_HOST = process.env.MYSQL_HOST || '';
const MYSQL_PORT = Number(process.env.MYSQL_PORT || 3306);
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'orbit_dca';
const MYSQL_USER = process.env.MYSQL_USER || '';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';
const MYSQL_CONNECTION_LIMIT = Number(process.env.MYSQL_CONNECTION_LIMIT || 10);
const MARKET_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const AUTH_USER_ENV = process.env.AUTH_USER || 'admin';
const AUTH_PASSWORD_ENV = process.env.AUTH_PASSWORD || '';

function makeAuthRecord(username, password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return { version: 1, algorithm: 'scrypt', username, salt: salt.toString('base64'), hash: hash.toString('base64'), updatedAt: new Date().toISOString() };
}

function readAuthRecord() {
  try {
    const record = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    return record && record.version === 1 && record.algorithm === 'scrypt' ? record : null;
  } catch { return null; }
}

function removePlainAuthPassword() {
  try {
    const envPath = path.join(ROOT, '.env');
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    const filtered = lines.filter((line) => !/^\s*AUTH_PASSWORD\s*=/.test(line));
    fs.writeFileSync(envPath, filtered.join('\n'), { mode: 0o600 });
  } catch {}
}

let authRecord = readAuthRecord();
let AUTH_USER = authRecord?.username || AUTH_USER_ENV;
let AUTH_ENABLED = Boolean(authRecord || AUTH_PASSWORD_ENV);
// 敏感配置使用独立主密钥；未设置时使用登录密码哈希派生密钥。
let STORAGE_KEY_MATERIAL = process.env.ORBIT_ENCRYPTION_KEY || authRecord?.hash || AUTH_PASSWORD_ENV;
const sessions = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter(([key, value]) => key && value));
}

function credentialsMatch(user, password) {
  const expectedUser = crypto.createHash('sha256').update(AUTH_USER).digest();
  const actualUser = crypto.createHash('sha256').update(String(user || '')).digest();
  if (!authRecord) return false;
  const salt = Buffer.from(authRecord.salt, 'base64');
  const expectedPassword = Buffer.from(authRecord.hash, 'base64');
  const actualPassword = crypto.scryptSync(String(password || ''), salt, expectedPassword.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expectedUser, actualUser) && crypto.timingSafeEqual(expectedPassword, actualPassword);
}

function storageKey(salt) {
  if (!STORAGE_KEY_MATERIAL) throw new Error('未配置 ORBIT_ENCRYPTION_KEY 或登录密码，无法加密保存敏感配置');
  return crypto.scryptSync(STORAGE_KEY_MATERIAL, salt, 32, { N: 16384, r: 8, p: 1 });
}

function encryptStored(value) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', storageKey(salt), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64')
  };
}

function decryptStored(envelope) {
  if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') return { value: envelope, encrypted: false };
  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', storageKey(salt), iv);
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  return { value: JSON.parse(plaintext.toString('utf8')), encrypted: true };
}

function authenticated(req, res, parsed) {
  if (!AUTH_ENABLED) return true;
  if (parsed.pathname === '/login.html' || parsed.pathname === '/api/auth/login' || parsed.pathname === '/api/health') return true;
  const session = sessions.get(parseCookies(req.headers.cookie || '').orbit_session);
  if (session && session.expiresAt > Date.now()) return true;
  if (session) sessions.delete(parseCookies(req.headers.cookie || '').orbit_session);
  if (parsed.pathname.startsWith('/api/')) {
    sendJson(res, 401, { ok: false, error: '登录已过期，请重新登录', code: 'AUTH_REQUIRED' });
  } else {
    res.writeHead(302, { Location: '/login.html', 'Cache-Control': 'no-store' });
    res.end();
  }
  return false;
}

const config = {
  mode: 'live',
  minOrderUSDT: Number(process.env.MIN_ORDER_USDT || 1),
  maxOrderUSDT: Number(process.env.MAX_ORDER_USDT || 500),
  timezone: process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai',
  baseUrl: process.env.BITGET_BASE_URL || 'https://api.bitget.com'
};

const bitget = new BitgetClient({
  baseUrl: config.baseUrl,
  apiKey: process.env.BITGET_API_KEY,
  secretKey: process.env.BITGET_SECRET_KEY,
  passphrase: process.env.BITGET_PASSPHRASE,
  locale: process.env.BITGET_LOCALE || 'zh-CN',
  channelCode: process.env.BITGET_CHANNEL_CODE
});

const FALLBACK_MARKETS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT',
  'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'LTCUSDT', 'TRXUSDT', 'TONUSDT', 'SUIUSDT',
  'PEPEUSDT', 'SHIBUSDT', 'USDCUSDT'
].map((symbol) => ({ symbol, category: 'SPOT', baseCoin: symbol.replace(/USDT$/, ''), quoteCoin: 'USDT', status: 'online' }));
let db = { plans: [], executions: [] };
let notificationSettings = { enabled: false, botToken: '', chatId: '', notifyFailures: true };
let marketCache = null;
let marketRefreshPromise = null;
let marketLastRefreshedAt = 0;
let mysqlStore = null;
let saveQueue = Promise.resolve();
const executingPlans = new Set();

async function readLegacyJson(file, fallback = null) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}

async function archiveLegacyFile(file) {
  try {
    await fsp.rename(file, file + '.legacy.bak');
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('旧 JSON 文件归档失败:', path.basename(file));
  }
}

async function loadDb() {
  if (!MYSQL_HOST || !MYSQL_USER) {
    throw new Error('未配置 MySQL 连接，请填写 MYSQL_HOST、MYSQL_USER、MYSQL_PASSWORD 和 MYSQL_DATABASE');
  }
  mysqlStore = await createMysqlStore({
    host: MYSQL_HOST, port: MYSQL_PORT, database: MYSQL_DATABASE,
    user: MYSQL_USER, password: MYSQL_PASSWORD, connectionLimit: MYSQL_CONNECTION_LIMIT
  });

  const legacyDb = await readLegacyJson(DB_FILE, { plans: [], executions: [] });
  const legacyMarkets = await readLegacyJson(MARKET_CACHE_FILE, []);
  const legacyCredentialsRaw = await readLegacyJson(CREDENTIALS_FILE, null);
  const legacySettingsRaw = await readLegacyJson(SETTINGS_FILE, null);
  const legacyRuntime = await readLegacyJson(RUNTIME_CONFIG_FILE, null);
  const state = await mysqlStore.loadState();
  const hasLegacyState = Array.isArray(legacyDb?.plans) || Array.isArray(legacyDb?.executions);

  if (!state.plans.length && !state.executions.length && hasLegacyState) {
    const oldPlans = Array.isArray(legacyDb.plans) ? legacyDb.plans : [];
    const oldExecutions = Array.isArray(legacyDb.executions) ? legacyDb.executions : [];
    await mysqlStore.replaceState(oldPlans, oldExecutions);
    state.plans = oldPlans;
    state.executions = oldExecutions;
  }
  db = { plans: state.plans, executions: state.executions };

  if (state.markets.length) {
    marketCache = state.markets;
    marketLastRefreshedAt = Date.now();
  }
  else if (Array.isArray(legacyMarkets) && legacyMarkets.length) {
    marketCache = legacyMarkets;
    marketLastRefreshedAt = Date.now();
    await mysqlStore.replaceMarkets(legacyMarkets);
  }

  const databaseAuth = await mysqlStore.getAuth();
  if (databaseAuth) {
    authRecord = databaseAuth;
    AUTH_USER = databaseAuth.username;
    AUTH_ENABLED = true;
    STORAGE_KEY_MATERIAL = process.env.ORBIT_ENCRYPTION_KEY || databaseAuth.hash;
  } else if (authRecord) {
    await mysqlStore.saveAuth(authRecord);
  } else if (AUTH_PASSWORD_ENV) {
    authRecord = makeAuthRecord(AUTH_USER_ENV, AUTH_PASSWORD_ENV);
    await mysqlStore.saveAuth(authRecord);
    AUTH_USER = authRecord.username;
    AUTH_ENABLED = true;
    STORAGE_KEY_MATERIAL = process.env.ORBIT_ENCRYPTION_KEY || authRecord.hash;
    removePlainAuthPassword();
  } else if (HOST !== '127.0.0.1' && HOST !== '::1') {
    throw new Error('公开监听需要设置 AUTH_PASSWORD 或 MySQL 中已有登录认证记录');
  }

  const databaseCredentials = await mysqlStore.getCredentials();
  if (databaseCredentials) {
    bitget.setCredentials({ apiKey: databaseCredentials.api_key, secretKey: databaseCredentials.secret_key, passphrase: databaseCredentials.passphrase });
  } else if (legacyCredentialsRaw) {
    const stored = decryptStored(legacyCredentialsRaw);
    if (stored.value?.apiKey && stored.value?.secretKey && stored.value?.passphrase) {
      const credentials = { apiKey: stored.value.apiKey, secretKey: stored.value.secretKey, passphrase: stored.value.passphrase, updatedAt: stored.value.updatedAt || new Date().toISOString() };
      await mysqlStore.saveCredentials(credentials);
      bitget.setCredentials(credentials);
    }
  }

  const databaseNotifications = await mysqlStore.getNotifications();
  if (databaseNotifications) notificationSettings = { ...notificationSettings, ...databaseNotifications };
  else if (legacySettingsRaw) {
    const stored = decryptStored(legacySettingsRaw);
    if (stored.value) {
      notificationSettings = { ...notificationSettings, ...stored.value };
      await mysqlStore.saveNotifications({ ...notificationSettings, updatedAt: new Date().toISOString() });
    }
  }
  config.mode = 'live';
  await mysqlStore.saveSetting('mode', config.mode);
  for (const file of [DB_FILE, MARKET_CACHE_FILE, CREDENTIALS_FILE, SETTINGS_FILE, RUNTIME_CONFIG_FILE, AUTH_FILE]) await archiveLegacyFile(file);
}
async function persistNotificationSettings() {
  await mysqlStore.saveNotifications({ ...notificationSettings, updatedAt: new Date().toISOString() });
}

function notificationStatus() {
  return {
    enabled: Boolean(notificationSettings.enabled),
    configured: Boolean(notificationSettings.botToken && notificationSettings.chatId),
    chatId: maskSecret(notificationSettings.chatId),
    notifyFailures: Boolean(notificationSettings.notifyFailures)
  };
}

async function sendTelegramMessage(text, { force = false } = {}) {
  if ((!force && !notificationSettings.enabled) || !notificationSettings.botToken || !notificationSettings.chatId) return;
  const response = await fetch('https://api.telegram.org/bot' + notificationSettings.botToken + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: notificationSettings.chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.description || 'Telegram 通知发送失败');
}

async function sendTelegram(text) {
  return sendTelegramMessage(text);
}

function notifyExecution(execution) {
  const status = execution.status === 'submitted' ? '已提交' : execution.status;
  const text = [
    'Orbit DCA 执行通知',
    '状态：' + status,
    '计划：' + execution.planName,
    '交易对：' + execution.symbol,
    '金额：' + execution.amount + ' USDT',
    '订单号：' + (execution.orderId || '待确认'),
    '时间：' + execution.createdAt
  ].join('\n');
  void sendTelegram(text)
    .then(() => console.log('Telegram execution notification sent'))
    .catch((error) => console.error('Telegram notification failed:', error.message));
}

async function notifyFailure(plan, error) {
  const reason = error?.message || '未知错误';
  plan.failureCount = Math.max(0, Number(plan.failureCount || 0)) + 1;
  const threshold = Math.max(1, Number(plan.failureThreshold || 3));
  const paused = plan.failureCount >= threshold;
  if (paused) plan.enabled = false;
  plan.updatedAt = new Date().toISOString();
  try {
    await persistPlan(plan);
  } catch (persistError) {
    console.error('Failed to persist plan failure state:', persistError.message);
  }

  if (!notificationSettings.enabled || !notificationSettings.notifyFailures) return;
  const text = [
    'Orbit DCA 执行失败',
    '计划：' + plan.name,
    '交易对：' + plan.symbol,
    '金额：' + plan.amount + ' USDT',
    '连续失败：' + plan.failureCount + '/' + threshold,
    '原因：' + reason,
    '时间：' + new Date().toISOString()
  ].join('\n');
  void sendTelegram(text).catch((sendError) => console.error('Telegram notification failed:', sendError.message));
  if (paused) {
    const pauseText = [
      'Orbit DCA 定投已自动暂停',
      '计划：' + plan.name,
      '交易对：' + plan.symbol,
      '原因：连续失败 ' + plan.failureCount + ' 次',
      '最后失败原因：' + reason,
      '请修复问题后在计划列表中恢复计划。'
    ].join('\n');
    void sendTelegram(pauseText).catch((sendError) => console.error('Telegram pause notification failed:', sendError.message));
  }
}

function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return '••••••••';
  return text.slice(0, 4) + '••••••••' + text.slice(-4);
}

async function persistCredentials(credentials) {
  await mysqlStore.saveCredentials(credentials);
}

function refreshMarketCache() {
  if (marketCache?.length && Date.now() - marketLastRefreshedAt < MARKET_REFRESH_INTERVAL_MS) return Promise.resolve(marketCache);
  if (marketRefreshPromise) return marketRefreshPromise;
  marketRefreshPromise = Promise.race([
    bitget.getSymbols(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Bitget 交易对接口超时')), 5000))
  ]).then(async (rows) => {
    const online = rows.filter((row) => row.quoteCoin === 'USDT' && row.status === 'online');
    if (online.length) {
      marketCache = online;
      marketLastRefreshedAt = Date.now();
      await mysqlStore.replaceMarkets(online);
    }
    return online;
  }).catch(() => {
    marketLastRefreshedAt = Date.now();
    return [];
  }).finally(() => {
    marketRefreshPromise = null;
  });
  return marketRefreshPromise;
}

function enqueueSave(task) {
  saveQueue = saveQueue.catch((error) => {
    console.error('Previous database write failed:', error.message);
  }).then(task);
  return saveQueue;
}

function persistPlan(plan) {
  return enqueueSave(() => mysqlStore.savePlan(plan));
}

function persistExecutionAndPlan(execution, plan) {
  return enqueueSave(async () => {
    await mysqlStore.saveExecution(execution);
    await mysqlStore.savePlan(plan);
  });
}

function deletePersistedPlan(id) {
  return enqueueSave(() => mysqlStore.deletePlan(id));
}

async function persistRuntimeConfig() {
  await mysqlStore.saveSetting('mode', config.mode);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendError(res, error) {
  sendJson(res, error.status || 500, {
    ok: false,
    error: error.message || '服务器错误',
    uncertain: Boolean(error.uncertain),
    code: error.code || 'INTERNAL_ERROR',
    planPaused: error.planPaused === true,
    planFailureCount: error.planFailureCount
  });
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100000) throw new BitgetApiError('请求体过大', { status: 413 });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw new BitgetApiError('请求体必须是 JSON', { status: 400 }); }
}

function planName(value) {
  const valueText = String(value || '').trim();
  if (!valueText || valueText.length > 60) {
    throw new BitgetApiError('计划名称不能为空且不能超过 60 个字符', { status: 400 });
  }
  return valueText;
}

function orderAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < config.minOrderUSDT) {
    throw new BitgetApiError('投入金额必须大于等于 ' + config.minOrderUSDT + ' USDT', { status: 400 });
  }
  if (amount > config.maxOrderUSDT) {
    throw new BitgetApiError('单次投入不能超过 ' + config.maxOrderUSDT + ' USDT', { status: 400 });
  }
  return Math.round(amount * 100000000) / 100000000;
}

function failureThreshold(value) {
  const threshold = Number(value);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 20) {
    throw new BitgetApiError('连续失败次数上限必须是 1 到 20 的整数', { status: 400 });
  }
  return threshold;
}

function nextRunAt(time = '09:30') {
  const parts = String(time).split(':').map(Number);
  const date = new Date();
  date.setHours(Number.isFinite(parts[0]) ? parts[0] : 9, Number.isFinite(parts[1]) ? parts[1] : 30, 0, 0);
  if (date <= new Date()) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

function normalizePlan(input) {
  const symbol = normalizeSymbol(input.symbol || input.pair);
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
    throw new BitgetApiError('交易对格式不正确', { status: 400 });
  }
  if (input.direction && input.direction !== 'buy') {
    throw new BitgetApiError('第一版只允许现货买入，卖出规则尚未启用', { status: 400 });
  }
  const time = /^\d{2}:\d{2}$/.test(String(input.time || '')) ? input.time : '09:30';
  return {
    id: input.id || crypto.randomUUID(),
    name: planName(input.name),
    symbol,
    pair: input.pair || symbol,
    amount: orderAmount(input.amount),
    frequency: String(input.frequency || '每天'),
    time,
    direction: 'buy',
    timezone: input.timezone || config.timezone,
    enabled: input.enabled !== false,
    failureCount: Math.max(0, Number.isInteger(Number(input.failureCount)) ? Number(input.failureCount) : 0),
    failureThreshold: failureThreshold(input.failureThreshold ?? 3),
    nextRunAt: input.nextRunAt || nextRunAt(time),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function findPlan(id) {
  return db.plans.find((plan) => plan.id === id);
}

async function symbolRule(symbol) {
  const rows = await bitget.getSymbols(symbol);
  const rule = rows.find((row) => normalizeSymbol(row.symbol) === symbol);
  if (!rule) throw new BitgetApiError('Bitget 未找到交易对 ' + symbol, { status: 400 });
  if (rule.status && rule.status !== 'online') {
    throw new BitgetApiError('交易对 ' + symbol + ' 当前不可交易', { status: 400 });
  }
  return rule;
}

async function executePlan(plan, source = 'manual') {
  if (executingPlans.has(plan.id)) {
    throw new BitgetApiError('该计划正在执行，请等待结果后再操作', { status: 409 });
  }
  executingPlans.add(plan.id);
  try {
    return await executePlanOnce(plan, source);
  } finally {
    executingPlans.delete(plan.id);
  }
}

async function executePlanOnce(plan, source) {
  const scheduledKey = plan.id + ':' + plan.nextRunAt;
  if (source === 'scheduler' && db.executions.some((item) => item.source !== 'manual' && item.scheduledKey === scheduledKey)) {
    return { skipped: true, reason: '该执行任务已经处理过' };
  }

  const base = {
    id: crypto.randomUUID(),
    ...(source === 'scheduler' ? { scheduledKey } : {}),
    planId: plan.id,
    planName: plan.name,
    symbol: plan.symbol,
    direction: 'buy',
    amount: plan.amount,
    source,
    createdAt: new Date().toISOString()
  };

  if (!bitget.isConfigured) {
    throw new BitgetApiError('实盘模式需要配置 Bitget API 密钥', { status: 503, code: 'CONFIG_MISSING' });
  }
  const rule = await symbolRule(plan.symbol);
  const minimum = Number(rule.minOrderAmount ?? rule.minTradeUSDT ?? 0);
  const maximum = Number(rule.maxMarketOrderAmount ?? rule.maxMarketOrderValue ?? 0);
  if (plan.amount < minimum) {
    throw new BitgetApiError('金额低于 ' + plan.symbol + ' 最小交易额 ' + minimum + ' USDT', { status: 400 });
  }
  if (maximum > 0 && plan.amount > maximum) {
    throw new BitgetApiError('金额超过 ' + plan.symbol + ' 市价单上限 ' + maximum + ' USDT', { status: 400 });
  }

  const clientOid = 'orbit-' + base.id.replace(/-/g, '');
  const order = await bitget.placeMarketBuy({ symbol: plan.symbol, quoteAmount: plan.amount, clientOid });
  const execution = {
    ...base,
    status: 'submitted',
    orderId: order && order.orderId,
    clientOid,
    message: 'Bitget 已接受订单，等待成交确认'
  };
  db.executions.unshift(execution);
  if (db.executions.length > 2000) db.executions.length = 2000;
  if (source === 'scheduler') plan.nextRunAt = nextRunAt(plan.time);
  plan.failureCount = 0;
  plan.updatedAt = new Date().toISOString();
  await persistExecutionAndPlan(execution, plan);
  notifyExecution(execution);
  return execution;
}

async function api(req, res, parsed) {
  const pathname = parsed.pathname;
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readJson(req);
    if (!credentialsMatch(body.username, body.password)) {
      throw new BitgetApiError('用户名或密码错误', { status: 401, code: 'AUTH_INVALID' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
    res.setHeader('Set-Cookie', 'orbit_session=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000));
    return sendJson(res, 200, { ok: true, data: { user: AUTH_USER } });
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = parseCookies(req.headers.cookie || '').orbit_session;
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'orbit_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      build: 'market-cache-v6',
      mode: config.mode,
      now: new Date().toISOString(),
      bitget: { configured: bitget.isConfigured, baseUrl: config.baseUrl },
      limits: { minOrderUSDT: config.minOrderUSDT, maxOrderUSDT: config.maxOrderUSDT, timezone: config.timezone }
    });
  }
  if (pathname === '/api/settings/mode' && req.method === 'POST') {
    if (!bitget.isConfigured) throw new BitgetApiError('实盘模式需要先配置 Bitget API 密钥', { status: 400, code: 'CONFIG_MISSING' });
    config.mode = 'live';
    await persistRuntimeConfig();
    return sendJson(res, 200, { ok: true, data: { mode: config.mode } });
  }
  if (pathname === '/api/settings/bitget' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      data: {
        configured: bitget.isConfigured,
        apiKey: maskSecret(bitget.apiKey),
        passphrase: maskSecret(bitget.passphrase)
      }
    });
  }
  if (pathname === '/api/settings/bitget' && req.method === 'POST') {
    const body = await readJson(req);
    const apiKey = String(body.apiKey || '').trim();
    const secretKey = String(body.secretKey || '').trim();
    const passphrase = String(body.passphrase || '').trim();
    if (!apiKey || !secretKey || !passphrase) {
      throw new BitgetApiError('API Key、Secret Key 和 Passphrase 都必须填写', { status: 400 });
    }
    await persistCredentials({ apiKey, secretKey, passphrase, updatedAt: new Date().toISOString() });
    bitget.setCredentials({ apiKey, secretKey, passphrase });
    return sendJson(res, 200, { ok: true, data: { configured: true, apiKey: maskSecret(apiKey), passphrase: maskSecret(passphrase) } });
  }
  if (pathname === '/api/settings/bitget' && req.method === 'DELETE') {
    if (config.mode === 'live') throw new BitgetApiError('实盘模式下不能清除 API 密钥', { status: 409 });
    await mysqlStore.deleteCredentials();
    bitget.setCredentials({});
    return sendJson(res, 200, { ok: true, data: { configured: false } });
  }
  if (pathname === '/api/settings/notifications' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, data: notificationStatus() });
  }
  if (pathname === '/api/settings/notifications' && req.method === 'POST') {
    const body = await readJson(req);
    const botToken = String(body.botToken || notificationSettings.botToken || '').trim();
    const chatId = String(body.chatId || notificationSettings.chatId || '').trim();
    const enabled = body.enabled === undefined ? Boolean(notificationSettings.enabled) : Boolean(body.enabled);
    const notifyFailures = body.notifyFailures !== false;
    if (enabled && (!botToken || !chatId)) {
      throw new BitgetApiError('启用 Telegram 通知前必须填写 Bot Token 和 Chat ID', { status: 400 });
    }
    notificationSettings = { enabled, botToken, chatId, notifyFailures };
    await persistNotificationSettings();
    return sendJson(res, 200, { ok: true, data: notificationStatus() });
  }
  if (pathname === '/api/settings/notifications/test' && req.method === 'POST') {
    if (!notificationSettings.botToken || !notificationSettings.chatId) {
      throw new BitgetApiError('请先保存 Telegram Bot Token 和 Chat ID', { status: 400 });
    }
    await sendTelegramMessage('Orbit DCA 测试通知\nTelegram 通知配置已生效。', { force: true });
    return sendJson(res, 200, { ok: true, data: { sent: true } });
  }
  if (pathname === '/api/markets' && req.method === 'GET') {
    const quoteCoin = (parsed.searchParams.get('quoteCoin') || 'USDT').toUpperCase();
    if (quoteCoin !== 'USDT') return sendJson(res, 200, { ok: true, data: [] });
    const fresh = Boolean(marketCache && marketCache.length);
    const all = marketCache || FALLBACK_MARKETS;
    const search = String(parsed.searchParams.get('search') || parsed.searchParams.get('symbol') || '').trim().toUpperCase();
    const limit = Math.min(Math.max(Number(parsed.searchParams.get('limit') || 80), 1), 100);
    const matches = search
      ? all.filter((row) => String(row.symbol || '').toUpperCase().includes(search) || String(row.baseCoin || '').toUpperCase().includes(search))
      : all;
    const data = matches.slice().sort((a, b) => String(a.baseCoin || a.symbol).localeCompare(String(b.baseCoin || b.symbol))).slice(0, limit);
    refreshMarketCache();
    return sendJson(res, 200, { ok: true, build: 'market-cache-v4', data, total: matches.length, stale: !fresh && all === FALLBACK_MARKETS });
  }
  if (pathname === '/api/tickers' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, data: await bitget.getTickers(parsed.searchParams.get('symbol') || undefined) });
  }
  if (pathname === '/api/account/assets' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, data: await bitget.getAssets(parsed.searchParams.get('coin') || undefined) });
  }
  if (pathname === '/api/plans' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, data: db.plans });
  }
  if (pathname === '/api/plans' && req.method === 'POST') {
    const plan = normalizePlan(await readJson(req));
    db.plans = [plan, ...db.plans.filter((item) => item.id !== plan.id)];
    await persistPlan(plan);
    return sendJson(res, 201, { ok: true, data: plan });
  }
  const planMatch = pathname.match(/^\/api\/plans\/([^/]+)$/);
  if (planMatch && req.method === 'DELETE') {
    const before = db.plans.length;
    db.plans = db.plans.filter((item) => item.id !== planMatch[1]);
    if (db.plans.length === before) throw new BitgetApiError('计划不存在', { status: 404 });
    await deletePersistedPlan(planMatch[1]);
    return sendJson(res, 200, { ok: true, data: { id: planMatch[1], deleted: true } });
  }
  if (planMatch && req.method === 'PATCH') {
    const plan = findPlan(planMatch[1]);
    if (!plan) throw new BitgetApiError('计划不存在', { status: 404 });
    const patch = await readJson(req);
    if (patch.enabled !== undefined) {
      const wasEnabled = plan.enabled;
      plan.enabled = Boolean(patch.enabled);
      if (plan.enabled && !wasEnabled) plan.failureCount = 0;
    }
    if (patch.name !== undefined) plan.name = planName(patch.name);
    if (patch.amount !== undefined) plan.amount = orderAmount(patch.amount);
    if (patch.frequency !== undefined) plan.frequency = String(patch.frequency || plan.frequency);
    if (patch.failureThreshold !== undefined) plan.failureThreshold = failureThreshold(patch.failureThreshold);
    if (patch.time !== undefined) {
      const normalizedTime = String(patch.time || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
      if (!normalizedTime || Number(normalizedTime[1]) > 23 || Number(normalizedTime[2]) > 59) {
        throw new BitgetApiError('执行时间格式不正确', { status: 400 });
      }
      plan.time = String(normalizedTime[1]).padStart(2, '0') + ':' + normalizedTime[2];
      plan.nextRunAt = nextRunAt(plan.time);
    }
    plan.updatedAt = new Date().toISOString();
    await persistPlan(plan);
    return sendJson(res, 200, { ok: true, data: plan });
  }
  const runMatch = pathname.match(/^\/api\/plans\/([^/]+)\/run$/);
  if (runMatch && req.method === 'POST') {
    const plan = findPlan(runMatch[1]);
    if (!plan) throw new BitgetApiError('计划不存在', { status: 404 });
    if (!plan.enabled) throw new BitgetApiError('计划已暂停', { status: 409 });
    let execution;
    try {
      execution = await executePlan(plan, 'manual');
    } catch (error) {
      await notifyFailure(plan, error);
      error.planPaused = !plan.enabled;
      error.planFailureCount = plan.failureCount;
      throw error;
    }
    return sendJson(res, 200, { ok: true, data: { ...execution, nextRunAt: plan.nextRunAt } });
  }
  if (pathname === '/api/executions' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, data: db.executions.slice(0, 200) });
  }
  if (pathname === '/api/orders/preview' && req.method === 'POST') {
    const body = await readJson(req);
    const symbol = normalizeSymbol(body.symbol);
    const amount = orderAmount(body.amount);
    const rule = await symbolRule(symbol);
    return sendJson(res, 200, {
      ok: true,
      data: {
        mode: config.mode,
        symbol,
        amount,
        minTradeUSDT: Number(rule.minOrderAmount ?? rule.minTradeUSDT ?? 0),
        maxMarketOrderValue: Number(rule.maxMarketOrderAmount ?? rule.maxMarketOrderValue ?? 0),
        canSubmit: config.mode === 'live' && bitget.isConfigured
      }
    });
  }
  throw new BitgetApiError('接口不存在', { status: 404 });
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

async function staticFile(res, pathname) {
  const publicFiles = new Set(['/index.html', '/login.html', '/styles.css', '/app.js', '/api-bridge.js']);
  const route = pathname === '/' ? '/index.html' : pathname;
  if (!publicFiles.has(route)) return sendJson(res, 404, { ok: false, error: '文件不存在' });
  const file = path.join(WEB_ROOT, route.slice(1));
  try {
    const content = await fsp.readFile(file);
    const cacheControl = route === '/index.html' ? 'no-store' : 'public, max-age=300';
    res.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cacheControl });
    res.end(content);
  } catch {
    sendJson(res, 404, { ok: false, error: '文件不存在' });
  }
}

await loadDb();
if (HOST !== '127.0.0.1' && HOST !== '::1' && !AUTH_ENABLED) throw new Error('公开监听需要设置登录认证');
const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    if (!authenticated(req, res, parsed)) return;
    if (parsed.pathname.startsWith('/api/')) await api(req, res, parsed);
    else await staticFile(res, parsed.pathname);
  } catch (error) {
    sendError(res, error);
  }
});

server.listen(PORT, HOST, () => {
  console.log('Orbit DCA running at http://' + HOST + ':' + PORT);
  console.log('Build: market-cache-v6; market cache: ' + (marketCache && marketCache.length ? marketCache.length : 'fallback'));
  console.log('Mode: ' + config.mode + '; Bitget keys configured: ' + (bitget.isConfigured ? 'yes' : 'no'));
});

const scheduler = setInterval(async () => {
  for (const plan of db.plans.filter((item) => item.enabled && item.nextRunAt && new Date(item.nextRunAt) <= new Date())) {
    try {
      await executePlan(plan, 'scheduler');
      console.log('Processed plan ' + plan.name + ' in ' + config.mode + ' mode');
    } catch (error) {
      await notifyFailure(plan, error);
      console.error('Plan ' + plan.name + ' failed: ' + error.message);
    }
  }
}, 30000);
scheduler.unref();

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(scheduler);
  server.close();
  try { await saveQueue; if (mysqlStore) await mysqlStore.close(); } finally { process.exit(0); }
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

