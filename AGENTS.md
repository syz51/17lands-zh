# 开发约定

- Rust负责HTTP服务、SQLite、导入、调度和本机服务安装；WXT扩展遵循TypeScript合同，使用Bun及现有lockfile。
- 保留原站选牌行为、英文身份、卡面方向和来源。不要按卡名猜测印刷或将缺图回退称为完整汉化。
- 服务仅监听loopback；HTTP只读。上游检查及写入只有一个owner，SQLite使用WAL。失败必须保留已发布快照。
- 不提交数据库、缓存、日志、归档、凭据或个人浏览记录。公开卡牌ID可用作测试，所有夹具应与个人活动无关。
- Rust检查：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace --locked`。默认不运行需要上游网络的ignored测试。
- 扩展检查：在`extensions/17lands-zh`执行`bun install --frozen-lockfile`、`bun run typecheck`、`bun test`、`bun run build`、`bun run build:firefox`。
- 原生浏览器API与MV3后台必须经过真实生产入口验证；fixture、DOM控制器与构建通过不能替代扩展运行验收。
