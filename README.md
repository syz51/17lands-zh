# 17Lands 中文卡图

在17Lands Mock Draft、回放和已选牌区域阅读中文卡图。WXT浏览器扩展通过本机Rust服务读取中文资料，SQLite和浏览器持久缓存减少重复下载；保留原站英文卡牌身份与选牌操作。

## 快速开始

需要Rust 1.88或更新版本、Bun，以及Chrome/Edge。服务可前台运行于macOS和Linux；macOS另提供用户LaunchAgent自启动。

```console
git clone https://github.com/syz51/17lands-zh.git
cd 17lands-zh
cargo build --release --locked
./target/release/mtga-card-cache refresh
./target/release/mtga-card-cache serve
```

首次refresh会下载和校验上游全量简体归档、获取中文图片目录，再发布SQLite快照，网络较慢时需要等待。`serve`启动后也会自动检查到期状态；成功后每24小时再检查，失败退避1小时，继续提供旧快照。前台运行的服务保持终端开启。

另开终端构建扩展：

```console
cd 17lands-zh/extensions/17lands-zh
bun install --frozen-lockfile
bun run build
```

在`chrome://extensions`开启开发者模式，选择“加载已解压的扩展程序”，加载`extensions/17lands-zh/.output/chrome-mv3/`。随后刷新17Lands页面；工具栏弹窗应显示“本地服务已连接”。中文默认开启，可随时切回英文或重试。无需17Lands token、Arena日志或账号配置。

## 本机后台服务

macOS可先停止前台serve，再执行：

```console
./target/release/mtga-card-cache install --dry-run
./target/release/mtga-card-cache install
./target/release/mtga-card-cache status
```

安装会复制稳定二进制并注册用户LaunchAgent，登录后自动运行。更新代码并重新release构建后，再次install更新后台二进制；uninstall停止自启动但保留数据。

默认数据位置：macOS为`~/Library/Application Support/17lands-zh/`；Linux为`$XDG_DATA_HOME/17lands-zh/`或`~/.local/share/17lands-zh/`。`--db <路径>`可覆盖数据库位置。手工`refresh --force`前先停止已运行服务，唯一写入锁会拒绝两个同时运行的writer。

## 三层数据

1. **来源层**：从[magic-cards-zhs](https://github.com/HeliumOctahelide/magic-cards-zhs)获取已发布简体归档并验证SHA256，结合[mtgch API v2](https://mtgch.com/api/v2/docs)明确提供的中文图片目录。所有关联使用印刷UUID、Oracle和卡面身份。
2. **本机服务层**：精简Axum/Hyper/Tokio，SQLite WAL单写多读；使用磁盘scratch库准备完整数据后原子发布，HTTP读取不访问上游。固定监听`http://127.0.0.1:17317`，只提供只读API及ETag。
3. **扩展缓存层**：MV3后台批量查询；IndexedDB最多2000项，CacheStorage最多160张/64 MiB。图片经原生解码后才持久化；服务离线时可继续用已有缓存，缺图而有中文字时提供中文阅读面板。

| API | 用途 |
| --- | --- |
| `/healthz` | 服务与SQLite基本健康状态 |
| `/v1/status` | ready、revision、记录数量与刷新日程 |
| `/v1/cards/{printing_id}?lang=zhs` | 单卡中文资料 |
| `/v1/cards?ids=<UUID,...>&lang=zhs` | 最多100卡的批量查询 |

数据schema、并发边界与更新流程见[架构说明](docs/architecture.md)，接口细节见[服务README](crates/card-cache/README.md)，扩展行为见[扩展README](extensions/17lands-zh/README.md)。

## 覆盖与隐私

- 当前导入来源可用的简体资料，不能保证每张牌、每个卡面或完整繁体都有译文。`zht`接口支持不代表全量繁体数据已提供。
- 精确中文图缺失时，可用同Oracle/同卡面的其他中文印刷；插画可能变化，原始请求ID不变。没有中文图或文字时保留英文。
- 服务只监听loopback，不开放网络写接口。扩展只在17Lands运行，不读取Arena日志、token或账号资料，不上传个人选牌历史。
- 上游会收到服务的公开资料请求；图源会收到所加载图片的公开卡牌ID。图片按需下载，不附带全库图片。
- Firefox MV3可构建，但实际运行尚未验收；Safari未提供包装。Chrome验证范围见[验证记录](docs/verification.md)。

## 开发

```console
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
```

扩展目录中运行`bun run typecheck`、`bun test`、`bun run build`和`bun run build:firefox`。默认测试不枚举上游；live测试被显式忽略，避免每次CI触发全量抓取。网络目录请求有上限及有限重试，不重试429。

代码使用[MIT License](LICENSE)。中文资料、卡图和依赖具有各自的权利与许可，详见[NOTICE](NOTICE.md)。本项目与17Lands、mtgch及Wizards of the Coast无隶属关系。

## Docker与远程卡库

提供多阶段`Dockerfile`及供Dokploy使用的`compose.yaml`，SQLite资料使用独立命名卷、单writer、每日检查。默认仍为本机模式；远程模式显式指定Host白名单并通过HTTPS反向代理访问。见[部署与备份说明](docs/deployment.md)及[公开仓库设置检查](docs/open-source-settings.md)。
