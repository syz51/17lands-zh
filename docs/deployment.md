# Docker与Dokploy部署

服务使用单容器、单一SQLite writer及本机Docker命名卷。SQLite不是独立数据库容器；数据库、WAL、锁文件、已下载归档和磁盘scratch目录均位于`/data`，更新或重建容器保留该卷。

## Dokploy

1. 创建项目及Docker Compose服务，Git来源选择本仓库的`main`，Compose路径为`./compose.yaml`。
2. Environment设置`CARD_CACHE_ALLOWED_HOSTS=你的API域名`，不包含协议或路径。
3. Domains中为`card-cache`配置该hostname、容器端口17317。由Dokploy注入Traefik网络与路由。不要发布宿主17317端口，不增加第二个writer副本。
4. 直接Traefik对外时配置有效HTTPS；使用Cloudflare Tunnel时，让Tunnel发布的同一hostname指向Traefik的HTTP入口，保持原始Host头。此时应用的内部HTTP路由无需重复TLS跳转，公网HTTPS由Tunnel入口提供。
5. 部署后分别检查`/healthz`和`/v1/status`。前者确认进程与数据库健康；后者ready=true且card_count>0才表示已有完整资料。首次服务会自动刷新，也可在首次启动前把一致性SQLite快照恢复到数据卷。

默认命令仍监听loopback。Compose显式设置`CARD_CACHE_LISTEN=0.0.0.0:17317`并要求Host白名单；HTTP仍只读，无刷新/代理/管理接口，亦不开放CORS。图片和元数据查询保持原有数量/大小/连接上限。

容器以UID/GID10001运行，根文件系统只读、无额外capability。首次命名卷会继承镜像内`/data`目录权限；手工恢复文件须同样归10001所有。`/tmp`仅16MiB tmpfs，`TMPDIR=/data/tmp`使大归档解析和scratch SQLite走磁盘。内存上限512MiB，单次构建最多2个Cargo job。

## 备份与恢复

使用SQLite Backup API或`sqlite3 .backup`导出一致性快照；运行中不能只复制`cards.sqlite`而遗漏WAL。将快照加密/限制访问后保存在独立位置。Docker命名卷跨容器重建保留，不等于独立灾备；Dokploy的卷备份应另设目标和保留策略。不要把数据库或上游归档提交Git。

恢复时停止唯一容器writer，再把完整快照写入同一个`/data`卷，确保文件归10001所有，最后启动并核对revision和记录数。不要执行`docker compose down -v`，该参数会删除资料卷。

## 扩展连接远程卡库

默认构建继续使用本机服务；远程构建显式指定HTTPS origin：

```console
cd extensions/17lands-zh
WXT_API_ORIGIN=https://17lands.syzroy.com bun run build
```

重新加载同一扩展目录并刷新17Lands。构建配置同时生成API地址与相应host_permission，只允许HTTPS或固定的本机HTTP地址。不同API origin各有独立元数据缓存，避免两个服务器相同revision导致误命中；图片缓存仍按完整图源URL复用。

重新构建为默认模式可返回本地服务。确认远端读取正常后，可用独立CLI的`uninstall`停止本机LaunchAgent，保留本地数据库作为备份。
