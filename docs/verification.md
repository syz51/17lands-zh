# 验证范围

2026-10-22：最初集成版在macOS/Apple M4 Pro使用release服务导入`data-2026-10-18`，包含118773个印刷记录、123019个有中文字的卡面；图片目录完整39页、38941个Oracle代表。它不是全部精确印刷图片集合，数据库不附于仓库。

当时单次全量生产导入94.65秒，最大RSS30720000字节。16路并发、每路100个请求、每请求新TCP连接：单卡p95 1.730ms、100个真实ID批量p95 7.037ms，两组各1600请求且零失败。数据库71127040字节，WAL；服务RSS取样7328至12736 KiB。此为单机热缓存结果，不代表峰值或跨框架比较。可复现客户端在`crates/card-cache/examples/load_probe.rs`。

Chrome真实扩展0.2.0验证了本地API、FRA卡包及已选池、基本地同Oracle中文替代图、中英切换和选牌进入下一抽。停服务、重载扩展后台及刷新页面后，缓存中文图继续显示，弹窗标记离线/旧缓存；恢复服务后重试重新连接。默认原生fetch明确绑定globalThis，避免WorkerGlobalScope的Illegal invocation。

后端测试覆盖独占Writer、WAL并发读取与原子发布、失败回滚、每日状态与重启退避、卡面身份、分页/摘要/归档完整性、HTTP输入及ETag。扩展测试覆盖36项，包括阅读面板生命周期、原生fetch接收者、坏图拒绝与恢复、批处理及持久缓存重建；原生浏览器Worker另验证createImageBitmap和CacheStorage。fixture网络不冒充真实API验收。

独立项目迁移后的检查由本仓库CI运行；live上游枚举不在常规CI中。尚未独立验收Firefox运行、整个Chrome进程重启、全系列/全部背面覆盖及安装故障注入回滚。构建通过不等于这些运行检查已完成。

同日独立迁移验收：新workspace的32项常规Rust测试、fmt、Clippy、Rust 1.88编译检查，以及扩展36项测试/typecheck/双浏览器构建通过。独立公开前审查未发现阻断项；新CLI的macOS LaunchAgent已实际安装，迁移快照保持WAL、revision及118773记录，未到期refresh返回not_due。Chrome从独立目录加载的新扩展已连接新服务，当前卡包和已选池中文可见，弹窗确认14张卡及14张图的持久缓存。

## Docker、远程API与Chrome 0.3.0（2026-10-22）

Dokploy从GitHub main拉取源码构建，Compose单容器部署，通过既有Cloudflare Tunnel及Traefik提供`https://17lands.syzroy.com`。GitHub Check在`b947318`通过全部Rust（Ubuntu/macOS）、扩展及容器构建检查；常规Rust测试34项，扩展37项。镜像构建使用rsproxy下载锁定依赖，APT使用中科大；两个APT阶段耗时4.8s及9.0s，镜像构建成功。

将SQLite Backup API生成的一致快照导入命名卷并核对SHA256；真实容器重建前后ID改变，记录数118773、revision 1、WAL及原刷新时间保持。容器healthy，UID/GID10001、只读根目录、512MiB内存上限、cap_drop=ALL，未发布宿主API端口。公网health/status返回200、ready=true，16次并发卡牌请求全部200；ETag条件读取304，POST返回405。真实查询确认Return to the Light Realms精确中文图，以及Plains保持请求ID并返回同Oracle中文替代图。

Chrome通过原生UI重载远程构建0.3.0，确认权限包含远程HTTPS origin；手机热点的旧DNS空记录经用户重连后恢复。扩展弹窗确认服务已连接、14张远程元数据缓存及27张图片缓存；目视确认真实Mock Draft的卡包、基本地与已选池中文显示。未做新的选牌。随后停止本机LaunchAgent并保留原数据库，统一由远端服务负责刷新。Firefox运行、异地备份恢复与下一次每日刷新仍未进行实测。
