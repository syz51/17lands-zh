# 隐私政策 / Privacy policy

适用产品：17Lands 中文卡图（17Lands Chinese card display）。更新日期：2026-11-03。

## 中文

本扩展在17Lands网页上显示已有中文卡图、缺图时的已有中文牌文，以及轮抽页当前卡包的17Lands公开聚合统计。商店版连接`https://17lands.syzroy.com`提供的只读卡库；源码构建也支持用户自行运行卡库。统计直接从17Lands读取，不经过中文卡库。

**网页资料与网络请求。** 扩展在`17lands.com`和`www.17lands.com`中读取卡图资源地址、公开印刷ID、卡面方向和用于显示的卡牌名称。后台向卡库发送公开卡牌ID和语言，获取中文资料；按需向`images.mtgch.com`或`cards.scryfall.io`请求图片。这些请求用于显示用户正在查看的卡牌。卡图资源地址属于网页资源，能够反映所查看的卡牌，因此不将其描述为“完全不处理用户数据”。扩展不发送所在页面地址、轮抽/对局ID、账号资料或完整选牌记录；后台请求不携带网站登录凭据。

**17Lands统计。** 统计仅在17Lands轮抽页当前卡包展示。扩展读取页面公开卡牌身份、系列和赛制；模拟轮抽可用已有公开印刷ID向卡库查询系列。后台不带Cookie从`https://www.17lands.com`读取`/api/card_data`及`/data/filters`、`/data/site_draft_expansions`目录，请求包含系列、赛制、套色和玩家分组等筛选条件，不包含轮抽ID或个人选牌记录。17Lands会收到这些请求及正常HTTP元数据。统计和筛选结果不发送到中文卡库或其他服务，不批量抓取或再分发；来源链接可见，并按所有系列的`start_dates`执行12天保护期。

**本机保存。** 开关设置、连接状态及最近查询来源保存在扩展存储中；中文卡牌资料保存在IndexedDB，图片保存在CacheStorage。`storage.local`另保存`statsEnabled`（默认开启）、`statsPrefs`（赛制、套色、玩家分组和指标）及`statsMockExpansion`（模拟轮抽系列选择）。缓存只在浏览器本机，不通过Chrome Sync同步。中文资料缓存最多2000项，图片最多160张/64 MiB，按容量淘汰；统计使用独立IndexedDB，最多12组筛选组合、有效期6小时，目录有效期24小时。缓存到期会重新验证，更新失败可继续使用旧资料并标明统计数据年龄。卸载扩展会删除其本机存储。

