# 原生部署指南（Node.js + MySQL 5.7）

项目不依赖 Docker。Node.js 作为 `orbit-dca.service` 运行，MySQL 5.7 作为系统数据库服务运行。

## 1. 安装基础软件

服务器建议使用 Debian/Ubuntu，安装 Node.js 18.17 或更新版本、Git 和 MySQL 5.7。Node.js 建议使用当前 LTS 版本：

```bash
node --version
npm --version
mysql --version
sudo systemctl status mysql --no-pager
```

如果 Node.js 不存在，可以先安装系统包：

```bash
sudo apt update
sudo apt install -y nodejs npm git nginx certbot python3-certbot-nginx
```

请确认 `node --version` 满足项目要求。不同 Debian 版本的软件源可能提供不同 MySQL 版本；需要 MySQL 5.7 时应使用对应的 MySQL 官方软件源或已安装的 MySQL 5.7 服务，不要在生产库上直接用其他大版本替换。

启用 MySQL：

```bash
sudo systemctl enable --now mysql
```

需要固定本机监听和字符集时，可复制项目模板：

```bash
sudo cp deploy/mysql57.cnf.example /etc/mysql/mysql.conf.d/orbit-dca.cnf
sudo systemctl restart mysql
```

## 2. 创建数据库和专用用户

使用管理员连接 MySQL：

```bash
sudo mysql
```

执行下面 SQL，把密码换成随机长密码：

```sql
CREATE DATABASE orbit_dca CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'orbit_dca'@'127.0.0.1' IDENTIFIED BY '替换为数据库密码';
GRANT ALL PRIVILEGES ON orbit_dca.* TO 'orbit_dca'@'127.0.0.1';
FLUSH PRIVILEGES;
EXIT;
```

如果数据库或用户已经存在，不要重复执行 `CREATE`；使用 `ALTER USER` 修改密码，并确认权限：

```sql
ALTER USER 'orbit_dca'@'127.0.0.1' IDENTIFIED BY '新的数据库密码';
GRANT ALL PRIVILEGES ON orbit_dca.* TO 'orbit_dca'@'127.0.0.1';
FLUSH PRIVILEGES;
```

MySQL 只需监听 `127.0.0.1:3306`。远程 Navicat 管理应临时配置限定来源 IP 的账户和安全组规则，不要把 3306 长期开放给所有公网地址。

## 3. 下载并安装 Orbit DCA

```bash
sudo git clone https://github.com/jacknewcode/exchange-dca.git /opt/orbit-dca
cd /opt/orbit-dca
sudo ./scripts/install-service.sh
```

安装脚本会：

- 复制源码到 `/opt/orbit-dca`；
- 使用 `npm ci --omit=dev` 安装生产依赖；
- 安装 `/etc/systemd/system/orbit-dca.service`；
- 首次创建 `/etc/orbit-dca/environment` 模板；
- 不复制项目 `.env`、`data/`、`runtime/` 或旧数据库备份。

第一次运行脚本后先编辑环境文件：

```bash
sudoedit /etc/orbit-dca/environment
```

至少填写：

```dotenv
HOST=127.0.0.1
PORT=8787
AUTH_USER=admin
AUTH_PASSWORD=随机长登录密码
DEFAULT_TIMEZONE=Asia/Shanghai
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=orbit_dca
MYSQL_USER=orbit_dca
MYSQL_PASSWORD=数据库密码
MIN_ORDER_USDT=1
MAX_ORDER_USDT=500
```

然后启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orbit-dca
sudo systemctl status orbit-dca --no-pager
```

如果服务模板仍有 `REPLACE_WITH_` 占位符，安装脚本会拒绝启动，避免网站在没有登录保护的情况下公开监听。

## 4. 验证网站

```bash
curl -u admin:登录密码 http://127.0.0.1:8787/api/health
sudo journalctl -u orbit-dca -n 100 --no-pager
```

浏览器访问：

```text
https://你的域名
```

先把域名的 A/AAAA 记录指向服务器公网 IP。云服务器安全组只放行 TCP 80 和 443；8787 只允许本机访问，MySQL 3306 保持内网或本机访问。

## 5. 首次使用

1. 使用 `AUTH_USER` 和 `AUTH_PASSWORD` 登录。
2. 进入“账户与连接 → 管理 API 密钥”，填写 Bitget API Key、Secret Key、Passphrase。
3. Bitget API 只开启读取和现货交易权限，关闭提现并配置 IP 白名单。
4. 点击“立即同步”确认余额。
5. 创建小额定投计划，检查执行记录。
6. 需要通知时在“系统设置 → 通知设置”填写 Telegram Bot Token 和 Chat ID，先点击测试通知。

应用首次连接数据库时会自动建表。旧版 `data/` 中的 JSON 文件会自动迁移到 MySQL，并改名为 `.legacy.bak`。

## 6. Nginx 域名和 HTTPS

项目提供 Nginx 配置模板，Node 只监听 `127.0.0.1:8787`。域名 DNS 生效后执行：

```bash
cd /opt/orbit-dca
sudo ./scripts/install-nginx.sh your-domain.example.com
sudo certbot --nginx --redirect -d your-domain.example.com
```

Certbot 会申请证书、将 HTTP 跳转到 HTTPS，并配置自动续期。检查续期：`sudo certbot renew --dry-run`。配置模板位于 `deploy/nginx/orbit-dca.conf.example`。

访问链路为：

```text
浏览器 → HTTPS 443 → Nginx → 127.0.0.1:8787 → MySQL 127.0.0.1:3306
```

如果暂时不使用 Nginx，才需要让 Node 监听 `0.0.0.0:8787`；生产环境推荐保持本机监听。

## 7. 备份、更新和回滚

备份数据库：

```bash
mysqldump --single-transaction --routines --triggers \
  -h 127.0.0.1 -u orbit_dca -p orbit_dca > orbit_dca-$(date +%F).sql
```

更新：

```bash
cd /opt/orbit-dca
sudo git pull --ff-only
sudo npm ci --omit=dev
sudo systemctl restart orbit-dca
sudo systemctl status orbit-dca --no-pager
```

不要执行 `git clean -fdx`，它可能删除配置、备份和运行数据。升级前先验证数据库备份可恢复。

## 8. 常见问题

### 服务启动失败

```bash
sudo journalctl -u orbit-dca -n 100 --no-pager
sudo systemctl status mysql --no-pager
```

重点检查 `MYSQL_HOST`、用户、密码和数据库是否正确，以及 Node.js 版本是否满足要求。

### 数据库连接失败

确认 MySQL 正在运行：

```bash
sudo systemctl restart mysql
mysql -h 127.0.0.1 -P 3306 -u orbit_dca -p orbit_dca -e 'SELECT 1;'
```

### Bitget 请求失败

```bash
cd /opt/orbit-dca
npm run diagnose:bitget
```

依次检查 DNS、公共交易对接口、API 权限、IP 白名单、系统时间和账户余额。
