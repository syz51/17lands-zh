# 隐式状态机清单

本文列出代码中没有用具名类型、状态表或集中检查表达的状态集合：状态、迁移、迁移的约束位置及已知缺口。行号对应本文提交时的代码；修改这些文件时请同步更新。数据模型与并发边界见[架构说明](architecture.md)。

缺口的结论只有三种，且都来自探针或测试，不来自阅读代码：

- **已确认**：探针复现，尚未修复。
- **设计如此**：有测试或文档固定该行为。
- **已排除**：探针表明问题不存在。

路径前缀：`rs/` = `crates/card-cache/src/`，`rs-tests/` = `crates/card-cache/tests/`，`ext/` = `extensions/17lands-zh/src/`，`ext-tests/` = `extensions/17lands-zh/tests/`，`entry/` = `extensions/17lands-zh/entrypoints/`。

## Rust服务

### R1 刷新状态 `cache_state.refresh_state`

- 状态：`idle`、`refreshing`、`failed`，外加`next_check_at`日程（成功后24小时，失败后1小时，`rs/db.rs:11-12`）。
- 迁移：到期判断`rs/db.rs:89-94`；联网前写入`refreshing`及下次重试`rs/db.rs:95-98`、`rs/runtime.rs:129`；数据未变回到`idle` `rs/db.rs:112-119`；发布成功`rs/db.rs:173-222`；失败`rs/db.rs:120-127`、`rs/runtime.rs:173-175`；进程重启把遗留的`refreshing`改为`failed` `rs/db.rs:83`。
- 缺口：
  - 进程中断后状态停在`refreshing`。**设计如此**：重开时修复，测试`rs-tests/cache.rs` `persistent_daily_schedule_backoff_and_interrupted_attempt`。
  - 记录失败的写入本身失败时，`?`返回写入错误，原始刷新错误丢失，状态仍为`refreshing`（`rs/runtime.rs:173-175`、`rs/db.rs:168-170`）。**已确认**（故障注入探针）。
  - 刷新线程panic后无人接管：进程存活、`/healthz`正常、状态停在`refreshing`且不再刷新（`rs/runtime.rs:182-201`，句柄未使用`rs/main.rs:136`）。**已确认**（故障注入探针）。返回错误的路径正常：状态`failed`、循环继续，测试`rs-tests/refresh_pipeline.rs` `writer_retains_previous_good_revision_when_source_fails`。

### R2 磁盘上的归档缓存 `upstream/`

- 状态：无文件、暂存文件（`.tmp*`）、以SHA256命名的完整归档、被淘汰。
- 迁移：命中校验`rs/runtime.rs:30-49, 66`；暂存`rs/runtime.rs:69`；下载或复制`rs/runtime.rs:70-103`；二次校验后改名`rs/runtime.rs:104-110`；发布成功后淘汰其他64位十六进制命名的归档`rs/runtime.rs:154-165`。
- 缺口：下载中被杀死时暂存文件留在目录中，淘汰规则不匹配它（单个上限256 MiB）。**已确认**（探针）。校验失败等错误路径不留文件；内容被改写时不复用，单元测试`archive_cache_reuses_only_complete_matching_content`（`rs/runtime.rs:207`）。

### R3 图片目录分页协议

- 状态：期望页码、累计条数、目录身份（总数与修订）。
- 迁移与约束：页序`rs/refresh.rs:704-707`；分页边界`rs/refresh.rs:708-714`；跨页一致性`rs/refresh.rs:715-725`；完整性`rs/refresh.rs:731-738`；重复ID`rs/refresh.rs:739-743`；发出前的完整性`rs/refresh.rs:809-813`。
- 缺口：未发现。测试`rs-tests/refresh_pipeline.rs` `incomplete_or_inconsistent_catalog_never_emits`、`truncated_malformed_and_duplicate_sources_never_emit`、`live_catalog_changes_revision_and_sink_errors_propagate`。

### R4 上游请求的重试与预算

- 状态：尝试次数（最多3次）、总预算（20分钟）、最小请求间隔（1100毫秒）。
- 迁移：`rs/refresh.rs:135-180`（可重试错误集合`162-169`）；响应体重试`rs/refresh.rs:181-200`；归档下载超时`rs/runtime.rs:77-83`。
- 缺口：未发现；每个等待都有上限。

### R5 Writer进程锁

- 状态：未持有、持有。
- 迁移：打开时取得独占文件锁`rs/db.rs:61-71`，释放随句柄销毁。
- 缺口：两个writer。**设计如此**：测试`rs-tests/cache.rs` `writer_lock_is_exclusive_across_processes_and_released_on_drop`。

### R6 快照发布与`SnapshotSink.poisoned`

- 状态：写入中、已污染（某次插入失败）、已提交、已回滚。
- 迁移：`rs/db.rs:162-222`；污染标记`rs/db.rs:229-237`。
- 缺口：调用方吞掉插入错误后仍提交。**设计如此**：污染的快照不发布，测试`empty_failed_and_swallowed_insert_errors_never_publish`、`concurrent_publication_provides_complete_old_or_new_batches`。

