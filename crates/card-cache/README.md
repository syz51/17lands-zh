# 本地中文卡牌缓存服务

独立 Rust workspace 中的 HTTP 服务，包名和可执行文件名均为 `mtga-card-cache`，
固定监听 `http://127.0.0.1:17317`。默认数据库：

- macOS：`~/Library/Application Support/17lands-zh/cards.sqlite`。
- Linux：`$XDG_DATA_HOME/17lands-zh/cards.sqlite`，未设置或非绝对路径时用 `~/.local/share/17lands-zh/cards.sqlite`。
- Windows：`%LOCALAPPDATA%/17lands-zh/cards.sqlite`，未设置时用 `%USERPROFILE%/AppData/Local/17lands-zh/cards.sqlite`。

HTTP 只读，不存在代理、联网查卡或刷新接口。
源下载器与每日刷新运行时已接入；`serve`由单一后台线程检查到期状态并刷新，HTTP读取不访问上游。

```console
cargo build --release --locked -p mtga-card-cache
./target/release/mtga-card-cache serve
./target/release/mtga-card-cache status
./target/release/mtga-card-cache refresh
./target/release/mtga-card-cache import --db ./cards.sqlite fixture.jsonl
```

`--db` 为全局参数，亦可放在子命令之前。`import` 读取每行一个 `model::CardRecord` 的 UTF-8 JSONL；
仅用于明确提供的完整规范化快照，不应将测试卡牌导入日常数据库。

在 workspace 根目录构建后，macOS 可安装为当前登录用户的连续运行服务：

```console
./target/release/mtga-card-cache install --dry-run
./target/release/mtga-card-cache install
./target/release/mtga-card-cache uninstall --dry-run
./target/release/mtga-card-cache uninstall
```

LaunchAgent label 为 `com.seventeenlands-zh.card-cache`，plist 位于 `~/Library/LaunchAgents/`。
稳定可执行文件 `bin/mtga-card-cache`、`server.log`、`server-error.log` 和安装锁均位于上述
`17lands-zh` 用户数据目录；服务不依赖源码目录。安装时可用 `--db` 指定数据库，
相对路径会转换为绝对路径写入 plist；此参数不会移动稳定二进制或日志。
安装前暂存文件并获取生命周期独占锁，更新启动失败会恢复先前文件与服务。
卸载停止服务并删除 plist，保留二进制、数据库及日志。两个 `--dry-run` 只输出 JSON 计划，
不写文件或调用 `launchctl`。其他平台拒绝安装与卸载，可直接运行 `serve`。

## HTTP v1

所有响应包含 `schema_version: 1`。语言为 `zhs`（默认）或 `zht`，不会把简体数据冒充繁体。

- `GET /healthz`：SQLite/schema 可用即 200，空库也健康。
- `GET /v1/status`：`revision, ready, card_count, last_success_at, next_refresh_at, refresh_state, last_error`。
- `GET /v1/cards/{printing_id}?lang=zhs`：`revision, card`；未收录返回结构化 404。
- `GET /v1/cards?ids=<UUID>,<UUID>&lang=zhs`：`revision, cards, missing`，最多 100 个 UUID。

UUID 必须为规范的连字符十六进制格式；接受大写并转小写。拒绝未知或重复查询参数、其他语言、
超过 8192 字节的 URI、任何请求正文和写方法。`HEAD` 与 GET 对应，返回相同表示的响应头。
提供 Host 时必须是 `127.0.0.1:17317`，防止任意域名重绑定访问；不开放跨站 CORS。

响应 ETag 对完整 JSON 表示取 SHA-256，包括内容版本、语言、请求卡牌和缺失项，因此不同批次/语言不会错误地命中。
支持 `If-None-Match` 列表、弱比较和 `*`，未变时返回空正文 304。每次卡牌批量查询在一个 SQLite
读取事务内同时取得版本、所有卡牌及脸面，发布发生在查询期间也不会混用版本。
应用错误为 JSON `{schema_version:1,error:{code,message}}`；读池过载/数据库不可用为 503、
`Retry-After: 1`。在应用收到请求前被 HTTP 解析器拒绝的畸形传输可能由 Hyper 直接返回错误或关闭连接。

`printing_id` 始终是请求的英文印刷 UUID。`oracle_id` 单独存储；`faces` 按 front/back 排序。
每一语言、脸面独立保留中文名称、类型、规则文字、图片与来源。缺失时为 null/`unavailable`，
不会借用另一脸面或另一语言。备用中文图片必须由导入器提供相同 oracle/脸面的证据，显式标为
`alternate` 并提供不同的 `localized_printing_id`；DB 不按名称猜测对应关系。
`source` / `source_url` 为每脸来源，HTTP 不向用户伪装成原版 exact 图片。

