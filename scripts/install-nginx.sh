#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请使用 sudo 执行此脚本" >&2
  exit 1
fi
if [[ $# -ne 1 || -z "$1" ]]; then
  echo "用法：sudo ./scripts/install-nginx.sh your-domain.example.com" >&2
  exit 1
fi
DOMAIN="$1"
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ || "$DOMAIN" == *..* || "$DOMAIN" == .* || "$DOMAIN" == *. ]]; then
  echo "域名格式不正确：$DOMAIN" >&2
  exit 1
fi
command -v nginx >/dev/null 2>&1 || { echo "未安装 Nginx，请先执行：apt install nginx" >&2; exit 1; }
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$PROJECT_ROOT/deploy/nginx/orbit-dca.conf.example"
TARGET="/etc/nginx/sites-available/orbit-dca"
install -d -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled
sed "s/orbit\.example\.com/$DOMAIN/g" "$SOURCE" > "$TARGET"
ln -sfn "$TARGET" /etc/nginx/sites-enabled/orbit-dca
nginx -t
systemctl enable nginx
systemctl reload nginx 2>/dev/null || systemctl restart nginx
printf 'Nginx 已配置：%s\n' "$DOMAIN"
printf '下一步：sudo certbot --nginx --redirect -d %s\n' "$DOMAIN"
