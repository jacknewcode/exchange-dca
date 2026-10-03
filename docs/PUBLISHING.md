# 发布到 GitHub

## 创建仓库

本项目仓库地址是 [jacknewcode/exchange-dca](https://github.com/jacknewcode/exchange-dca)。如果你要发布自己的分支，请创建一个空仓库；不要勾选自动生成 README、License 或 `.gitignore`，本项目已经包含这些文件。

## 发布本地整理好的代码

```bash
cd /path/to/orbit-dca
git init
git add .
git status
```

在 `git status` 中确认没有 `.env`、`data/`、`runtime/`、数据库导出和密钥。然后提交并关联仓库：

```bash
git config user.name "你的 GitHub 名称"
git config user.email "你的 GitHub 邮箱"
git commit -m "Prepare Orbit DCA for public release"
git branch -M main
git remote add origin https://github.com/<账号>/<仓库名>.git
git push -u origin main
```

如果使用 SSH：

```bash
git remote add origin git@github.com:<账号>/<仓库名>.git
git push -u origin main
```

## 发布前检查

```bash
npm ci
npm run check
bash -n scripts/install-service.sh scripts/install-nginx.sh
git ls-files | grep -E '(^|/)(\.env$|.*\.sql$)'
```

最后一条不应输出真实配置或运行数据。`.env.example`、`deploy/environment.example` 和 `deploy/nginx/` 中的密码与域名都应是示例值。

## 账号和历史泄露

如果密钥曾经被 `git add` 或推送过，即使后来删除文件，仍应立即在 Bitget、Telegram、MySQL 和相关账户中轮换凭据；删除提交不等于撤销泄露。公开仓库前检查全部历史：

```bash
git log --all --stat
git grep -n -I -E 'sk-[A-Za-z0-9]|api[_-]?key|bot[0-9]+:' $(git rev-list --all) 2>/dev/null || true
```

## 首个 Release

仓库可见后，建议在 GitHub 设置：

- About 中填写 Bitget DCA、MySQL、Telegram 等主题
- Topics：`bitget`、`dca`、`trading-bot`、`mysql`、`nodejs`
- Issues 模板要求提供版本、部署方式和脱敏日志
- 启用 Dependabot 或定期运行 `npm audit`
- 发布 `v0.2.0` 时在 Release 中说明“固定实盘、MySQL 5.7、Node 18.17+”