### R7 `source_state`与`cache_state`的一致

- 状态：同一事实（当前generation及其来源）保存在两张表。
- 迁移：两者只在发布事务内一起改变`rs/db.rs:173-222`；数据未变时只更新检查时间`rs/db.rs:112-119`。
- 缺口：两处不一致。**设计如此**：测试`source_write_failure_rolls_back_generation_and_success_metadata`、`source_snapshot_and_cards_survive_reopen_together`、`failed_source_publications_keep_previous_cards_and_source`、`unchanged_source_check_persists_freshness_without_generation_rewrite`。

### R8 只读连接池的借出

- 状态：请求许可、读许可（等待上限2秒）、连接已借出、已归还。
- 迁移：`rs/http.rs:55-92`（借出`70`，归还`81`）；池大小4（`rs/http.rs:29`）。
- 缺口：读闭包panic时连接不归还，4次后所有请求（含`/healthz`）返回503。**已确认**（故障注入探针；当前读路径没有已知panic点，属潜在缺陷）。正常并发见测试`rs-tests/http.rs` `sixteen_simultaneous_normal_requests_all_succeed`。

### R9 HTTP连接生命周期

- 状态：已接受、读请求头（10秒）、服务中（连接60秒期限）、关闭。
- 迁移：`rs/http.rs:347-381`（连接信号量`352`，期限`370-373`，停止时中止任务`378-379`）。
- 缺口：未发现。测试`real_http_socket_uses_bounded_transport_and_can_shutdown`。

### R10 进程停止

- 状态：运行、收到信号、优雅停止。
- 迁移：只等待`ctrl_c()`（`rs/main.rs:138-140`）。
- 缺口：SIGTERM没有处理路径；SIGINT正常退出。容器内进程为PID 1且无init（`Dockerfile`），停止要等到宽限期结束（`compose.yaml`的`stop_grace_period`）。**已确认**（探针；容器场景未实测）。

### R11 LaunchAgent安装事务

- 状态：暂存新文件、备份旧文件、任务已卸载、文件已替换、任务已加载、回滚。
- 迁移：`rs/install.rs:179-233`；安装锁`rs/install.rs:141-153`。
- 缺口：
  - 失败后的回滚。**设计如此**：单元测试`update_rolls_back_files_permissions_and_previous_job`、`first_install_failure_removes_new_files`、`lifecycle_lock_and_staging_failures_leave_running_job_untouched`。
  - 卸载与加载之间被杀死：任务未加载，暂存与备份文件留在二进制目录及LaunchAgents目录。重新安装可恢复任务，但遗留文件不清理。**已确认**（探针）。

## 浏览器扩展

### E1 服务状态、退避与持久化的控制记录

- 状态：`online`、`offline`、`empty`；`nextAttempt`退避；`checkedAt`有效期；同一状态同时在内存和IndexedDB的`control`记录中。
- 迁移：启动时恢复`ext/card-service.ts:31-37`；离线`51-54`；状态检查`55-70`；手动重试`72-83`；写回`44-50`。
- 缺口：控制记录读写失败时静默继续。**设计如此**（可用性优先；探针：查询仍返回`api`结果，测试`ext-tests/card-service.test.ts`固定只在变化时写入并重试失败的写入）。失败原因不留痕见E7。

### E2 元数据条目的新鲜度

- 状态：新鲜、过期、修订不符、否定缓存、损坏。
- 迁移：读取校验`ext/card-service.ts:125-136`；条件请求与续期`142-147`；写入`157`；结果来源`172-173`；LRU淘汰`ext/persistent-cache.ts:46-59`。
- 缺口：`IndexedMetadataStore.transaction`在请求同步抛错时不中止事务，已排队的写入仍会提交（`ext/persistent-cache.ts:31-39`；统计存储`ext/stats-store.ts:61-70`会中止）。**已确认**（原生Chromium探针；现有调用方总是提供`id`，属潜在缺陷）。

### E3 后台查询的批处理队列

- 状态：排队、计时器等待（12毫秒）、批次进行中（最多2个）、完成。
- 迁移：`ext/card-service.ts:100-119`；批次`120-179`。
- 缺口：未发现。批次失败时每个任务以`unavailable`结束（`113-115`）。

### E4 图片读取与获取

- 状态：进行中的同URL请求合并、并发上限4、失败后的否定缓存。
- 迁移：`ext/card-service.ts:181-199`、`200-232`。
- 缺口：未发现；获取有超时，失败表有上限。

### E5 内容脚本的图片探测缓存

- 状态：排队、探测中、已缓存结果；`epoch`区分清空前后的结果。
- 迁移：`ext/image-loader.ts:21-59`（超时`29`，按`epoch`写缓存`40-47`）、`61-73`、清空`77`、销毁`78-84`。
- 缺口：清空时进行中的探测仍留在`pending`，之后的调用者会加入它。**已排除**（探针：结果送达但不写入缓存，随后重新探测）。

### E6 换图的逐属性状态

