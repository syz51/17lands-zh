# 隐私政策 / Privacy policy

适用产品：17Lands 中文卡图（17Lands Chinese card display）。更新日期：2026-10-22。

## 中文

本扩展的唯一用途是在17Lands网页上显示已有的中文卡图，并在缺图时提供已有中文牌文。商店版连接`https://17lands.syzroy.com`提供的只读卡库；源码构建也支持用户自行运行卡库。

**网页资料与网络请求。** 扩展在`17lands.com`和`www.17lands.com`中读取卡图资源地址、公开印刷ID、卡面方向和用于显示的卡牌名称。后台向卡库发送公开卡牌ID和语言，获取中文资料；按需向`images.mtgch.com`或`cards.scryfall.io`请求图片。这些请求用于显示用户正在查看的卡牌。卡图资源地址属于网页资源，能够反映所查看的卡牌，因此不将其描述为“完全不处理用户数据”。扩展不发送所在页面地址、轮抽/对局ID、账号资料或完整选牌记录；后台请求不携带网站登录凭据。

**本机保存。** 开关设置、连接状态及最近查询来源保存在扩展存储中；中文卡牌资料保存在IndexedDB，图片保存在CacheStorage。缓存只在浏览器本机，不通过Chrome Sync同步。资料缓存最多2000项，图片最多160张/64 MiB，按容量淘汰；缓存到期会重新验证，服务不可用时可能继续使用旧资料。卸载扩展会删除其本机存储。

**服务与第三方。** 卡库数据库保存公开卡牌资料，不保存用户账户、个人轮抽记录或逐用户请求历史。互联网服务及图片提供者在处理请求时会收到IP地址、请求的公开卡牌资源和正常HTTP元数据；商店版卡库使用Cloudflare提供网络服务。基础设施和图源可能依其政策处理访问及安全日志；参见[Cloudflare隐私政策](https://www.cloudflare.com/privacypolicy/)、[mtgch](https://www.mtgch.com/)和[Scryfall](https://scryfall.com/)。本扩展不添加分析、广告、跨站跟踪或用户标识符。

**用途与披露。** 数据仅用于中文卡图/牌文功能、缓存及必要的服务安全。不会出售数据，不用于广告、信用评估或与此功能无关的用途，不向其他用户公开个人浏览记录。本扩展对Google API所获信息的使用和转移遵守Chrome Web Store User Data Policy，包括Limited Use要求。

扩展不读取Arena日志、17Lands tracker token、密码、支付资料、邮件或浏览器历史记录数据库；不会生成机器译文。可以随时在工具栏关闭中文显示，停止页面卡牌处理；关闭不会立即删除已有缓存，也不停止浏览器原站自身的请求。需要清除全部缓存时卸载扩展即可。

**联系。** 关于本政策或数据处理的问题，请在[项目支持页](https://github.com/syz51/17lands-zh/issues)联系维护者；请勿在公开Issue中发布密码、日志、账号资料或私人轮抽链接。安全问题使用[私密漏洞报告](https://github.com/syz51/17lands-zh/security/advisories/new)。

## English

This extension has one purpose: display existing Chinese card images on 17Lands and offer existing Chinese card text when an image is unavailable. The store build uses the read-only card service at `https://17lands.syzroy.com`; source builds can use a self-hosted service.

**Page data and requests.** On `17lands.com` and `www.17lands.com`, the extension reads card-image resource addresses, public printing IDs, face orientation, and card names needed for display. Its background sends public card IDs and a language to the card service, and retrieves images from `images.mtgch.com` or `cards.scryfall.io`. These resources can reveal which cards are being viewed. The extension does not send the containing page URL, draft/game IDs, account details, or a complete pick history. Background requests omit website login credentials.

**Local storage.** Settings, connection state, and the latest lookup source use extension storage. Card metadata uses IndexedDB; images use CacheStorage. These caches stay in the local browser and do not use Chrome Sync. Metadata is limited to 2,000 entries; images to 160 entries/64 MiB. Entries are evicted to respect those limits; expired metadata is revalidated, and stale data may remain usable offline. Uninstalling removes the extension's local storage.

**Services and third parties.** The card database contains public card data, not user accounts, personal drafts, or per-user request histories. Network infrastructure and image providers receive the IP address, requested public resources, and ordinary HTTP metadata when serving requests. The store service uses Cloudflare. Infrastructure and image providers may process access/security logs under their own policies; see [Cloudflare](https://www.cloudflare.com/privacypolicy/), [mtgch](https://www.mtgch.com/), and [Scryfall](https://scryfall.com/). The extension adds no analytics, advertising, cross-site tracking, or user identifiers.

**Use and disclosure.** Data is used only for Chinese card display, caching, and necessary service security. It is not sold or used for advertising, credit decisions, or unrelated purposes. Personal browsing records are not disclosed to other users. Use and transfer of information received from Google APIs adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements.

The extension does not read Arena logs, tracker tokens, passwords, payments, email, or the browser history database. It does not generate machine translations. Turning off Chinese display stops page-card processing, but does not immediately erase caches or stop requests made by 17Lands itself. Uninstall to remove all extension caches.

**Contact.** Use [project support](https://github.com/syz51/17lands-zh/issues) for privacy questions without posting credentials, logs, account details, or private draft links. Report security issues [privately](https://github.com/syz51/17lands-zh/security/advisories/new).
