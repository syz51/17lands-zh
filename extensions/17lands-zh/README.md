# 17Lands 中文卡图

使用 WXT 构建的独立 MV3 扩展（0.5.0）。通过只读卡牌 API 获取中文卡图与文字，并直接读取 17Lands 公开聚合统计；在本机保存缓存，保留 17Lands 的抽牌行为。

## 安装

使用构建产物 `.output/chrome-mv3/`：在 Chrome / Edge 的扩展管理页开启开发者模式，选择“加载已解压的扩展程序”，选中该目录。安装后刷新已经打开的 17Lands 页面。

“显示中文”和“显示 17Lands 数据”默认开启，可在工具栏弹窗中独立关闭。任一开启时可重试当前页面的对应内容。无需 Tampermonkey、17Lands token 或 Arena 日志。

默认构建使用 `http://127.0.0.1:17317`；远程构建通过 `WXT_API_ORIGIN=https://17lands.syzroy.com bun run build` 选择 HTTPS 服务，并同步生成权限，详见[部署说明](../../docs/deployment.md)。由仓库的 Rust 卡牌服务管理 SQLite 与每日更新；扩展向卡库只读取 `/v1/status`、`/v1/cards?ids=…&lang=zhs`。服务暂不可用时可读取已有缓存。重试会重新尝试当前页面已开启的功能；中文开启时也重新检测卡库，有效缓存仍会复用。统计请求直接发给 17Lands，不经过卡库。

Firefox 包可通过 `bun run build:firefox` 构建；临时加载时在 `about:debugging` 中选择生成的 manifest。Firefox 实际运行需单独验证。Safari 需要额外的应用包装，本项目不提供可直接安装的 Safari 包。

## 开发与检查

开发、构建、打包与验证命令统一见[贡献说明](../../CONTRIBUTING.md#开发与验证)，开发约定见[根目录AGENTS.md](../../AGENTS.md)。`bun.lock`固定依赖；没有前端框架或运行时服务器依赖。

## 行为与范围

- 只在 `https://www.17lands.com/*` 与 `https://17lands.com/*` 运行。`storage` 权限保存开关和筛选；网络权限仅包含构建时选定的 API origin、`images.mtgch.com`、`cards.scryfall.io` 与 `https://www.17lands.com/*`。
- 精确使用图片里的 Scryfall 印刷 UUID 和正反面路径，不按卡名猜测，也不改选牌点击、卡名、导出或网站接口。
- 支持动态新增与复用的图片、srcset / picture 以及内联背景图；中英切换无需刷新。
- 中文查询只向后台传印刷 UUID 和 `front` / `back`，不传页面 URL。统计查询另传公开卡牌身份、系列及筛选条件。真正的 MV3 后台验证消息来源、API schema 与图片来源，拒绝任意地址代理、重定向和 SVG 响应。
- 跨页面合并查询，每批最多 100 个 ID，最多并发 2 批；图片最多并发 4 个。服务状态每 5 分钟检测，离线退避 1 分钟，手动重试至少间隔 5 秒。可见页面每 5 分钟更新当前牌图，忽略失效的异步响应。
- 元数据在 IndexedDB 中保存，最多 2,000 条，按最近使用淘汰。正结果 TTL 24 小时，负结果 5 分钟；revision 改变即重新查询，支持 ETag / 304；离线可使用旧结果。CacheStorage 图片最多 160 张、总计 64 MiB，按写入顺序淘汰，单图上限 2 MiB；后台用 `createImageBitmap` 原生解码成功并释放 bitmap 后才写缓存和传输数据 URL，页面再确认可显示才换图。旧缓存也重新解码；坏条目删除后重取，好图继续离线可用。
- 保留卡面方向（front/back）；中文图源没有某卡或某面时回退英文，不能将这类回退宣称为完整汉化。
- 图像使用服务提供的精确中文印刷版或同 Oracle 替代版，保留牌面身份；基本地也由 API 处理，不按英文卡名猜印刷版本。只有服务离线或数据未准备好且没有已缓存卡牌时，才尝试旧的大学院废墟直接映射，并明确标记为直接图源回退。
- 有中文文字但缺图或加载失败时，保留英文原图与 alt，提供独立“查看中文牌文”入口。支持鼠标悬停、键盘聚焦、点击按钮及下拉选择，Escape 关闭；当前阅读卡牌移除或切换时关闭旧牌文，其他卡牌仍可悬停或聚焦打开；不拦截卡牌选取。所有中文字段通过 `textContent` 写入。
- 弹窗提供独立的“显示中文”和“显示 17Lands 数据”开关（说明在旁边的“?”中）、卡库连接状态及“重试当前页面”。
- 图片仅缓存在用户浏览器，不随扩展包打包；卡牌版权归相应权利人。主要中文图源为[大学院废墟](https://www.mtgch.com/)，服务可提供 Scryfall 中文替代版本。本扩展与 17Lands、大学院废墟或 Wizards 无隶属关系。
- 加载中文图片会把该卡图的公开印刷 ID 发送给图源，不发送页面 URL、账号或日志。Firefox 包按此声明网站内容传输，并要求 Firefox 140+；没有遥测或统计上传。

## 17Lands 统计

- 仅在 `/site_draft`、`/draft`、`/site_draft_replay`、`/submitted_draft`、`/user/latest_draft` 的当前卡包显示，不处理已选牌区或悬浮大图；不改原站选牌行为。卡包上方始终显示链接到对应数据页的 17Lands 来源。
- 支持系列、赛制、套色、玩家分组及指标筛选。卡下显示等级、所选胜率指标和 ALSA，详情提供更多指标。回放使用页面系列/赛制；模拟轮抽可用现有公开印刷 ID 向卡库查询系列，也可沿用选择或手动指定，不发送轮抽 ID。
- 后台不带 Cookie 从 `https://www.17lands.com` 读取 `/api/card_data`、`/data/filters` 和 `/data/site_draft_expansions`。对所有系列按 `start_dates` 执行 12 天保护期，不只限制最新系列；无法确认时不显示受保护数据。只按需读取公开聚合数据，不批量抓取或再分发，也不转发到中文卡库。
- 统计使用独立 IndexedDB，最多缓存 12 组系列/赛制/套色/玩家分组组合，TTL 6 小时；目录缓存 24 小时。更新失败可使用旧数据并显示数据年龄。
- 本机 `storage.local` 保存 `statsEnabled`（默认 `true`）、`statsPrefs`（`format` 为 `auto` 或赛制代码，以及 `colors`、`group`、`metric`）和 `statsMockExpansion`；不使用浏览器同步。数据权利与使用准则统一见[主 README](../../README.md#许可与第三方权利)。

## 验证与限制

自动测试覆盖映射、换图竞态、动态节点、关闭恢复、阅读面板生命周期、消息校验、批处理、持久缓存、ETag/revision、原生fetch接收者、解码先于缓存、坏图恢复及 API origin 验证。运行方式见[贡献说明](../../CONTRIBUTING.md#开发与验证)。

`tests/preview-server.ts`是视觉夹具；修改MV3后台、存储或图片解码时，需在真实扩展中验证。Firefox目前仅完成构建，实际运行尚未验收；构建通过不代表所有浏览器、系列及正反面均已覆盖。