- 状态：每个元素的`src`、`srcset`、`style`各有原值、已应用值与替换表。
- 迁移：观察`ext/image-replacer.ts:26-41`；启用与刷新`50-62`；处理`90-134`（过期结果的防护`126-127`）；还原`136-150`；销毁`70-76`。
- 缺口：未发现。测试`ext-tests/image-replacer.test.ts`。

### E7 内容脚本的启用状态与消息入口

- 状态：启用与偏好的修订计数、扩展上下文是否有效；后台消息处理的成功或失败。
- 迁移：`entry/content.ts:20-22, 24-33, 34-42, 46-50, 51-59, 61-67`；后台入口`entry/background.ts:16-19`。
- 缺口：
  - 启动期间用户关闭，随后首次读取存储把它重新打开。**已排除**（探针：修订计数生效，没有发出查询）。
  - 后台入口把所有失败变成同一条回复且不记录原因。**已确认**（探针）。

### E8 IndexedDB连接

- 状态：未打开、打开中、已打开、版本变更后失效；统计存储另有`disabled`。
- 迁移：`ext/persistent-cache.ts:18-30`；`ext/stats-store.ts:45-60, 71-74`。
- 缺口：统计存储的`disabled`在本次worker生命周期内不再恢复。**设计如此**：`ext/stats-store.ts:23`的说明及测试`unavailable IndexedDB falls back to bounded memory datasets and metadata`。

### E9 图片缓存的串行队列、初始化与大小索引

- 状态：`initialize`（未开始、进行中、成功、失败）、串行队列、内存中的大小索引（与CacheStorage的插入顺序一致）。
- 迁移：`ext/persistent-cache.ts:78-83`（初始化）、`90-95`（索引，条目数不一致时重建）、`96-100`（队列）、`101-113`（写入与先进先出淘汰）、`114-127`（状态读取不进入队列）。
- 缺口：
  - 首次打开失败后，失败的promise一直保留，之后所有操作都失败，直到worker重启。**已确认**（探针）。
  - 同一事实保存在两处（索引与CacheStorage）。**设计如此**：只有后台创建该存储，每次写入核对条目数，状态读取不排队，测试`ext-tests/persistent-cache.test.ts`及原生存储QA（`ext-tests/storage-browser.ts`）。

### E10 内容脚本的服务客户端

- 状态：查询队列与8毫秒计时器、进行中的图片解析（上限16）、`epoch`。
- 迁移：`ext/service-client.ts:16-23, 24-43, 44-68`；清空`71-75`；销毁`76-80`。
- 缺口：运行时消息没有时间上限；后台不应答时，查询与图片的promise永不结束，后来的调用者加入同一个promise（`28`、`57`）。**已确认**（探针）。

### E11 统计服务的新鲜度、退避与重试

- 状态：目录与数据集的有效期、检查中、失败退避、手动重试的5秒闸门、单一网络通道。
- 迁移：`ext/stats-service.ts:37-51, 53-64`（请求超时`56`）、`65-84`、`114-145`、`214-232`。
- 缺口：未发现。测试`ext-tests/stats-service.test.ts`（含`single flight per dataset and one global lane across concurrent keys`）。

### E12 统计浮层

- 状态：启用、路径、`epoch`、请求签名、加载中、`retrying`、已打开的浮窗。
- 迁移：`ext/stats-overlay.ts:87-90, 99-107, 108-131, 132-146, 178-264`（过期结果的防护`242, 250`）。
- 缺口：手动重试等待后台应答，没有时间上限；等待期间`scan`直接返回，只有导航或开关能离开。**已确认**（原生Chromium探针；与E10同因）。测试`manual retry waits for background invalidation and then uses the latest preferences`、`navigation removes the overlay while a manual background retry is pending`只固定等待与导航出口。

### E13 阅读面板

- 状态：隐藏、悬停显示、固定显示、当前条目、延迟隐藏计时器（200毫秒）。
- 迁移：`ext/reading-panel.ts:18-43, 45-83, 84-114`。
- 缺口：未发现。测试`ext-tests/image-replacer.test.ts`。

### E14 弹出页的重试状态

- 状态：空闲、`retrying`。
- 迁移：`entry/popup/main.ts:41-51, 88-107`。
- 缺口：后台不应答时按钮保持禁用。**已确认**（探针；与E10同因）。

### E15 Chrome Web Store发布协议与发布闸门

- 状态：已有版本的状态（`PENDING_REVIEW`等）、上传状态（成功、进行中、失败）、提交确认；发布前的Release、CI与产物校验。
- 迁移：`extensions/17lands-zh/scripts/publish-store.ts:53-63, 114-147`（轮询次数与间隔有上限`78-80`；POST不重试`88-92`）；`extensions/17lands-zh/scripts/prepare-store-release.ts:29-58, 129`起。
- 缺口：未发现。测试`ext-tests/publish-store.test.ts`、`ext-tests/prepare-store-release.test.ts`。

### E16 发布工作流的并发组

- 状态：排队、运行。
- 迁移：`.github/workflows/publish-chrome-web-store.yml:19-22`（同组不取消进行中的运行）。
- 缺口：未发现；两个发布不会同时修改商店条目，重复提交由E15的已有版本检查拦截。