## 写入与接入

`Writer::open(path)` 获取 `.sqlite.lock` 生命周期独占文件锁；锁文件不会删除，进程退出由 OS 释放锁。
同一 DB 只允许一个 Writer，第二个服务或导入进程立即失败。数据库启用 WAL、foreign_keys、
2 秒 busy timeout、512 KiB SQLite 页缓存、禁用 mmap、临时结果写磁盘。Reader 使用只读连接与 query_only。

```rust,ignore
let mut writer = Writer::open(path)?;
let revision = writer.publish_snapshot(|sink| {
    provider::download(&mut |card| sink.insert(&card))?;
    Ok(())
})?;
writer.set_source_revision(&verified_release_and_hash)?;
```

`SnapshotSink::insert(&CardRecord)` 同步流式写入，不累积整库。事务提交时原子切换 generation 并删除旧行；
WAL 让已开始的读取继续看到完整旧版本。空快照、下载/解析错误、重复或无效记录均回滚；
即使回调吞掉某次 `insert` 错误，也拒绝发布。导入器必须检查上游完整性/摘要，并将截断或失败传播为 Err。
成功后作非阻塞 passive checkpoint；维护失败不把已提交的数据冒充成失败导入。

`mark_attempt_at` 在导入前持久记录 attempt 与回退时间。`last_attempt_at`、`status` 和
`refresh_due_at` 供运行时使用；成功后 86400 秒内不重复刷新，失败后至少等待 3600 秒。
意外中断的 refreshing 状态在下一次取得写锁时记为 failed。运行时应启动时检查到期时间，
之后在专用 writer OS 线程上等待/刷新；不能在 Tokio worker 上下载或调用 rusqlite。

`source_revision()` 返回当前已发布 generation 的上游身份。完整导入成功后调用
`set_source_revision`；若再次核实身份未变，调用 `mark_source_checked` 更新成功时间与下次检查时间，
不改变内容 generation 或卡牌 `updated_at`。传入不同身份会被拒绝，新发布自动使旧身份失效。

## 并发与内存边界

- Tokio 2 个 runtime worker、最多 4 个 blocking worker；长期刷新应使用另一个 OS 线程。
- 4 个只读连接；最多 32 个在途/排队读请求，读连接排队最多 2 秒。DB 查询和 JSON 序列化都在 blocking worker。
- HTTP/1 最多 32 个连接、32 个请求头、16 KiB 解析缓冲；请求头 10 秒期限，整个连接 60 秒期限。
- 关闭服务时终止连接任务；已经开始的短 blocking 查询会正常结束，SQLite busy timeout 限定锁等待。
- 规范化模型限制每卡最多 4 个语言/脸面项和各字段长度；不会在 HTTP 路径加载全卡集合。

选用精简 feature 的 Axum/Hyper + Tokio，是因为显式传输/任务边界、成熟路由与错误响应组合适合此服务；
这是工程取舍，没有声称跨框架速度或 RSS 排名。2026-10-22 查阅的一手文档：
[Axum features / Tokio+Hyper](https://docs.rs/axum/latest/axum/)、
[Tokio blocking work](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html)、
[tiny_http 同步 recv 与多 worker](https://docs.rs/tiny_http/latest/tiny_http/)、
[Actix HttpServer worker 模型](https://actix.rs/docs/server/)。tiny_http 的同步接口可实现轻量服务，但这里需额外实现
连接/慢客户端边界；Actix 也支持配置 worker，本服务选更直接的现有 Tokio/Hyper 组合。未进行虚构基准对比。

## 验证与测量

`cargo test -p mtga-card-cache --locked` 覆盖 WAL、跨进程独占锁、发布过程并发读取、全有或全无、
吞错拒绝、双语双面映射、备用图身份、SQL 注入输入、状态持久化/重启回退、同源免重写、HTTP JSON 错误、
100/101 批量边界、正文/Host/URL、ETag/304、HEAD、16 路并发全部 200 与真实 TCP 请求。

独立 workspace 的检查命令为 `cargo fmt --all -- --check`、
`cargo clippy --workspace --all-targets --locked -- -D warnings` 与 `cargo test --workspace --locked`。
live 网络测试默认 ignored，常规检查不运行；`examples/load_probe.rs` 为实际 HTTP 客户端。
测量应记录数据库卡数/文件大小、硬件、release build、请求分布、并发数、失败数、p50/p95/p99 与吞吐；
用 `ps -o rss= -p <服务PID>` 测空闲及并发峰值 RSS，分别做单卡、100 卡批次、304、冷/热缓存，
并在后台完整刷新时复测。仅用本地 fixture 的测试耗时不能代表完整库性能或框架间比较。
