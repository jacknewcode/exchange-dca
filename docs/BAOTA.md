# 宝塔面板部署指南

这份指南把 Orbit DCA 部署到宝塔面板管理的 Debian/Ubuntu 服务器上。宝塔只负责面板化管理文件、Nginx、证书和服务；应用仍然使用原生 Node.js，业务数据使用 MySQL 5.7，不需要 Docker。

如果服务器已经按 [原生部署指南](DEPLOYMENT.md) 安装了 Node.js、MySQL 和 systemd 服务，不要重复安装第二套数据库。直接从“添加网站”和“配置 HTTPS”开始即可。

## 1. 准备域名和端口

先在域名服务商添加一条 A 记录，将域名指向服务器公网 IPv4。使用 IPv6 时再添加 AAAA 记录。云服务器安全组和系统防火墙至少放行：

- `80/tcp`：申请证书和 HTTP 跳转；
- `443/tcp`：HTTPS 网站；
- 宝塔面板端口：只允许你的固定管理 IP 访问，端口以安装完成后面板显示的地址为准。

不要把 `3306`（MySQL）或 `8787`（Node.js）开放到公网。应用配置为 `127.0.0.1` 监听，Nginx 在本机反向代理到它。

## 2. 安装宝塔面板

在服务器终端执行宝塔官方文档提供的安装命令。官方命令可能会随发行版调整，执行前请以[宝塔快速安装文档](https://docs.bt.cn/getting-started/quick-installation-of-bt-panel/)显示的内容为准：

```bash
if [ -f /usr/bin/curl ]; then curl -sSO https://download.bt.cn/install/install_panel.sh; else wget -O install_panel.sh https://download.bt.cn/install/install_panel.sh; fi
bash install_panel.sh docscenter
```

安装完成后记录终端显示的面板 URL、用户名和一次性密码，然后在浏览器打开面板。首次登录后立即：

1. 修改面板管理员密码；
2. 在“面板设置”中修改面板端口；
3. 开启面板安全入口或 IP 白名单；
4. 不要把面板账号密码提交到 GitHub。

宝塔安装脚本属于第三方系统管理软件。生产服务器执行前请阅读官方说明，并确认当前系统、磁盘和备份策略符合要求。

## 3. 在宝塔安装运行环境

打开“软件商店”，安装以下组件：

- Nginx；
- Node.js 版本管理器，安装 Node.js 22 或 24 LTS；
- MySQL 5.7（仅在服务器还没有项目数据库时安装）。

项目最低要求为 Node.js 18.17。MySQL 需要 5.7 兼容版本；如果软件商店没有 5.7，请按 [原生部署指南](DEPLOYMENT.md) 使用已经安装好的 MySQL 5.7，不要为了面板按钮直接升级现有生产数据库。

在宝塔“终端”中确认版本：

```bash
node --version
npm --version
mysql --version
```

如果选择项目自带的 systemd 安装脚本，它要求 Node.js 位于 `/usr/bin/node`。宝塔 Node.js 版本管理器安装的 Node.js 路径可能不同；此时要么把系统 Node.js 安装到 `/usr/bin/node`，要么使用宝塔 Node 项目管理器运行应用（见下文），不要让 systemd 和 PM2 同时启动同一个实例。

## 4. 创建 MySQL 数据库

在宝塔“数据库”页面创建数据库 `orbit_dca` 和专用用户 `orbit_dca`，访问权限选择本机。也可以在宝塔终端执行下面的 SQL：

```bash
sudo mysql
```

```sql
CREATE DATABASE orbit_dca CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'orbit_dca'@'127.0.0.1' IDENTIFIED BY '替换为随机长密码';
GRANT ALL PRIVILEGES ON orbit_dca.* TO 'orbit_dca'@'127.0.0.1';
FLUSH PRIVILEGES;
EXIT;
```

如果数据库或用户已经存在，使用 `ALTER USER` 修改密码，不要重复执行 `CREATE`。MySQL 只需要本机监听 `127.0.0.1:3306`，远程管理请使用 SSH 隧道或临时限制来源 IP 的账户。

## 5. 下载项目并配置环境

推荐使用宝塔终端通过 Git 下载。项目目录使用 `/opt/orbit-dca`，与仓库内的部署脚本保持一致：

```bash
sudo git clone https://github.com/jacknewcode/exchange-dca.git /opt/orbit-dca
cd /opt/orbit-dca
sudo npm ci --omit=dev
```

复制配置模板并编辑：

```bash
sudo install -d -m 0750 /etc/orbit-dca
sudo install -m 0600 deploy/environment.example /etc/orbit-dca/environment
sudoedit /etc/orbit-dca/environment
```

至少填写这些值：

```dotenv
HOST=127.0.0.1
PORT=8787
AUTH_USER=admin
AUTH_PASSWORD=替换为随机长登录密码
DEFAULT_TIMEZONE=Asia/Shanghai
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=orbit_dca
MYSQL_USER=orbit_dca
MYSQL_PASSWORD=刚才创建的数据库密码
```

Bitget API 密钥和 Telegram 设置在登录后通过网页填写。它们会存入服务器数据库；不要把真实值写入仓库、截图或工单。

## 6. 启动 Node.js 服务

### 方案 A：systemd（推荐）

如果 `command -v node` 返回 `/usr/bin/node`，使用项目自带脚本安装服务：

```bash
cd /opt/orbit-dca
sudo ./scripts/install-service.sh
sudo systemctl enable --now orbit-dca
sudo systemctl status orbit-dca --no-pager
```

检查本机接口：

```bash
curl -u admin:登录密码 http://127.0.0.1:8787/api/health
```

返回健康状态后再配置网站。应用首次连接 MySQL 时会自动建表，并按项目规则迁移旧 JSON 数据。

### 方案 B：宝塔 Node 项目管理器

如果 Node.js 由宝塔版本管理器提供且不在 `/usr/bin/node`，可以在宝塔 Node 项目管理器中新建项目：

- 项目目录：`/opt/orbit-dca`；
- 启动文件：`server.mjs`；
- 启动命令：`node server.mjs`；
- 监听端口：`8787`；
- 项目名称：`orbit-dca`。

把 `/etc/orbit-dca/environment` 中的变量填写到项目环境变量，或在启动命令中加载同一份配置。使用此方案时不要再执行 `systemctl enable --now orbit-dca`，更新时使用宝塔的“重启项目”或对应的 PM2 命令。

## 7. 在宝塔添加网站和 HTTPS

在“网站 → 添加站点”中填写你的域名，PHP 版本选择“纯静态/无 PHP”，提交后打开站点设置：

1. 进入“反向代理”，新建代理；
2. 目标 URL 填 `http://127.0.0.1:8787`；
3. 保留 `Host`、`X-Real-IP`、`X-Forwarded-For` 和 `X-Forwarded-Proto` 请求头；
4. 保存后访问 `http://你的域名`，确认能看到登录页；
5. 在“SSL → Let's Encrypt”申请证书，打开强制 HTTPS；
6. 确认浏览器访问 `https://你的域名`。

宝塔已经生成 Nginx 站点时，不要再同时运行 `scripts/install-nginx.sh`，两者选一种管理方式。若希望完全使用仓库脚本，也可以跳过宝塔反向代理页面：

```bash
cd /opt/orbit-dca
sudo ./scripts/install-nginx.sh your-domain.example.com
sudo certbot --nginx --redirect -d your-domain.example.com
```

证书申请前必须让域名解析到本机，并放行 80 端口。宝塔申请的证书和仓库脚本申请的证书不要重复覆盖，续期只保留一个管理入口。

## 8. 部署完成后的更新

项目已经提供一键更新脚本。下面命令适用于方案 A（systemd），它会自动备份数据库、拉取 `main`、安装生产依赖、重启服务并检查健康状态：

```bash
cd /opt/orbit-dca
sudo ./scripts/update.sh
```

然后打开网站检查登录、余额同步、计划列表和执行记录。应用启动时会自动执行兼容的数据库建表或迁移逻辑。

如果已经有其他可恢复的数据库备份，可以跳过本次备份：

```bash
sudo ./scripts/update.sh --skip-backup
```

使用方案 B（宝塔 Node 项目管理器/PM2）时也可以使用同一脚本；它会在没有 `orbit-dca.service` 时尝试重启 PM2 项目：

```bash
cd /opt/orbit-dca
sudo ./scripts/update.sh
```

脚本发现工作目录有未提交改动时会停止，避免更新覆盖本地文件。不要让 systemd 和 PM2 同时运行，否则会出现端口占用和重复执行定投；更新前不要执行 `git clean -fdx`，以免删除本地配置、备份或运行数据。

## 9. 更新失败时回滚

先查看服务日志，再回到已知可用的提交：

```bash
sudo journalctl -u orbit-dca -n 100 --no-pager
cd /opt/orbit-dca
sudo git log --oneline -5
sudo git checkout 已知可用的提交号
sudo npm ci --omit=dev
sudo systemctl restart orbit-dca
```

如果数据库已经发生不可逆变更，先停止应用，再使用最近的 `mysqldump` 备份恢复。回滚代码前请确认该版本支持当前数据库结构。

## 10. 常见故障

- **502 Bad Gateway**：Node 服务没有监听 `127.0.0.1:8787`，检查 `systemctl status orbit-dca` 或宝塔 Node 项目日志。
- **域名打不开**：检查 DNS、云安全组、防火墙和宝塔站点的域名绑定；80/443 必须从公网可达。
- **登录页能开但接口失败**：检查 `/etc/orbit-dca/environment` 的 MySQL 配置和日志中的连接错误。
- **更新后端口被占用**：确认只启用了 systemd 或 PM2 其中一种启动方式。
- **证书申请失败**：确认 DNS 已生效、80 端口未被其他服务占用，且站点没有错误的代理规则。

相关官方文档：[宝塔快速安装](https://docs.bt.cn/getting-started/quick-installation-of-bt-panel/)、[Node.js/PM2 部署](https://docs.bt.cn/practical-tutorials/nodejs-pm2-deployment)。
