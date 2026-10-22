# 参与贡献

修复问题请提供最小复现；较大的功能或架构变动，先开Issue说明目标、适用场景和取舍。安全问题请按[SECURITY.md](SECURITY.md)私密报告。

从`main`建立分支，使用fork或有权限的功能分支提交PR。main要求PR、全部CI通过、分支与main同步并解决讨论；管理员同样受保护。个人维护阶段不要求另一人的批准。更新PR后不要改写main历史。

## 开发与验证

Rust要求1.88以上，扩展使用Bun及`bun.lock`。遵守[AGENTS.md](AGENTS.md)中的并发、卡牌身份及隐私约束。提交最小相关变更，必要时补充回归测试；依赖变更使用原有包管理器更新锁文件。

CI在Ubuntu执行Rust、扩展和Docker检查；PR触发一次检查，合并到main后再验证。macOS安装器需在实际macOS环境单独验证，Linux CI不覆盖该平台路径。

Rust变更运行：

```console
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

扩展变更在`extensions/17lands-zh`运行：

```console
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun run build:firefox
```

涉及网络地址或权限时，还需按[部署说明](docs/deployment.md)构建远程模式。涉及MV3后台、图片解码、存储或页面行为时，使用真实扩展验证并说明浏览器和结果；fixture或构建成功不能代替运行验收。Docker变更需构建镜像并验证CLI入口；测试默认不抓取上游全量资料，live测试仅在明确需要时运行。

## PR内容与数据

说明问题、修改后的行为、验证结果及尚未验证的范围。不要提交数据库、缓存、归档、原始Arena日志、凭据、个人浏览或选牌历史；不要把真实服务的webhook贴入Issue或日志。公开卡牌UUID可用于最小夹具。

保留17Lands英文身份和原站选牌行为；缺图或同Oracle替代图应如实标记。代码按[MIT](LICENSE)贡献，第三方资料和卡图另见[README的权利说明](README.md#许可与第三方权利)；只提交你有权提供的内容，不复制GPL版17Lands客户端代码。

Dependabot每周检查Cargo、Bun、GitHub Actions及Docker依赖。更新PR仍须人工评估并通过CI，不自动合并或部署。
