# 本地中文卡库架构

## 数据模型

SQLite的可执行DDL位于`crates/card-cache/src/db.rs`，所有业务表带generation身份，以一次事务切换完整快照。

| 表 | 内容 |
| --- | --- |
| `generations` | 已发布快照及记录数量 |
| `cache_state` | 当前generation、刷新尝试/成功、下次检查、状态与错误 |
| `source_state` | 与当前generation绑定的上游归档及图片目录身份 |
| `oracles` | 牌张逻辑身份 |
| `printings` | 原始Scryfall印刷UUID、英文名、系列、编号和layout |
| `faces` | 物理front/back卡面 |
| `localized_faces` | 各语言名称、类别、规则、图片类型与替代印刷ID |
| `provenance` | 逐卡来源与链接 |

不按英文或中文卡名模糊合并。双面牌分别关联；历险、连体等单面牌合并其规则组件，但不借用另一张牌或另一物理卡面的图片。返回的printing_id始终为请求ID，图片另标exact、alternate或unavailable。

## 刷新与并发

单一Writer持有进程级文件锁。SQLite开启WAL、foreign_keys、2秒busy_timeout、512 KiB page cache，禁用mmap，临时结果用磁盘。Reader只读且query_only；同一批查询在一个短事务内取得revision和卡牌，避免混合新旧快照。

唯一OS线程检查持久日程；成功后24小时、失败后1小时。联网前保存attempt，重启不清除退避。先在scratch SQLite流式解析全量归档和完整目录，验证压缩长度、SHA256、tar/gzip完整性、分页与重复项，再以事务原子发布。错误或空快照回滚，保留旧版本。归档和图片目录共同构成source_revision；数据未变时只更新检查日程，不重写内容generation。

HTTP使用2个Tokio worker、最多4个blocking worker及4个只读连接。连接上限32，请求/排队上限32，读池等待2秒；HTTP1请求头10秒、连接60秒期限。数据库查询和JSON序列化在线程池执行，HTTP路径不能下载或触发刷新。

选择可裁剪features的Axum/Hyper，结合Tokio处理HTTP及固定读池。tiny_http的同步接口也可用于小服务，但需要额外维护连接/慢客户端边界；Actix同样可配置worker。本项目没有做跨框架性能排名。参考：[Axum](https://docs.rs/axum/0.8.9/axum/)、[SQLite WAL](https://sqlite.org/wal.html)、[tiny_http](https://docs.rs/tiny_http/latest/tiny_http/)、[Actix worker](https://actix.rs/docs/server/)。

## 扩展

内容脚本只传卡牌ID与front/back；MV3后台验证sender、schema、UUID和图片来源，再读取固定API。查询12ms合并、每批100、2批并发；图片4并发且限2 MiB，拒绝SVG和重定向，createImageBitmap验证并关闭bitmap后才保存。缓存读时重验旧坏图并删除重取。

IndexedDB保存版本、ETag及最多2000条卡牌/缺失结果；正缓存24小时、负缓存5分钟。CacheStorage最多160张/64 MiB。离线可读取旧资料；状态每5分钟检查、离线退避1分钟，显式重试有5秒间隔。

中文图可用则替换，保留英文alt与原始属性；没有图但有文字时提供Shadow DOM阅读面板，使用textContent安全渲染，支持键盘、hover和点击。刷新清空阅读状态而不销毁宿主，最终dispose才移除。开关和异步epoch避免复用节点收到上一张卡的结果。
