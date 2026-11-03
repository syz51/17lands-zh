# 扩展发布

商店包使用固定远程HTTPS卡库；默认源码构建仍使用本机卡库。只上传通过当前提交CI及真实Chrome验收的生产包，不上传源码目录、测试夹具、数据库或个人截图。

## 构建

在`extensions/17lands-zh`执行：

```console
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun run build:firefox
bun run zip:store
```

`zip:store`生成`.output/17lands-zh-<版本>-chrome.zip`，并检查生产manifest的HTTPS地址、权限和PNG图标尺寸，避免误上传默认loopback构建。ZIP根目录必须包含manifest。每次更新递增`package.json`版本；按[贡献流程](../CONTRIBUTING.md)经PR合并后发布。

## GitHub Release

发布标签与扩展`package.json`版本对应，例如版本`0.5.0`使用`v0.5.0`。先通过PR将发布内容合入`main`，确认PR当前提交及合并提交的CI通过，再在该合并提交上创建标签和Release。从该提交构建附件，不将未提交的本机改动打入安装包。

| 命令 | 默认ZIP | 卡库模式 |
| --- | --- | --- |
| `bun run zip` | `.output/17lands-zh-<版本>-chrome.zip` | Chrome/Edge，本机`http://127.0.0.1:17317` |
| `bun run zip:firefox` | `.output/17lands-zh-<版本>-firefox.zip` | Firefox，本机`http://127.0.0.1:17317` |
| `bun run zip:store` | `.output/17lands-zh-<版本>-chrome.zip` | Chrome/Edge，固定远程`https://17lands.syzroy.com` |

本机构建前清除用于远程构建的`WXT_API_ORIGIN`环境变量。两种Chrome包默认同名，会相互覆盖；每次生成后立即复制到发布目录，用`chrome-local`、`chrome-remote`和`firefox-local`等文件名明确区分。核对ZIP内manifest版本、卡库地址及权限，并提供SHA-256校验值。Release说明应说明各包的卡库要求、主要变化和实际验证范围；Firefox当前仅完成构建验证，不宣称已完成运行验收。GitHub自动提供源码归档；额外附件只包含安装包与校验文件，不上传数据库、缓存、日志、上游归档或测试夹具。

创建GitHub Release不会上传Chrome Web Store，也不代表商店审核通过；商店提交遵循下述流程。

## 商店资料

- 名称：17Lands 中文卡图；主要语言：简体中文；免费，公开分发。
- 详细介绍：`extensions/17lands-zh/store/description-zh_CN.txt`。
- 单一用途：辅助阅读17Lands网页中的卡牌，显示已有中文卡图、缺图时的已有中文牌文及轮抽页当前卡包的公开聚合统计。
- 主页：`https://github.com/syz51/17lands-zh`。
- 支持：`https://github.com/syz51/17lands-zh/issues`。
- 隐私政策：`https://github.com/syz51/17lands-zh/blob/main/docs/privacy.md`。
- 图标：ZIP中的`icon/128.png`，源文件为`assets/icon.svg`；16px使用单独对齐像素的`assets/icon-16.svg`。图形撑满画布，不含文字。宣传图440×280；至少一张640×400或1280×800的真实使用截图，不含账号、私人轮抽链接或浏览器个人资料。

## 隐私与权限申报

- `storage`：保存中文与统计的独立开关、统计筛选与模拟轮抽系列选择、连接状态和缓存索引；设置及缓存仅存本机，不使用Chrome Sync。
- 17Lands网站：读取公开卡图身份、系列和赛制，替换中文展示、提供阅读面板及当前卡包统计；不修改原站选牌处理。
- `https://www.17lands.com/*`：后台不带Cookie按需读取固定路径`/api/card_data`、`/data/filters`与`/data/site_draft_expansions`。统计请求只发送系列、赛制、套色及玩家分组等筛选条件，不发送页面地址、轮抽ID或个人选牌记录；不转发到中文卡库。所有系列按`start_dates`执行12天保护期，保留可见来源链接，不批量抓取、镜像或再分发统计。
- `https://17lands.syzroy.com/*`：按公开卡牌ID批量查询中文资料及卡库状态。
- `https://images.mtgch.com/*`、`https://cards.scryfall.io/*`：下载及缓存功能所需卡图。
- 远程代码：无。所有可执行代码随扩展打包；远端只提供JSON资料和图片。
- 数据类别：Website content为所读取的卡牌内容，Web history按卡图资源及相关浏览活动作保守披露，Location仅指服务基础设施处理的IP地址；不读取历史记录数据库、页面访问列表或GPS，也不做地理定位。不能因卡牌ID公开就申报“完全不处理数据”。具体以当前代码及[隐私政策](privacy.md)为准。
- 不出售，不作广告、信用评估或无关用途；符合Limited Use。

上传后填写Store listing、Privacy、Distribution及Test instructions，核对所有必填项后提交审核。开发者账号的条款、付款、身份验证或CAPTCHA由账号持有人完成；不要保存凭据到仓库。Google审核与上架时间不能由构建或上传成功推断，须回读实际状态。
