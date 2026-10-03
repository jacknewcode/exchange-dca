# 贡献指南

欢迎通过 Issue 报告问题，通过 Pull Request 提交修改。

1. Fork 或下载仓库，运行 `npm ci`。
2. 复制 `.env.example` 为 `.env`，使用独立开发数据库。
3. 修改代码后执行 `npm run check` 和 `bash -n scripts/install-service.sh`。
4. 说明问题、修改后的行为、验证方法和数据库兼容性。

此项目固定实盘交易。测试时使用未配置交易密钥的独立实例，禁止自动测试真实下单。不要向提交、日志或截图写入真实密钥、密码和私人订单。

前端无需构建。后端入口为 `server.mjs`，数据库实现为 `src/mysql-store.mjs`，Bitget 客户端为 `src/bitget-client.mjs`。
