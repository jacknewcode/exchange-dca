#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${ORBIT_DCA_BRANCH:-main}"
ENV_FILE="${ORBIT_DCA_ENV_FILE:-/etc/orbit-dca/environment}"
BACKUP_DIR="${ORBIT_DCA_BACKUP_DIR:-/root/backup/orbit-dca}"
PM2_USER="${ORBIT_DCA_PM2_USER:-}"
PM2_HOME_OVERRIDE="${ORBIT_DCA_PM2_HOME:-}"
SKIP_BACKUP=0

usage() {
  cat <<'EOF'
用法：sudo ./scripts/update.sh [--skip-backup]

默认会备份 MySQL、拉取 main 分支、安装生产依赖并重启 Orbit DCA。
仅在已经确认有其他有效备份时使用 --skip-backup。
EOF
}

for arg in "$@"; do
  case "$arg" in
    --skip-backup) SKIP_BACKUP=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请使用 sudo 执行此脚本" >&2
  exit 1
fi

# 宝塔 Node.js 版本管理器通常不会把 node/npm 放进 root 的默认 PATH。
# 优先使用显式路径，其次寻找系统 Node.js，再寻找宝塔安装的版本。
NODE_BIN_DIR="${ORBIT_DCA_NODE_BIN_DIR:-}"
if [[ -z "$NODE_BIN_DIR" ]]; then
  for node_binary in /usr/bin/node /usr/local/bin/node /www/server/nodejs/*/bin/node; do
    if [[ -x "$node_binary" ]]; then
      NODE_BIN_DIR="$(dirname "$node_binary")"
      break
    fi
  done
fi
if [[ -n "$NODE_BIN_DIR" ]]; then
  export PATH="$NODE_BIN_DIR:$PATH"
fi

for tool in git npm; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "缺少 $tool，请先安装依赖" >&2
    exit 1
  }
done

if [[ ! -d "$PROJECT_ROOT/.git" ]]; then
  echo "不是 Git 仓库：$PROJECT_ROOT" >&2
  exit 1
fi

cd "$PROJECT_ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "工作目录有未提交或未跟踪文件，已停止更新：" >&2
  git status --short >&2
  echo "请先提交、备份或清理这些文件，再重新执行。" >&2
  exit 1
fi

config_file() {
  if [[ -r "$PROJECT_ROOT/.env" ]]; then
    printf '%s' "$PROJECT_ROOT/.env"
  elif [[ -r "$ENV_FILE" ]]; then
    printf '%s' "$ENV_FILE"
  fi
}

backup_database() {
  if [[ "$SKIP_BACKUP" -eq 1 ]]; then
    echo "已跳过数据库备份（--skip-backup）"
    return
  fi
  local config
  config="$(config_file)"
  if [[ -z "$config" ]]; then
    echo "未找到项目 .env 或 $ENV_FILE，跳过数据库备份。需要备份时请先配置它，或明确使用 --skip-backup。"
    return
  fi
  if ! command -v mysqldump >/dev/null 2>&1; then
    echo "未找到 mysqldump，跳过数据库备份；更新前请确认已有可恢复的备份。"
    return
  fi

  (
    set -a
    # shellcheck disable=SC1090
    . "$config"
    set +a

    db_host="${MYSQL_HOST:-127.0.0.1}"
    db_port="${MYSQL_PORT:-3306}"
    db_name="${MYSQL_DATABASE:-orbit_dca}"
    db_user="${MYSQL_USER:-orbit_dca}"
    db_password="${MYSQL_PASSWORD:-}"
    backup_file="$BACKUP_DIR/orbit_dca-$(date +%F-%H%M%S).sql"

    install -d -m 0700 "$BACKUP_DIR"
    echo "正在备份数据库到 $backup_file"
    MYSQL_PWD="$db_password" mysqldump \
      --single-transaction --routines --triggers \
      --host="$db_host" --port="$db_port" --user="$db_user" \
      "$db_name" > "$backup_file"
    chmod 0600 "$backup_file"
    echo "数据库备份完成"
  )
}

read_port() {
  local config
  config="$(config_file)"
  if [[ -n "$config" ]]; then
    (
      set -a
      # shellcheck disable=SC1090
      . "$config"
      set +a
      printf '%s' "${PORT:-8787}"
    )
  else
    printf '%s' "8787"
  fi
}

pm2_binary() {
  if [[ -n "${ORBIT_DCA_PM2_BIN:-}" && -x "$ORBIT_DCA_PM2_BIN" ]]; then
    printf '%s' "$ORBIT_DCA_PM2_BIN"
    return
  fi
  if command -v pm2 >/dev/null 2>&1; then
    command -v pm2
    return
  fi
  for candidate in /www/server/nodejs/*/bin/pm2 /usr/local/bin/pm2 /usr/bin/pm2; do
    if [[ -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return
    fi
  done
}

detect_pm2_user() {
  if [[ -n "$PM2_USER" ]]; then
    return
  fi
  PM2_USER="$(ps -eo user=,args= 2>/dev/null | awk '$0 ~ /\/opt\/orbit-dca\/server\.mjs/ {print $1; exit}')"
  PM2_USER="${PM2_USER:-www}"
}

restart_pm2() {
  detect_pm2_user
  if ! id "$PM2_USER" >/dev/null 2>&1; then
    echo "找不到 PM2 运行用户：$PM2_USER" >&2
    return 1
  fi

  local pm2
  pm2="$(pm2_binary)"
  if [[ -z "$pm2" ]]; then
    return 1
  fi
  local pm2_dir
  pm2_dir="$(dirname "$pm2")"
  local pm2_home
  if [[ -n "$PM2_HOME_OVERRIDE" ]]; then
    pm2_home="$PM2_HOME_OVERRIDE"
  else
    pm2_home="$(getent passwd "$PM2_USER" | cut -d: -f6)/.pm2"
  fi
  local pm2_env=(PATH="$pm2_dir:$PATH" PM2_HOME="$pm2_home")
  if ! sudo -u "$PM2_USER" -H env "${pm2_env[@]}" "$pm2" describe orbit-dca >/dev/null 2>&1; then
    return 1
  fi
  echo "正在以 $PM2_USER 用户重启 PM2 项目 orbit-dca"
  sudo -u "$PM2_USER" -H env "${pm2_env[@]}" "$pm2" restart orbit-dca --update-env
  sudo -u "$PM2_USER" -H env "${pm2_env[@]}" "$pm2" save >/dev/null 2>&1 || true
}

restart_service() {
  if command -v systemctl >/dev/null 2>&1 && systemctl cat orbit-dca.service >/dev/null 2>&1 && systemctl is-active --quiet orbit-dca.service; then
    echo "正在重启 systemd 服务 orbit-dca"
    systemctl restart orbit-dca.service
    systemctl is-active --quiet orbit-dca.service || {
      systemctl --no-pager --full status orbit-dca.service >&2 || true
      return 1
    }
    return
  fi

  if restart_pm2; then
    return
  fi

  if command -v systemctl >/dev/null 2>&1 && systemctl cat orbit-dca.service >/dev/null 2>&1; then
    echo "正在启动 systemd 服务 orbit-dca"
    systemctl restart orbit-dca.service
    systemctl is-active --quiet orbit-dca.service || return 1
    return
  fi

  echo "代码已更新，但没有找到 orbit-dca 的 systemd 或 PM2 服务。请在面板中手动重启项目。" >&2
  return 1
}

check_health() {
  command -v curl >/dev/null 2>&1 || {
    echo "未安装 curl，跳过健康检查"
    return
  }
  local port
  port="$(read_port)"
  for _ in {1..15}; do
    if curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${port}/api/health" >/dev/null; then
      echo "健康检查通过：http://127.0.0.1:${port}/api/health"
      return
    fi
    sleep 1
  done
  echo "健康检查未通过，请查看服务日志。" >&2
  return 1
}

echo "更新 Orbit DCA：$PROJECT_ROOT（分支：$BRANCH）"
backup_database
git fetch origin "$BRANCH"
git pull --ff-only origin "$BRANCH"
npm ci --omit=dev
restart_service
check_health

if command -v systemctl >/dev/null 2>&1 && systemctl cat orbit-dca.service >/dev/null 2>&1; then
  systemctl --no-pager --full status orbit-dca.service | sed -n '1,14p'
fi
echo "Orbit DCA 更新完成"