**服务与第三方。** 卡库数据库保存公开卡牌资料，不保存用户账户、个人轮抽记录或逐用户请求历史。互联网服务、图源及17Lands在处理请求时会收到IP地址、请求的公开资源和正常HTTP元数据；商店版卡库使用Cloudflare提供网络服务。这些提供者可能依其政策处理访问及安全日志；参见[Cloudflare隐私政策](https://www.cloudflare.com/privacypolicy/)、[mtgch](https://www.mtgch.com/)、[Scryfall](https://scryfall.com/)和[17Lands隐私政策](https://www.17lands.com/privacy)。本扩展不添加分析、广告、跨站跟踪或用户标识符。

**用途与披露。** 数据仅用于中文卡图/牌文、公开聚合统计展示、缓存及必要的服务安全。不会出售数据，不用于广告、信用评估或与此功能无关的用途，不向其他用户公开个人浏览记录。本扩展对Google API所获信息的使用和转移遵守Chrome Web Store User Data Policy，包括Limited Use要求。

扩展不读取Arena日志、17Lands tracker token、密码、支付资料、邮件或浏览器历史记录数据库；不会生成机器译文。可以随时在工具栏分别关闭中文显示和17Lands数据，停止对应功能的页面处理与按需请求；关闭不会立即删除已有缓存、取消已发出的请求，也不停止浏览器原站自身的请求。需要清除全部缓存时卸载扩展即可。

**联系。** 关于本政策或数据处理的问题，请在[项目支持页](https://github.com/syz51/17lands-zh/issues)联系维护者；请勿在公开Issue中发布密码、日志、账号资料或私人轮抽链接。安全问题使用[私密漏洞报告](https://github.com/syz51/17lands-zh/security/advisories/new)。

## English

This extension displays existing Chinese card images, existing Chinese text when images are unavailable, and public aggregate 17Lands statistics for the current pack on draft pages. The store build uses the read-only card service at `https://17lands.syzroy.com`; source builds can use a self-hosted service. Statistics come directly from 17Lands and do not pass through the Chinese card service.

**Page data and requests.** On `17lands.com` and `www.17lands.com`, the extension reads card-image resource addresses, public printing IDs, face orientation, and card names needed for display. Its background sends public card IDs and a language to the card service, and retrieves images from `images.mtgch.com` or `cards.scryfall.io`. These resources can reveal which cards are being viewed. The extension does not send the containing page URL, draft/game IDs, account details, or a complete pick history. Background requests omit website login credentials.

**17Lands statistics.** Statistics appear only for the current pack on 17Lands draft pages. The extension reads public card identities, expansion, and format; mock drafts may use existing public printing IDs to ask the card service for the expansion. The background fetches `/api/card_data` and the `/data/filters` and `/data/site_draft_expansions` catalogs from `https://www.17lands.com` without cookies. Requests contain filters such as expansion, format, deck colors, and player group, without draft IDs or personal pick histories. 17Lands receives those requests and ordinary HTTP metadata. Statistics and filter results are never forwarded to the Chinese card service or other services, bulk scraped, or redistributed. A visible source link is retained, and a 12-day embargo uses `start_dates` for all expansions.

**Local storage.** Settings, connection state, and the latest lookup source use extension storage. `storage.local` also holds `statsEnabled` (on by default), `statsPrefs` (format, deck colors, player group, and metric), and `statsMockExpansion` (the mock-draft expansion selection). Chinese card metadata uses IndexedDB; images use CacheStorage. These caches stay in the local browser and do not use Chrome Sync. Chinese metadata is limited to 2,000 entries; images to 160 entries/64 MiB. Statistics use a separate IndexedDB cache with up to 12 filter combinations and a six-hour lifetime; catalogs have a 24-hour lifetime. Expired entries are revalidated. Failed updates may use stale data, with its age shown for statistics. Uninstalling removes the extension's local storage.

**Services and third parties.** The card database contains public card data, not user accounts, personal drafts, or per-user request histories. Network infrastructure, image providers, and 17Lands receive the IP address, requested public resources, and ordinary HTTP metadata when serving requests. The store service uses Cloudflare. These providers may process access/security logs under their own policies; see [Cloudflare](https://www.cloudflare.com/privacypolicy/), [mtgch](https://www.mtgch.com/), [Scryfall](https://scryfall.com/), and [17Lands](https://www.17lands.com/privacy). The extension adds no analytics, advertising, cross-site tracking, or user identifiers.

**Use and disclosure.** Data is used only for Chinese card display, public aggregate statistics display, caching, and necessary service security. It is not sold or used for advertising, credit decisions, or unrelated purposes. Personal browsing records are not disclosed to other users. Use and transfer of information received from Google APIs adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements.

The extension does not read Arena logs, tracker tokens, passwords, payments, email, or the browser history database. It does not generate machine translations. Chinese display and 17Lands statistics can be turned off independently to stop the corresponding page processing and on-demand requests. This does not immediately erase caches, cancel requests already sent, or stop requests made by 17Lands itself. Uninstall to remove all extension caches.

**Contact.** Use [project support](https://github.com/syz51/17lands-zh/issues) for privacy questions without posting credentials, logs, account details, or private draft links. Report security issues [privately](https://github.com/syz51/17lands-zh/security/advisories/new).
