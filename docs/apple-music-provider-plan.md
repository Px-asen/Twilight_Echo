# Apple Music Provider 实施与安全计划

## 1. 目标与范围

在外部插件仓库实现 Apple Music 音源，并在 Twilight Echo 宿主中补齐通用 Provider 下载能力。

首版范围：

- API Key 配置与连接检查
- 歌曲、专辑、艺术家、歌单搜索
- 歌曲、专辑、艺术家、歌单元数据
- AAC、Lossless、Hi-Res 流媒体播放
- 单曲及多选批量下载
- 下载进度、队列、取消、失败与重试
- 下载完成后精确增量扫描并加入本地音乐库

当前文档没有歌词、用户收藏库或账号登录接口，因此首版不声明 `lyrics` 或 `library` capability。`login` 仅表示私有 API 凭据已配置并通过 `/open-api/v1/me` 验证，不代表 Apple Music 用户登录。

## 2. 已确认的远端契约

基础路径为 `/open-api/v1`，Bearer Key scopes 包括：

- `search`
- `metadata`
- `download`
- `history`
- 后续文档新增的 `stream`

端点：

- `GET /search?q=&types=&limit=&offset=`，`limit` 最大 25，`offset` 最大 1000
- `GET /songs/{song_id}`
- `GET /albums/{album_id}`
- `GET /artists/{artist_id}`
- `GET /playlists/{playlist_id}`
- `GET /stream/{song_id}?quality=aac|lossless|hi-res`
- `POST /downloads`
- `GET /downloads/{job_id}`
- `DELETE /downloads/{job_id}`
- `GET /downloads/{job_id}/file`
- `GET /downloads?status=&limit=&offset=`
- `GET /me`

流接口支持单段 `Range`，返回 200、206 或 416，并提供实际音质。下载接口是异步任务；最终文件只允许一次成功领取，未领取文件约 30 分钟后过期。

OpenAPI 的成功响应 schema 目前为空。拿到密钥后必须先获取脱敏真实响应并建立 fixture，不能依据猜测实现复杂详情解析。

## 3. 威胁模型与现实边界

桌面客户端无法可靠隐藏它必须连接的服务器地址。硬编码、字符串拆分、混淆和本地加密只能降低静态扫描便利度，无法阻止有本机控制权的人通过连接表、DNS、代理或抓包看到目标地址。

安全目标应定义为：

1. 未授权扫描者无法连接服务，或即使发现地址也无法调用接口。
2. API Key 不以明文落盘，不进入渲染进程、URL、播放队列、日志、崩溃报告或诊断数据。
3. 被截获的请求不能长期复用；单个客户端凭据可以撤销、轮换、限权和审计。
4. 插件不能借下载能力写入任意文件系统位置。

本方案不宣称能防御已取得用户账户权限、可调试主进程或读取进程内存的本机攻击者。

## 4. 服务端安全基线

### 4.1 网络层，必须

优先级从高到低：

1. 只通过 WireGuard、Tailscale、ZeroTier 等私网访问，公网不开放 `10016`。
2. 或由防火墙仅允许固定出口 IP / VPN 网段访问。
3. 若必须公网访问，只暴露 443，由反向代理转发到仅监听回环或内网地址的后端端口。

禁止继续通过公网明文 HTTP 传输 Bearer Key。生产环境必须使用 HTTPS，TLS 1.2 以上。

### 4.2 认证与授权，必须

- 为 Twilight Echo 单独创建密钥，不复用管理员或其他客户端密钥。
- 最小权限拆分：常规 Key 使用 `search,metadata,stream,download`；`history` 非必要不授予。
- 密钥设置有效期并支持立即撤销；数据库只存 Key 的不可逆哈希与 prefix。
- 每个 Key 设置请求速率、并发、每日下载量和流量额度。
- 管理端点与开放 API 使用不同认证域，开放 Key 永远不能访问 `/api/admin/*`。
- 401/403/429 响应不泄漏 Key 是否存在、服务器内部路径或下游错误细节。

### 4.3 请求签名，建议服务器补充

Bearer Key 只能鉴权，不能防止 HTTPS 终止点之后的重放。建议增加：

- `X-Client-Id`
- `X-Timestamp`
- `X-Nonce`
- `X-Content-SHA256`
- `X-Signature: base64(HMAC-SHA256(secret, canonicalRequest))`

规范化串至少包含 HTTP method、规范化 path/query、body SHA-256、时间戳和 nonce。服务器只接受约 60 秒时间窗口，并将 nonce 按 Key 保存至窗口过期，重复 nonce 直接拒绝。

不要把签名 secret 放在 URL。若暂时不能改服务端，首版使用 HTTPS Bearer，并将请求签名列为第二阶段加固。

### 4.4 额外防护，建议

