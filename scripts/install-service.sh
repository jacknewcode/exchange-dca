#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="/opt/orbit-dca"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请使用 sudo 执行此脚本" >&2
  exit 1
fi
for tool in npm tar systemctl; do
  command -v "$tool" >/dev/null || { echo "缺少 $tool，请先安装依赖" >&2; exit 1; }
done
if [[ ! -x /usr/bin/node ]]; then
  echo "systemd 需要 /usr/bin/node，请使用系统安装的 Node.js（建议 22/24 LTS）" >&2
  exit 1
fi

install -d -m 0755 "$INSTALL_ROOT" /etc/orbit-dca
# Explicit file list avoids copying .env, .git, runtime state and database backups.
if [[ "$PROJECT_ROOT" != "$INSTALL_ROOT" ]]; then
  tar -C "$PROJECT_ROOT" -cf - server.mjs src web scripts deploy package.json package-lock.json README.md LICENSE .env.example |
    tar -C "$INSTALL_ROOT" -xf -
fi
npm --prefix "$INSTALL_ROOT" ci --omit=dev
install -m 0644 "$PROJECT_ROOT/deploy/orbit-dca.service" /etc/systemd/system/orbit-dca.service

systemctl daemon-reload
if [[ ! -f /etc/orbit-dca/environment ]]; then
  install -m 0600 "$PROJECT_ROOT/deploy/environment.example" /etc/orbit-dca/environment
  echo "已安装服务。请编辑 /etc/orbit-dca/environment，填写登录密码和 MySQL 配置。"
  echo "填写后执行：sudo systemctl enable --now orbit-dca"
  exit 0
fi
if grep -q 'REPLACE_WITH_' /etc/orbit-dca/environment; then
  echo "请先替换 /etc/orbit-dca/environment 中的占位密码，再执行 sudo systemctl enable --now orbit-dca" >&2
  exit 1
fi
systemctl enable orbit-dca.service
systemctl restart orbit-dca.service
systemctl --no-pager --full status orbit-dca.service
