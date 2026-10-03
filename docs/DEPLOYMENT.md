# 部署指南

## Docker Compose

```bash
cp deploy/docker.env.example .env
# 编辑 .env，填写三个随机密码
docker compose up -d --build
docker compose logs -f app
```

默认网站只发布到 `127.0.0.1:8787`。在服务器上使用 Nginx、Caddy 或 SSH 隧道访问。需要直接通过服务器 IP 访问时设置 `WEB_BIND_ADDRESS=0.0.0.0`，并只在云安全组中向可信来源开放 TCP 8787。MySQL 不发布主机端口，应用通过 Compose 内网访问。

停止应用但保留数据：

```bash
docker compose down
```

删除数据库和应用数据（不可逆，谨慎执行）：

```bash
docker compose down -v
```

## 已有 MySQL + systemd

安装 Node.js 22/24 LTS、Git 和 MySQL 5.7，创建专用数据库用户，然后：

```bash
sudo git clone https://github.com/<你的账号>/orbit-dca.git /opt/orbit-dca
cd /opt/orbit-dca
sudo ./scripts/install-service.sh
sudoedit /etc/orbit-dca/environment
sudo systemctl enable --now orbit-dca
sudo systemctl status orbit-dca --no-pager
```

如果 `/etc/orbit-dca/environment` 还没有创建，安装脚本会复制模板并退出；填写占位密码后再次执行 `sudo ./scripts/install-service.sh`。

查看日志：

```bash
sudo journalctl -u orbit-dca -f
curl -u admin:登录密码 http://127.0.0.1:8787/api/health
```

systemd 服务使用 `/var/lib/orbit-dca` 保存应用数据，服务进程使用动态用户运行。不要手动把 `.env` 复制到 `/opt/orbit-dca`。

## HTTPS 和防火墙

生产环境建议用反向代理终止 HTTPS，并让应用只监听本机：

```text
浏览器 → HTTPS 443 → Nginx/Caddy → 127.0.0.1:8787 → MySQL 127.0.0.1:3306
```

如果直接暴露 8787，必须设置 `AUTH_PASSWORD` 或确保数据库中已有登录认证记录。MySQL 3306 默认不应该开放公网；远程 Navicat 只应临时开放到固定客户端 IP，并使用专用账户。

## 备份和更新

备份数据库（示例）：

```bash
mysqldump --single-transaction --routines --triggers \
  -h 127.0.0.1 -u orbit_dca -p orbit_dca > orbit_dca-$(date +%F).sql
```

更新源码并重启：

```bash
cd /opt/orbit-dca
sudo git pull --ff-only
sudo npm ci --omit=dev
sudo systemctl restart orbit-dca
```

Docker 更新：

```bash
git pull --ff-only
docker compose up -d --build
```

不要使用 `git clean -fdx`，它可能删除本地配置、备份和运行数据。升级 MySQL 或应用前先验证备份可恢复。

## 旧 JSON 迁移

早期版本会在 `data/` 生成 `orbit.json`、`markets.json`、`bitget-credentials.json` 等文件。连接 MySQL 后，程序首次启动会自动导入并将旧文件改为 `.legacy.bak`。确认网页计划、执行记录、密钥和通知设置正常后，再按需删除备份。

## 常见问题

### 页面无法打开

检查 `systemctl status orbit-dca` 或 `docker compose logs app`，确认安全组放行的是网站端口而不是 MySQL 端口。反向代理部署时应用端口通常只需本机可访问。

### 数据库连接失败

确认 `MYSQL_HOST` 在 systemd 中是 `127.0.0.1`、在 Compose 中是 `mysql`；确认 MySQL 用户允许来自对应主机且密码一致。Compose 数据卷已初始化后，修改环境变量不会自动修改数据库密码。

### Bitget 请求失败

运行：

```bash
npm run diagnose:bitget
```

依次检查 DNS、公共交易对接口和私有账户接口。核对 API 是否有读取与现货交易权限、IP 白名单、系统时间和余额。