- 可选 mTLS，为指定设备签发客户端证书。
- 关闭公网 `/docs`、`/openapi.json` 和 `/admin`，或只允许私网/管理员网段访问。
- 审计日志只记录 Key prefix、client id、状态码、耗时和资源 ID，不记录 Authorization、签名、完整 URL 查询或响应体。
- 对连续 401/403、枚举 ID、异常 Range、下载滥用设置自动封禁或告警。
- 定期轮换 Key；客户端支持先配置新 Key、验证成功后再撤销旧 Key。

## 5. 客户端凭据保护

### 5.1 宿主安全改动，必须先做

现有插件设置会自动加密名称包含 `token`、`secret`、`credential` 等的键，但 `apiKey` / `api_key` 尚未明确覆盖。修改 `src/main/security/secureStorage.ts`：

- 敏感键识别加入 `apiKey`、`api_key`、`apikey`、`bearer`、`signingKey`、`clientSecret`。
- 日志脱敏加入 `Authorization: Bearer ...`、`X-Signature`、`X-Api-Key` 和上述键名。
- 增加迁移测试，确保历史明文 `apiKey` 在首次读取后自动重写为安全 envelope。
- 若 Electron `safeStorage` 不可用，UI 明确提示当前使用机器绑定 AES-256-GCM 回退；不允许静默退化到明文。

插件使用敏感键名 `apiKey`，由宿主私有设置接口读写。设置页保存后不回显完整 Key，只显示 prefix 和验证状态。

### 5.2 进程与数据流隔离

- API Key 仅在 pluginHost 内短暂解密并用于请求。
- renderer 只能收到 `configured: true`、prefix、scopes、expiresAt 和健康状态。
- Provider 返回的曲目、封面、播放 URL、错误和下载任务均不得包含 Key。
- 禁止把 Key 放入 query、fragment、文件名、User-Agent、Referer 或本地代理 URL。
- 插件日志统一经过额外脱敏，错误只保留状态码、端点类别和 request id。
- deactivate/logout 时清除内存引用、关闭代理、撤销本地令牌并中止未完成请求。

本地加密保护静态文件，不等于防止运行时内存提取；这是桌面客户端的固有限制。

## 6. 流媒体架构

优先复用宿主现有 `twilight-media://audio/<opaque-token>` grant 机制，而不是把远端地址交给 renderer。

需要扩展远程媒体 grant，使受信任 Provider 可注册“带宿主保管请求头的媒体请求”：

- grant 内存记录包含远端 URL、媒体类型和受保护 Authorization 信息。
- renderer 只持有随机 opaque token，不知道服务器地址和 Key。
- 协议处理器转发 GET/HEAD、单段 Range 和必要响应头。
- Authorization 只允许发送到初始受信任 origin；跨 origin redirect 必须剥离凭据或直接拒绝。
- HTTPS 不允许降级到 HTTP；正式环境拒绝明文远端。
- 限制重定向次数、响应大小、并发和空闲 TTL。
- 保留 `Content-Type`、`Content-Length`、`Content-Range`、`Accept-Ranges`、`ETag`、`Cache-Control`、`X-Audio-Quality`。

若当前私有服务只能用 HTTP，开发构建可通过显式 `allowInsecurePrivateApi` 临时开启，并持续显示警告；发布构建默认拒绝携带凭据访问 HTTP。

## 7. 外部 Apple Music Provider

仓库：`D:\Linux Workspace\Project\Twilight-Echo-plugins`

新增：

- `plugins/applemusic-provider/plugin.json`
- `plugins/applemusic-provider/index.mjs`
- `plugins/applemusic-provider/index.test.mjs`
- `plugins/applemusic-provider/README.md`

标识建议：

- Plugin ID：`com.twilightecho.provider.applemusic`
- Provider ID：`am`
- Track ID：`am:<song_id>`
- 权限：`network`、`settings`、`ui:inject`
- capabilities：`search`、`playbackUrl`、`cover`、`playlist`、`login`，以及宿主新增的 `download`

设置项：

- 私有服务基址
- API Key
- 可选 client id / signing secret
- 流媒体默认音质
- 下载默认音质
- HTTP 开发例外开关

功能映射：

- 搜索：按 songs、albums、artists、playlists 分类型调用并映射。
- 当前 UI 每页 30，而远端 limit 最大 25；请求 30 条时拆为 25 + 5，并保证 offset 连续。
- 专辑详情映射到 `fetchAlbumTracks`。
- 歌单详情映射到 `fetchPlaylistTracks`。
- 艺术家详情映射到 `fetchArtistTopSongs` / `fetchArtistAlbums`，以真实响应能力为准。
- 播放：返回宿主生成的 opaque media grant。
- 下载：仅创建远端任务、查状态、取消和交付响应；插件不直接写用户目录。

## 8. 宿主通用 Provider 下载管线

新增 `download` capability 与方法：

- `createDownload(track, options)`
- `getDownloadStatus(remoteJobId)`
- `openDownloadFile(remoteJobId)` 或等价的受控流交付接口
- `cancelDownload(remoteJobId)`

不应在一次 Provider RPC 中持续等待整个下载任务。主进程新增 `ProviderDownloadManager`：

