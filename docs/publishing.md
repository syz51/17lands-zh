# Chrome Web Store发布

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

## 商店资料

- 名称：17Lands 中文卡图；主要语言：简体中文；免费，公开分发。
- 详细介绍：`extensions/17lands-zh/store/description-zh_CN.txt`。
- 单一用途：在17Lands网页显示已有中文卡图，并在缺图时提供已有中文牌文。
- 主页：`https://github.com/syz51/17lands-zh`。
- 支持：`https://github.com/syz51/17lands-zh/issues`。
- 隐私政策：`https://github.com/syz51/17lands-zh/blob/main/docs/privacy.md`。
- 图标：ZIP中的`icon/128.png`，源文件为`assets/icon.svg`；16px使用单独对齐像素的`assets/icon-16.svg`。图形撑满画布，不含文字。宣传图440×280；至少一张640×400或1280×800的真实使用截图，不含账号、私人轮抽链接或浏览器个人资料。

## 隐私与权限申报

- `storage`：保存中文开关、连接状态和缓存索引；不使用Chrome Sync。
- 17Lands网站：读取卡图身份并替换展示、提供阅读面板；不修改原站选牌处理。
- `https://17lands.syzroy.com/*`：按公开卡牌ID批量查询中文资料及卡库状态。
- `https://images.mtgch.com/*`、`https://cards.scryfall.io/*`：下载及缓存功能所需卡图。
- 远程代码：无。所有可执行代码随扩展打包；远端只提供JSON资料和图片。
- 数据类别：Website content为所读取的卡牌内容，Web history按卡图资源及相关浏览活动作保守披露，Location仅指服务基础设施处理的IP地址；不读取历史记录数据库、页面访问列表或GPS，也不做地理定位。不能因卡牌ID公开就申报“完全不处理数据”。具体以当前代码及[隐私政策](privacy.md)为准。
- 不出售，不作广告、信用评估或无关用途；符合Limited Use。

上传后填写Store listing、Privacy、Distribution及Test instructions，核对所有必填项后提交审核。开发者账号的条款、付款、身份验证或CAPTCHA由账号持有人完成；不要保存凭据到仓库。Google审核与上架时间不能由构建或上传成功推断，须回读实际状态。
