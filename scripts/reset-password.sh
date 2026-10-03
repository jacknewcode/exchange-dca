#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PM2_USER="${ORBIT_DCA_PM2_USER:-}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请使用 sudo 执行此脚本" >&2
  exit 1
fi

NODE_BIN="${ORBIT_DCA_NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  for candidate in /usr/bin/node /usr/local/bin/node /www/server/nodejs/*/bin/node; do
    if [[ -x "$candidate" ]]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "找不到 Node.js，请先安装 Node.js" >&2
  exit 1
fi

read -r -p "用户名 [admin]: " username
username="${username:-admin}"
read -r -s -p "新密码（至少 8 个字符）: " password
printf '\n'
read -r -s -p "再次输入新密码: " confirm
printf '\n'
if [[ "$password" != "$confirm" ]]; then
  echo "两次输入的密码不一致" >&2
  exit 1
fi

CONFIG_FILE="${ORBIT_CONFIG_FILE:-}"
if [[ -z "$CONFIG_FILE" ]]; then
  if [[ -r "$PROJECT_ROOT/.env" ]]; then CONFIG_FILE="$PROJECT_ROOT/.env"; else CONFIG_FILE="/etc/orbit-dca/environment"; fi
fi

if ! printf '%s\n%s\n' "$username" "$password" | ORBIT_CONFIG_FILE="$CONFIG_FILE" "$NODE_BIN" "$PROJECT_ROOT/scripts/reset-password.mjs"; then
  unset password confirm
  exit 1
fi
unset password confirm

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet orbit-dca.service; then
  systemctl restart orbit-dca.service
  echo "已重启 systemd 服务 orbit-dca"
  exit 0
fi

if [[ -z "$PM2_USER" ]]; then
  PM2_USER="$(ps -eo user=,args= 2>/dev/null | awk '$0 ~ /\/opt\/orbit-dca\/server\.mjs/ {print $1; exit}')"
  PM2_USER="${PM2_USER:-www}"
fi
if id "$PM2_USER" >/dev/null 2>&1; then
  PM2_BIN="${ORBIT_DCA_PM2_BIN:-}"
  if [[ -z "$PM2_BIN" ]] && command -v pm2 >/dev/null 2>&1; then PM2_BIN="$(command -v pm2)"; fi
  if [[ -z "$PM2_BIN" ]]; then
    for candidate in /www/server/nodejs/*/bin/pm2 /usr/local/bin/pm2 /usr/bin/pm2; do
      if [[ -x "$candidate" ]]; then PM2_BIN="$candidate"; break; fi
    done
  fi
  if [[ -n "$PM2_BIN" ]]; then
    PM2_DIR="$(dirname "$PM2_BIN")"
    PM2_HOME="${ORBIT_DCA_PM2_HOME:-$(getent passwd "$PM2_USER" | cut -d: -f6)/.pm2}"
    if sudo -u "$PM2_USER" -H env "PATH=$PM2_DIR:$PATH" "PM2_HOME=$PM2_HOME" "$PM2_BIN" describe orbit-dca >/dev/null 2>&1; then
      sudo -u "$PM2_USER" -H env "PATH=$PM2_DIR:$PATH" "PM2_HOME=$PM2_HOME" "$PM2_BIN" restart orbit-dca --update-env
      echo "已重启 PM2 项目 orbit-dca"
      exit 0
    fi
  fi
fi

echo "密码已重置，请在宝塔 Node 项目中点击重启 orbit-dca。"
