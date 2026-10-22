# 开发约定

- Rust负责HTTP服务、SQLite、导入、调度和本机服务安装；WXT扩展遵循TypeScript合同，使用Bun及现有lockfile。
- 保留原站选牌行为、英文身份、卡面方向和来源。不要按卡名猜测印刷或将缺图回退称为完整汉化。
- 服务默认监听loopback；容器反向代理部署须显式指定listen与Host白名单，不发布宿主端口。HTTP只读。上游检查及写入只有一个owner，SQLite使用WAL。失败必须保留已发布快照。
- 不提交数据库、缓存、日志、归档、凭据或个人浏览记录。公开卡牌ID可用作测试，所有夹具应与个人活动无关。
- 公开文档只保留使用、开发、架构、部署及项目政策；个人运维、仓库设置审计、单机测量和会话验收记录保存在私有知识库，不放入本仓库。
- 提交与合并遵循[CONTRIBUTING.md](CONTRIBUTING.md)，通过PR及当前提交的CI，不绕过main保护。CI仅在Linux运行；收到旧提交的失败通知时，先核对SHA与PR当前状态，不因过期通知重复修改或重跑。
- 部署、数据库变更、备份与恢复遵循[部署说明](docs/deployment.md)，保留单writer及持久卷；在线备份使用SQLite一致性快照，恢复先停止writer，不删除数据卷。验收同时检查`/healthz`与`/v1/status`的数据就绪状态，不能仅凭进程健康宣称卡库可用。
- 修改依赖、配置或用户可见行为时，同步相关README；第三方权利说明统一维护在[主README](README.md#许可与第三方权利)，依赖变化时核对开源致谢。
- Rust检查：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace --locked`。默认不运行需要上游网络的ignored测试。
- 扩展检查：在`extensions/17lands-zh`执行`bun install --frozen-lockfile`、`bun run typecheck`、`bun test`、`bun run build`、`bun run build:firefox`。
- 原生浏览器API与MV3后台必须经过真实生产入口验证；fixture、DOM控制器与构建通过不能替代扩展运行验收。
