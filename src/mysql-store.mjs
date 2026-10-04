import mysql from 'mysql2/promise';

function identifier(value, label) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_]+$/.test(text)) throw new Error(`${label} 只能包含字母、数字和下划线`);
  return `\`${text}\``;
}

function planFromRow(row) {
  return {
    id: row.id, name: row.name, symbol: row.symbol, pair: row.pair,
    amount: Number(row.amount), frequency: row.frequency, time: row.time,
    direction: row.direction, timezone: row.timezone, enabled: Boolean(row.enabled),
    failureCount: Number(row.failure_count || 0),
    failureThreshold: Number(row.failure_threshold || 3),
    nextRunAt: row.next_run_at || null, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

async function ensureColumn(pool, table, column, definition) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    [table, column]
  );
  if (!Number(rows[0]?.count)) {
    await pool.query(`ALTER TABLE ${identifier(table, 'table')} ADD COLUMN ${identifier(column, 'column')} ${definition}`);
  }
}

function executionFromRow(row) {
  return {
    id: row.id, scheduledKey: row.scheduled_key || undefined, planId: row.plan_id,
    planName: row.plan_name, symbol: row.symbol, direction: row.direction,
    amount: Number(row.amount), source: row.source, status: row.status,
    orderId: row.order_id || undefined, clientOid: row.client_oid || undefined,
    message: row.message || undefined, qty: row.qty == null ? undefined : Number(row.qty),
    filledQuoteAmount: row.filled_quote_amount == null ? undefined : Number(row.filled_quote_amount),
    createdAt: row.created_at
  };
}

