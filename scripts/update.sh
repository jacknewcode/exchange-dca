#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${ORBIT_DCA_BRANCH:-main}"
ENV_FILE="${ORBIT_DCA_ENV_FILE:-/etc/orbit-dca/environment}"
BACKUP_DIR="${ORBIT_DCA_BACKUP_DIR:-/root/backup/orbit-dca}"
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

backup_database() {
  if [[ "$SKIP_BACKUP" -eq 1 ]]; then
    echo "已跳过数据库备份（--skip-backup）"
    return
  fi
  if [[ ! -r "$ENV_FILE" ]]; then
    echo "未找到 $ENV_FILE，跳过数据库备份。需要备份时请先配置它，或明确使用 --skip-backup。"
    return
  fi
  if ! command -v mysqldump >/dev/null 2>&1; then
    echo "未找到 mysqldump，跳过数据库备份；更新前请确认已有可恢复的备份。"
    return
  fi

  (
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
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
  if [[ -r "$ENV_FILE" ]]; then
    (
      set -a
      # shellcheck disable=SC1090
      . "$ENV_FILE"
      set +a
      printf '%s' "${PORT:-8787}"
    )
  else
    printf '%s' "8787"
  fi
}

restart_service() {
  if command -v systemctl >/dev/null 2>&1 && systemctl cat orbit-dca.service >/dev/null 2>&1; then
    echo "正在重启 systemd 服务 orbit-dca"
    systemctl restart orbit-dca.service
    systemctl is-active --quiet orbit-dca.service || {
      systemctl --no-pager --full status orbit-dca.service >&2 || true
      return 1
    }
    return
  fi

  if command -v pm2 >/dev/null 2>&1 && pm2 describe orbit-dca >/dev/null 2>&1; then
    echo "正在重启 PM2 项目 orbit-dca"
    pm2 restart orbit-dca --update-env
    pm2 save >/dev/null 2>&1 || true
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
