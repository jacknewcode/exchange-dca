import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = {};
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const text = line.trim();
  if (!text || text.startsWith('#')) continue;
  const index = text.indexOf('=');
  if (index < 1) continue;
  env[text.slice(0, index).trim()] = text.slice(index + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
}
const port = Number(env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 不合法');
const expectedMode = 'live';
if ((env.MYSQL_HOST || '127.0.0.1') === '127.0.0.1') {
  const { ensureMysql57 } = await import('./start-mysql57.mjs');
  await ensureMysql57();
}

function listeners() {
  return execFileSync('ss', ['-H', '-ltnp', `sport = :${port}`], { encoding: 'utf8' }).trim();
}
function isProjectProcess(pid) {
  try {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const cwd = fs.realpathSync(`/proc/${pid}/cwd`);
    const executable = path.basename(fs.realpathSync(`/proc/${pid}/exe`));
    return executable.startsWith('node') && args.some((arg) =>
      path.resolve(cwd, arg) === path.join(root, 'server.mjs'));
  } catch {
    return false;
  }
}

const current = listeners();
if (current) {
  const pids = [...new Set([...current.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
  if (!pids.length) throw new Error('看不到占用端口的进程 PID。请在主机 root 终端执行此脚本。');
  if (pids.some((pid) => !isProjectProcess(pid))) {
    throw new Error('端口由其他程序占用，已停止操作；请先检查 ss -ltnp。');
  }
  for (const pid of pids) {
    console.log(`停止 Orbit DCA 进程 ${pid}`);
    process.kill(pid, 'SIGTERM');
  }
  for (let i = 0; i < 40 && listeners(); i++) await pause(250);
  if (listeners()) throw new Error('旧进程未释放端口，未强制终止。');
}

const runtime = path.join(root, 'runtime');
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
const logFile = path.join(runtime, 'server.log');
const log = fs.openSync(logFile, 'a', 0o600);
const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
  cwd: root, detached: true, stdio: ['ignore', log, log],
  env: { ...process.env, ...env, TZ: env.DEFAULT_TIMEZONE || 'Asia/Shanghai' },
});
child.unref();
fs.closeSync(log);
fs.writeFileSync(path.join(runtime, 'server.pid'), String(child.pid), { mode: 0o600 });
const hostname = env.HOST === '::' || env.HOST === '::1' ? '[::1]' :
  (!env.HOST || env.HOST === '0.0.0.0' ? '127.0.0.1' : env.HOST);
for (let i = 0; i < 20; i++) {
  await pause(250);
  try {
    const response = await fetch(`http://${hostname}:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    const health = await response.json();
    if (response.ok && health.ok && health.mode === expectedMode) {
      console.log(`服务已启动，PID=${child.pid}，端口=${port}`);
      console.log(`模式：${health.mode}；密钥：${health.bitget.configured ? '已加载' : '未配置'}`);
      console.log(`日志：${logFile}`);
      process.exit(0);
    }
  } catch {}
}
throw new Error(`启动检查未通过，请查看 ${logFile}`);
