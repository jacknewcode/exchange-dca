# Orbit DCA

[![Checks](https://github.com/jacknewcode/exchange-dca/actions/workflows/check.yml/badge.svg)](https://github.com/jacknewcode/exchange-dca/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个可自行部署的 **Bitget 现货定投控制台**，使用 Node.js、原生 HTML/CSS/JavaScript 和 MySQL 5.7。无需前端构建，适配电脑与手机。

**当前版本只运行实盘。** 点击“立即投入”或启用定时计划会向 Bitget 提交真实订单；没有模拟盘。请先配置 API 权限并核对每次投入金额。

## 功能

- 定投计划：新建、修改金额和时间、暂停/恢复、删除、立即投入。
- 账户管理：在网页填写 Bitget API Key、Secret Key 和 Passphrase，同步余额与持仓币种。
- 执行记录：查看订单提交和成交状态、已确认成交的投入统计、导出 CSV。
- Telegram：手动投入和定时执行提交订单后发送通知，可通知执行失败、发送测试消息。
- 登录页面：单管理员账户、会话登录、登录密码使用随机盐和 scrypt 哈希保存。
- MySQL：保存计划、执行记录、交易对缓存、密钥、认证和通知设置，自动创建表并兼容旧 JSON 迁移。

本项目用于个人账户自行部署；每个使用者运行自己的实例和数据库，不是开放注册的多用户交易平台。

## 快速部署（Node.js + MySQL 5.7）

项目不依赖 Docker。直接在服务器安装 Node.js 服务和 MySQL 5.7 服务，Node.js 运行网站，MySQL 保存业务数据。

项目地址：[github.com/jacknewcode/exchange-dca](https://github.com/jacknewcode/exchange-dca)

```bash
sudo apt install -y nodejs npm git nginx certbot python3-certbot-nginx
sudo systemctl enable --now mysql nginx
sudo git clone https://github.com/jacknewcode/exchange-dca.git /opt/orbit-dca
cd /opt/orbit-dca
sudo ./scripts/install-service.sh
sudoedit /etc/orbit-dca/environment
sudo systemctl enable --now orbit-dca
sudo ./scripts/install-nginx.sh your-domain.example.com
sudo certbot --nginx --redirect -d your-domain.example.com
```

完整步骤见 [原生部署指南](docs/DEPLOYMENT.md)。如果使用宝塔面板，参阅[宝塔部署指南](docs/BAOTA.md)。DNS 的 A/AAAA 记录指向服务器后，用 `https://你的域名` 访问。Node.js 只监听本机，MySQL 3306 不需要对公网开放。

> MySQL 5.7.44 是 5.7 的最后一个发行版本。项目按现有兼容需求使用 5.7；新部署请确认发行版是否提供对应的 MySQL 5.7 软件源。[MySQL 官方说明](https://dev.mysql.com/doc/relnotes/mysql/5.7/en/news-5-7-44.html)

## 本地开发

建议使用 [Node.js 22 或 24 LTS](https://nodejs.org/en/about/previous-releases)。代码最低要求为 Node.js 18.17，旧版本不再推荐用于新部署。

```bash
npm ci
cp .env.example .env
```

填写登录密码与 MySQL 连接信息，确保数据库和专用用户存在；应用会自动建表：

```dotenv
AUTH_USER=admin
AUTH_PASSWORD=替换为登录密码
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=orbit_dca
MYSQL_USER=orbit_dca
MYSQL_PASSWORD=替换为数据库密码
```

```bash
npm run check
npm start
```

默认打开 **http://127.0.0.1:8787**。 Linux 后台运行可用 `npm run restart`；开机自启请使用 systemd。

## 首次使用

1. 登录后进入“账户与连接 → 管理 API 密钥”，填写 Bitget 的三项凭据。
2. 在 Bitget 为 API 开启读取和现货交易权限，关闭提现权限，按需设置服务器出口 IP 白名单。
3. 点击“立即同步”，确认账户余额和持仓。
4. 新建一个“每天”执行的小额计划。应用允许金额最低为 1 USDT，但实际下单还必须满足该交易对的最低订单金额。
5. 需要 Telegram 通知时，在“系统设置 → 通知设置”填写 Bot Token、Chat ID 并保存，再点击“测试通知”。先与机器人发起聊天，群组则需把机器人加入群。
6. 点击“立即投入”后，检查执行记录和 Bitget 订单。订单“已提交”不等于“已成交”，统计只计入已确认成交的金额。

## 文档

- [完整部署指南](docs/DEPLOYMENT.md)：Node.js、MySQL 5.7、systemd、HTTPS、更新、备份和常见故障。
- [宝塔面板部署](docs/BAOTA.md)：宝塔安装、Node.js/MySQL/Nginx、域名 HTTPS、更新和回滚。
- [配置说明](docs/CONFIGURATION.md)：环境变量、密钥保存方式和数据目录。
- [GitHub 发布指南](docs/PUBLISHING.md)：如何上传仓库、排除私人数据并发布版本。
- [贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md) · [MIT 许可证](LICENSE)

## 当前限制

- 仅支持 Bitget 现货 USDT 计价的市价买入；不支持卖出、合约、其他交易所。
- 当前后端排期按每天的时分计算。页面的周/月频率、限价单和错过执行偏好尚未完整接入后端，生产计划请使用“每天”和市价单。
- 同一数据库只运行一个应用实例。定时任务和执行锁在进程内，不支持多实例并行调度。
- 当前只保留最近最多 2,000 条执行记录；历史数据需定期导出、备份。
- Telegram 通知异步发送，发送失败记入服务日志，尚无持久队列或自动重试。不能把 Telegram 作为订单是否成功的唯一依据。
- Bitget 密钥与 Telegram Token 按当前设计保存在服务器 MySQL 中的明文字段；仅登录密码使用哈希。访问数据库等同于访问这些凭据。

## 目录

```text
server.mjs             HTTP API、认证、定时任务、JSON 迁移
src/bitget-client.mjs  Bitget API 客户端
src/mysql-store.mjs    MySQL 表和存储操作
web/                   网站静态页面、样式和交互
scripts/               检查、重启、诊断、服务安装
deploy/                部署配置、Nginx 和 systemd 服务
docs/                   详细说明
data/                   旧数据迁移目录（不提交）
runtime/                后台脚本日志和 PID（不提交）
```

项目源码使用 MIT License，允许使用、修改和分发；请保留许可证。项目与 Bitget 无官方关联，不提供收益保证。
