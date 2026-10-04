# 配置说明

原生 Node 启动读取项目根目录 `.env`，已存在的进程环境变量优先。生产 systemd 使用 `/etc/orbit-dca/environment`。

## 网站和登录

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Node HTTP 监听地址；直接公网访问使用 `0.0.0.0` |
| `PORT` | `8787` | 网站端口 |
| `AUTH_USER` | `admin` | 首次创建管理员的用户名 |
| `AUTH_PASSWORD` | 空 | 首次创建登录密码；公网监听必须有密码或已有数据库认证 |
| `DEFAULT_TIMEZONE` | `Asia/Shanghai` | 默认计划时区；原生运行也应设置进程 `TZ` 为同一个时区 |
| `DATA_DIR` | 项目 `data/` | 旧 JSON 数据迁移目录；systemd 使用 `/var/lib/orbit-dca` |

首次启动只有在数据库没有认证记录时才使用 `AUTH_USER` / `AUTH_PASSWORD`，密码以随机盐与 scrypt 哈希保存到 `auth_credentials`。数据库失败时不会提前删除初始密码。成功初始化后，Node 原生部署会删除项目 `.env` 中的 `AUTH_PASSWORD`；systemd 外部环境文件由部署者自行管理。配置中的旧密码不会覆盖已有数据库认证。

每次重启会清除内存中的登录会话，需要重新登录。建议用 HTTPS 保护传输中的密码和会话。

## MySQL

| 变量 | 示例 / 默认值 | 用途 |
| --- | --- | --- |
| `MYSQL_HOST` | 必填 | 数据库主机；同机 MySQL 使用 `127.0.0.1` |
| `MYSQL_PORT` | `3306` | 数据库端口 |
| `MYSQL_DATABASE` | `orbit_dca` | 数据库名，只能包含字母、数字、下划线 |
| `MYSQL_USER` | 必填 | 专用数据库用户 |
| `MYSQL_PASSWORD` | 必填 | 数据库用户密码 |
| `MYSQL_CONNECTION_LIMIT` | `10` | 连接池上限 |

专用用户需要对所用数据库建表和读写权限；建议先用管理账户创建数据库，然后仅授权该数据库。不会自动安装 MySQL。

原生 MySQL 的监听、字符集和 `skip-name-resolve` 示例见 `deploy/mysql57.cnf.example`。修改 MySQL 配置后需要执行 `sudo systemctl restart mysql`。

表包括 `plans`、`executions`、`markets`、`bitget_credentials`、`notification_settings`、`auth_credentials` 和 `app_settings`。

## 定投失败处理

每个定投计划都有“连续失败次数上限”，新建计划默认是 3 次，可设置为 1 到 20 次。每次下单失败都会累计连续失败次数，并在开启 Telegram 失败通知时发送失败原因；成功提交一次订单后计数会清零。达到上限后计划会自动暂停，并再发送一条自动暂停通知。修复 API、余额或交易对问题后，在计划列表中恢复计划即可重新开始计数。

## 交易

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `MIN_ORDER_USDT` | `1` | 应用金额下限，交易所交易对可能要求更高 |
| `MAX_ORDER_USDT` | `500` | 单次投入上限 |
| `BITGET_BASE_URL` | `https://api.bitget.com` | Bitget API 地址 |
| `BITGET_LOCALE` | `zh-CN` | Bitget 请求语言 |
| `BITGET_API_KEY` / `BITGET_SECRET_KEY` / `BITGET_PASSPHRASE` | 空 | 可选；推荐在网页管理 |
| `BITGET_CHANNEL_CODE` | 空 | 可选渠道代码 |

网页保存的 MySQL 密钥优先于环境变量密钥。页面只回显掩码，Secret Key 不回传浏览器。数据库内的 Bitget 密钥与 Telegram Token **为明文**，必须保护数据库、备份与服务器访问权限。

运行模式固定 `live`，旧 `TRADING_MODE`、`ALLOW_LIVE_TRADING` 已不起作用。

`ORBIT_ENCRYPTION_KEY` 仅用于解密旧版 AES JSON 迁移文件；没有独立主密钥的旧文件可能依赖旧登录密码哈希，迁移前请保留 `auth.json`。它不改变当前 MySQL 密钥的明文保存方式。

## 可选便携 MySQL 启动器

`scripts/start-mysql57.mjs` 用于已经安装并初始化的 MySQL 二进制，不下载、不安装、不初始化数据库。生产环境推荐让系统的 `mysql.service` 管理 MySQL；这个启动器主要用于本项目旧服务器的便携安装。

| 变量 | 用途 |
| --- | --- |
| `MYSQL57_BASE_DIR` | MySQL 安装目录，包含 `bin/mysqld` |
| `MYSQL57_DATA_DIR` | 已初始化的数据目录 |
| `MYSQL57_RUNTIME_DIR` | socket、PID 和日志目录 |
| `MYSQL_BIND_ADDRESS` | 默认 `127.0.0.1`；仅影响便携启动器的新进程 |

未配置目录时，为兼容旧安装使用项目上两级目录下的 `mysql57`、`mysql57-data`、`mysql57-runtime`。运行身份为 root，仅适用于 Linux 旧安装。更改监听地址后必须重新启动 MySQL；`npm run restart` 只重启应用，不会重启已在运行的数据库。
