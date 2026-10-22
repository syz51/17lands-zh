# 公开仓库设置检查

2026-10-22检查`syz51/17lands-zh`的GitHub API设置。该报告不自动改变分支合并或权限规则。

已有：public、MIT、Issues、CI；Actions工作流显式只读contents权限，action引用固定SHA；secret scanning和push protection已开启。CI checkout已更新为使用Node24的当前版本，并加入Docker构建验证。

建议优先补充：

- 启用Dependabot alerts和security updates；本次API显示两者未开启。再按需配置Cargo、扩展依赖及GitHub Actions的定期版本更新，控制合并频率。
- 为main建立规则：禁止force push和删除、要求现有CI通过，公共贡献通过PR。个人维护阶段不必要求另一个人的批准；增加协作者后再要求review和解决讨论。
- 启用private vulnerability reporting，补充SECURITY.md的非公开漏洞报告方式、CONTRIBUTING.md和简明Issue/PR模板。
- 启用合并后自动删除分支；按偏好统一合并方式。Wiki和Projects当前开启，未使用时可关闭，避免出现多套说明。
- 根据贡献者规模考虑CODE_OF_CONDUCT、CODEOWNERS及CodeQL；这些不影响当前项目被正确识别为开源，也不必为了清单而全部开启。

仓库中不保存Dokploy API key、VPS凭据、Tunnel token、数据库或发布webhook。服务器内仍执行单写者日程，CI只构建/测试，不在每次push抓取上游全量目录。

参考：[GitHub安全快速开始](https://docs.github.com/en/code-security/getting-started/quickstart-for-securing-your-repository)、[保护分支](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)、[Dokploy Compose](https://docs.dokploy.com/docs/core/docker-compose)。
