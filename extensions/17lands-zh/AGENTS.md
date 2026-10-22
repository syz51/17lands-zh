# 17Lands 中文卡图扩展

此目录按WXT的TypeScript合同开发，使用Bun及现有lockfile；数据服务位于独立Rust workspace。

- 保留原站抽牌行为与英文卡名，只处理卡图展示。
- 中文图源使用mtgch.com；不生成机器译文，不读取token、日志或个人账号资料。
- 修改后运行 `bun run typecheck`、`bun test`、`bun run build`；涉及替换逻辑时验证动态换图、关闭恢复及缺图回退。