1. 创建远端任务并持久化本地任务记录。
2. 以退避策略短调用查询状态，避免占用 RPC 并发。
3. 完成后准备已授权目标目录及同目录 `.part` 文件。
4. 通过插件/受控网络通道领取一次性文件。
5. 校验协议、origin、重定向、Content-Length、最大文件尺寸和实际接收字节数。
6. fsync 后原子重命名；中断时删除 `.part`。Windows 的 fsync 映射为 `FlushFileBuffers`，只读句柄会返回 `EPERM`，因此必须以读写方式打开 `.part`；文件系统完全拒绝刷盘时按尽力而为处理，不得丢弃已校验完成的文件。
7. 调用 `LocalLibraryIndexCoordinator.enqueueWatcherChanges([{ kind: 'add', path }])` 精确扫描。
8. 发送任务和音乐库更新事件。

目标目录取用户在设置中选择的下载目录，未设置时回退到已授权的 `libraryFolders` 第一项；两者都必须经过用户在系统对话框中选择并授权，渲染层写入的路径不构成授权来源。没有任何可用目录时先要求用户选择。落在音乐库之外的下载文件不会进入本地库增量扫描。插件没有路径选择权，也不获得 `filesystem:write` 或 `library:write`。

一次性文件领取失败后不能盲目重复 GET。应查询任务状态；如果文件已消费或过期，重新创建远端下载任务并在 UI 标明重试原因。

## 9. UI 与任务状态

流媒体曲目菜单增加：

- 下载到本地
- 多选下载所选歌曲
- AAC / Lossless / Hi-Res 音质菜单

下载任务状态统一为：

- `queued`
- `preparing`
- `transferring`
- `scanning`
- `completed`
- `failed`
- `cancelled`
- `expired`

显示队列位置、服务端准备进度、本地字节进度、请求/实际音质、目标文件和安全化错误。任何界面和诊断导出都不得显示服务 Key、签名或完整 Authorization。

## 10. 实施顺序

### 阶段 A：安全底座

1. 扩展敏感键识别和日志脱敏。
2. 增加 API Key 明文迁移测试。
3. 扩展 opaque remote media grant，支持主进程保管 Provider 请求头。
4. 增加 HTTPS、origin、重定向、Range、大小和凭据泄漏测试。

### 阶段 B：Provider 读取与播放

1. 使用脱敏 fixture 固化远端响应契约。
2. 实现设置、连接验证和健康状态。
3. 实现搜索、详情和字段映射。
4. 实现流媒体 grant 和音质选择。

### 阶段 C：通用下载

1. 扩展 plugin-api、主进程方法白名单、路由、preload 和 renderer 封装。
2. 实现 ProviderDownloadManager、任务持久化、取消和恢复。
3. 实现安全落盘与增量扫描。
4. 增加 UI 菜单和任务面板。

### 阶段 D：发布

1. 插件测试、宿主测试、typecheck、build。
2. 生成 `.tep`。
3. 更新 `plugins.json` 和 SHA-256。
4. 使用最小权限、短有效期测试 Key 做端到端验证。
5. 验证后撤销测试 Key，签发正式客户端 Key。

## 11. 验收标准

- 磁盘搜索不到 API Key 明文。
- renderer、播放队列、持久化曲目和日志中不存在 API Key、Authorization 或签名。
- 代理 URL 不暴露私有服务器地址。
- HTTPS 重定向降级和跨 origin 凭据转发被拒绝。
- Range 播放、拖动和取消可工作。
- 下载中断不留下最终文件或残缺曲目。
- 下载完成后只增量扫描目标文件并加入本地库。
- 撤销 Key 后客户端立即得到明确的重新配置状态。
- 未授权 IP、无 Key、错误 scope、过期 timestamp、重复 nonce 和超额请求均被服务端拒绝。

## 12. 密钥提供后的处理规则

后续提供密钥时：

- 不把密钥写入仓库、计划文档、测试 fixture、命令历史或聊天输出。
- 只通过应用设置流程写入插件私有加密存储。
- 调试输出仅显示 prefix，例如 `amdw_live_abcd...`。
- 先调用 `/me` 验证 scopes 和有效期，再获取响应样本；样本必须移除 Key、IP、User-Agent、request id 和可识别账户数据。
- 发现密钥疑似泄漏时立即停止测试、撤销并重新签发，不继续复用。

### 宿主下载体验（2026-09-10）

宿主在已有下载协议之外提供本机文件命名偏好、可选标签与封面补写、可选原始歌词文件保存。无需修改第三方插件源码或新增 provider 方法；歌词继续调用版本化 `getLyrics`，可用性取决于音源能力。任务快照新增可选 `qualityVerified` 和 `warning`，`actualQuality` 优先使用下载文件的解析结果，解析失败则明确标注音源报告。请求 Hi-Res 而文件为 Lossless 时同时展示两者，不把请求选项当成实际品质。下载的编码由音源决定，宿主不转码、不生成不存在的高解析音频。