export async function createMysqlStore(options) {
  const common = {
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    waitForConnections: true,
    connectionLimit: options.connectionLimit || 10,
    charset: 'utf8mb4'
  };
  const bootstrap = await mysql.createPool(common);
  const database = identifier(options.database, 'MYSQL_DATABASE');
  const [databaseRows] = await bootstrap.query('SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME=?', [options.database]);
  if (!databaseRows.length) await bootstrap.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await bootstrap.end();
  const pool = mysql.createPool({ ...common, database: options.database, dateStrings: true });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS plans (
      id VARCHAR(80) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      symbol VARCHAR(32) NOT NULL,
      pair VARCHAR(64) NOT NULL,
      amount DECIMAL(30,8) NOT NULL,
      frequency VARCHAR(64) NOT NULL,
      time VARCHAR(16) NOT NULL,
      direction VARCHAR(16) NOT NULL,
      timezone VARCHAR(64) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      failure_count INT NOT NULL DEFAULT 0,
      failure_threshold INT NOT NULL DEFAULT 3,
      next_run_at VARCHAR(40) NULL,
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL,
      KEY idx_plans_enabled_next (enabled, next_run_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await ensureColumn(pool, 'plans', 'failure_count', 'INT NOT NULL DEFAULT 0');
  await ensureColumn(pool, 'plans', 'failure_threshold', 'INT NOT NULL DEFAULT 3');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS executions (
      id VARCHAR(80) PRIMARY KEY,
      scheduled_key VARCHAR(180) NULL,
      plan_id VARCHAR(80) NOT NULL,
      plan_name VARCHAR(255) NOT NULL,
      symbol VARCHAR(32) NOT NULL,
      direction VARCHAR(16) NOT NULL,
      amount DECIMAL(30,8) NOT NULL,
      source VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL,
      order_id VARCHAR(160) NULL,
      client_oid VARCHAR(160) NULL,
      message TEXT NULL,
      qty DECIMAL(40,18) NULL,
      filled_quote_amount DECIMAL(30,8) NULL,
      created_at VARCHAR(40) NOT NULL,
      KEY idx_executions_created (created_at),
      KEY idx_executions_schedule (scheduled_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS markets (
      symbol VARCHAR(32) PRIMARY KEY,
      category VARCHAR(16) NOT NULL,
      base_coin VARCHAR(32) NOT NULL,
      quote_coin VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL,
      min_order_amount DECIMAL(30,8) NULL,
      max_market_order_amount DECIMAL(30,8) NULL,
      min_order_qty DECIMAL(40,18) NULL,
      max_order_qty DECIMAL(40,18) NULL,
      price_precision INT NULL,
      quantity_precision INT NULL,
      KEY idx_markets_quote_status (quote_coin, status),
      KEY idx_markets_base (base_coin)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bitget_credentials (
      id TINYINT PRIMARY KEY,
      api_key TEXT NOT NULL,
      secret_key TEXT NOT NULL,
      passphrase TEXT NOT NULL,
      updated_at VARCHAR(40) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_settings (
      id TINYINT PRIMARY KEY,
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      bot_token TEXT NOT NULL,
      chat_id VARCHAR(255) NOT NULL,
      notify_failures TINYINT(1) NOT NULL DEFAULT 1,
      updated_at VARCHAR(40) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_credentials (
      id TINYINT PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      algorithm VARCHAR(32) NOT NULL,
      salt VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      updated_at VARCHAR(40) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(64) PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at VARCHAR(40) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  return {
    async loadState() {
      const [planRows] = await pool.query('SELECT * FROM plans ORDER BY created_at DESC');
      const [executionRows] = await pool.query('SELECT * FROM executions ORDER BY created_at DESC LIMIT 2000');
      const [marketRows] = await pool.query('SELECT * FROM markets ORDER BY base_coin, symbol');
      return { plans: planRows.map(planFromRow), executions: executionRows.map(executionFromRow), markets: marketRows.map((row) => ({
        symbol: row.symbol, category: row.category, baseCoin: row.base_coin, quoteCoin: row.quote_coin,
        status: row.status, minOrderAmount: row.min_order_amount == null ? undefined : Number(row.min_order_amount),
        maxMarketOrderAmount: row.max_market_order_amount == null ? undefined : Number(row.max_market_order_amount),
        minOrderQty: row.min_order_qty == null ? undefined : Number(row.min_order_qty),
        maxOrderQty: row.max_order_qty == null ? undefined : Number(row.max_order_qty),
        pricePrecision: row.price_precision, quantityPrecision: row.quantity_precision
      })) };
    },
    async replaceState(plans, executions) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.query('DELETE FROM executions');
        await connection.query('DELETE FROM plans');
        for (const plan of plans) await connection.query(
          `INSERT INTO plans (id,name,symbol,pair,amount,frequency,time,direction,timezone,enabled,failure_count,failure_threshold,next_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [plan.id, plan.name, plan.symbol, plan.pair || plan.symbol, plan.amount, plan.frequency, plan.time, plan.direction || 'buy', plan.timezone || 'Asia/Shanghai', plan.enabled === false ? 0 : 1, Number(plan.failureCount || 0), Number(plan.failureThreshold || 3), plan.nextRunAt || null, plan.createdAt, plan.updatedAt]
        );
        for (const item of executions) await connection.query(
          `INSERT INTO executions (id,scheduled_key,plan_id,plan_name,symbol,direction,amount,source,status,order_id,client_oid,message,qty,filled_quote_amount,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [item.id, item.scheduledKey || null, item.planId, item.planName, item.symbol, item.direction || 'buy', item.amount, item.source || 'manual', item.status, item.orderId || null, item.clientOid || null, item.message || null, item.qty ?? null, item.filledQuoteAmount ?? null, item.createdAt]
        );
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    },
    async replaceMarkets(rows) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.query('DELETE FROM markets');
        for (const row of rows) await connection.query(
          `INSERT INTO markets (symbol,category,base_coin,quote_coin,status,min_order_amount,max_market_order_amount,min_order_qty,max_order_qty,price_precision,quantity_precision) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [row.symbol, row.category || 'SPOT', row.baseCoin || '', row.quoteCoin || 'USDT', row.status || 'online', row.minOrderAmount ?? row.minTradeUSDT ?? null, row.maxMarketOrderAmount ?? row.maxMarketOrderValue ?? null, row.minOrderQty ?? null, row.maxOrderQty ?? null, row.pricePrecision ?? null, row.quantityPrecision ?? null]
        );
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    },
    async getCredentials() { const [rows] = await pool.query('SELECT * FROM bitget_credentials WHERE id=1'); return rows[0] || null; },
    async saveCredentials(value) { await pool.query(`INSERT INTO bitget_credentials (id,api_key,secret_key,passphrase,updated_at) VALUES (1,?,?,?,?) ON DUPLICATE KEY UPDATE api_key=VALUES(api_key),secret_key=VALUES(secret_key),passphrase=VALUES(passphrase),updated_at=VALUES(updated_at)`, [value.apiKey, value.secretKey, value.passphrase, value.updatedAt]); },
    async deleteCredentials() { await pool.query('DELETE FROM bitget_credentials WHERE id=1'); },
    async getNotifications() { const [rows] = await pool.query('SELECT * FROM notification_settings WHERE id=1'); const row=rows[0]; return row ? { enabled:Boolean(row.enabled), botToken:row.bot_token, chatId:row.chat_id, notifyFailures:Boolean(row.notify_failures), updatedAt:row.updated_at } : null; },
    async saveNotifications(value) { await pool.query(`INSERT INTO notification_settings (id,enabled,bot_token,chat_id,notify_failures,updated_at) VALUES (1,?,?,?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),bot_token=VALUES(bot_token),chat_id=VALUES(chat_id),notify_failures=VALUES(notify_failures),updated_at=VALUES(updated_at)`, [value.enabled ? 1 : 0, value.botToken || '', value.chatId || '', value.notifyFailures === false ? 0 : 1, value.updatedAt]); },
    async getAuth() { const [rows] = await pool.query('SELECT * FROM auth_credentials WHERE id=1'); const row=rows[0]; return row ? { version:1, algorithm:row.algorithm, username:row.username, salt:row.salt, hash:row.password_hash, updatedAt:row.updated_at } : null; },
    async saveAuth(value) { await pool.query(`INSERT INTO auth_credentials (id,username,algorithm,salt,password_hash,updated_at) VALUES (1,?,?,?,?,?) ON DUPLICATE KEY UPDATE username=VALUES(username),algorithm=VALUES(algorithm),salt=VALUES(salt),password_hash=VALUES(password_hash),updated_at=VALUES(updated_at)`, [value.username, value.algorithm, value.salt, value.hash, value.updatedAt]); },
    async getSetting(key) { const [rows] = await pool.query('SELECT setting_value FROM app_settings WHERE setting_key=?', [key]); return rows[0]?.setting_value ?? null; },
    async saveSetting(key, value) { await pool.query(`INSERT INTO app_settings (setting_key,setting_value,updated_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_at=VALUES(updated_at)`, [key, String(value), new Date().toISOString()]); },
    async close() { await pool.end(); }
  };
}
