# 第三阶段：远程曲库管理协议与 Android 客户端

更新：2026-11-04。Android 已加入 Focus、标签目录、Server 歌单和任意声区／同步组的选歌与队列工作区。当前代码位于两端工作区和 `out/server`；新的工作区版 Server 包与 APK 见[使用与交付记录](./session-queues-mobile.md)。此前的 `-upgrade.zip` 仍是旧维护版本。

## 不回电脑也能选歌和整理曲库

- 音乐库先选择一台已连接的电脑，再点顶部「管理」，进入 Focus、标签和 Server 歌单。资料始终写入正在浏览的电脑。
- 声区详情／同步组详情点「选歌与队列」，搜索电脑曲库、选择具体音源。电脑专辑详情的歌曲菜单也提供「播放到声区…」。
- 选择目标后，明确确认「替换并播放」或「仅载入，保持暂停」。这不改变底部主播放栏的控制对象，也不改变手机本地队列。
- 队列可以逐项播放、移除、上下移动、切换随机／原始顺序和确认清空；重复歌曲按 occurrence 分别处理。

Focus 支持歌曲／发行版、在库／全部资料、常用条件的 all／any／not 组合、流派／音源／偏好分面、标签条件、排序，以及保存／重命名／更新／删除。已保存查询中未由快捷编辑器展开的高级条件保留原树，不在显示时改写。标签目录支持分页、成员浏览与移除、创建／重命名／删除。Server 歌单支持分页、新建／复制／重命名／删除／置顶、添加音源、成员移除与上下移动；手机原有本地歌单继续独立。

新增 `zones.queue.page/load/edit/select` 以明确的 Zone／组身份、会话版本和 SQL 队列版本工作。替换确认还携带当时的选中 occurrence；分组成员不能借独立队列接口修改冻结的原队列。Core 复用原 Focus／标签的完整冻结分页、歌单视图和 SQL 队列构建，不用可见第一页代替完整集合。普通歌单仍按原规则去重，播放队列则保留重复 occurrence。

写入时保留原电脑 generation／Core epoch，面板暂不允许关闭或切换。失败结果不自动重放；结果不确定或回读失败时，重新读取核对后才重新开放写操作。详情见[使用与交付记录](./session-queues-mobile.md)。

## 手机修改 Server 的同一份资料

配对后的 TLS 客户端可以操作 Focus、个人评分／收藏、标签、Server 歌单和人工资料。业务判断、SQLite 查询、CAS 与持久化仍由原 Core 服务负责；没有为手机复制另一份曲库。

| 功能 | 公共操作 | 保留的合同 |
| --- | --- | --- |
| Focus | `focus.query`、`focus.facets`、`focus.saved.list/create/rename/update/delete`、`focus.play`、`focus.play.status` | 完整查询树、冻结分页 token、保存名称／查询各自 revision；播放结果按原请求身份查询 |
| 标签 | `tags.list/entity/members/recordings`、`tags.create/rename/delete/member.set/play` | 具体 Catalog 实体、名称／成员 revision、分页 token |
| 评分与收藏 | `ratings.detail/targets/history/set`、`preferences.detail/targets/history/set` | 评分为 1–10 个半星档或显式清除；收藏／禁播／清除使用原身份与 CAS token |
| 歌单 | `playlists.catalog/members/edit/addSources` | 分页和整体 revision；添加使用稳定 Catalog source ID，不接收客户端文件路径或 TrackData |
| 人工资料 | `metadata.entity.override/sourcePreference/artworkOverride` | 原元数据 revision，设置／清除／重置与资料来源选择；人工图片仍受原位图格式及容量约束 |

`playlists.edit` 的网络子集包含新建、重命名、复制、删除、置顶、个人封面、删除／移动／重排成员，以及导入歌单条目移除。读取 `playlists.members` 得到的 `remote-member:` 是会话引用；修改时验证设备、歌单、revision 后才转换为内部成员 ID。原文件路径不进入手机结果。

`playlists.addSources` 每次最多 200 个来源，Core 在同一 Catalog revision 下解析全部来源，再提交一次原歌单事务。它不下载或播放来源。更多条目按返回的歌单 revision 分批提交，不能把批量上限当成歌单总容量。

## 设备、曲库与播放路由分开

旧遥控／浏览客户端权限不变。新增管理请求要求已经配对的设备身份及实际 TLS 连接；payload 和代理头不能声明自己具备这些条件。每个配对设备使用独立的内部 Core 客户端，只有这组受限接口可使用其曲库写权限；网络仍不能发起任意 settings、文件删除、服务生命周期或目录授权操作。

命令去重按设备与 command ID 区分。Focus 播放把原 command ID 带给 Core；若响应丢失，使用 `focus.play.status` 读取该设备的结果，不重复播放。两个在途请求使用相同 request ID 时，第二个不会覆盖第一个的响应接收者。

Android 的 [DesktopLibraryManagementClient](D:/Project/Twilight_Echo_Android/core-client/src/main/kotlin/com/twilightecho/android/coreclient/DesktopLibraryManagement.kt) 使用宿主的 **libraryTransport**，不跟随声音输出切换。调用前捕获 `DesktopLibraryScope(generation, epoch)`；后续写入使用该 scope 与读到的 CAS token。换电脑、切回手机或 Core 重启后，旧界面的操作会要求重新读取，不转发到新目标。取消正常传播，失败命令不自动重放。

Android 已提供评分／收藏、标签 CRUD／成员、Focus 查询／分面／保存／播放回执、歌单列表／成员／编辑／添加，以及资料文字／图片／来源的类型化方法。Core 快照增加相应域 revision，供页面按变化刷新。

## 在手机上整理具体歌曲、发行版和艺人

先在音乐库的设备筛选中选择已连接的电脑。打开专辑详情，点「整理资料与个人偏好」；曲目右侧菜单可分别整理歌曲或它的具体发行版。艺人合集里的「整理电脑上的艺人资料」列出该合集实际 Catalog 成员的来源，选择后进入原始来源详情，不把合并显示的同名艺人当成同一个可写身份。

[实体整理表单](D:/Project/Twilight_Echo_Android/feature/player/src/main/kotlin/com/twilightecho/android/feature/player/DesktopEntityEditorSheet.kt)支持：

- 0.5–5 星半星档与清除评分；收藏、禁播和无偏好。
- 添加／移除标签、新建并添加。已分配标签和全部候选标签都按同一 token 读完分页；超过 100 个不会遗漏成员。新建成功但分配失败时保留新标签，并显示「已创建，尚未添加」。
- 保存／隐藏／恢复自动简介，切换可用资料来源，选择／隐藏／恢复自动图片。评分或标签更新不覆盖正在输入的简介草稿。

评分、偏好和标签按精确实体处理。聚合版本有多个物理目标时，用户先明确选择；`album_project` 只提供资料编辑，具体发行版从曲目菜单进入。未确认身份的艺人不显示评分／偏好写入口，仍可整理其精确来源的标签与资料。

[编辑状态机](D:/Project/Twilight_Echo_Android/feature/player/src/main/kotlin/com/twilightecho/android/feature/player/DesktopEntityEditorPresenter.kt)捕获电脑 generation、Core epoch 和会话编号。读请求离页可取消；提交中的写操作不因关闭面板而取消或自动重放，关闭按钮暂时禁用。换电脑／重启后旧结果不进入新会话。文件选择器也携带原会话票据，迟到的选图不会上传到后来打开的实体。保存成功后的重新读取若失败，保留保存回执并单独提示读取错误；旧 CAS／不确定结果需明确刷新核对。大型标签列表不会阻塞已经读完的评分或资料编辑。

Android 复用背景图片导入的采样解码和 EXIF 方向处理；个人图片最长边不超过 1536 像素，编码为受 2 MiB 上限约束的 WebP，不修改手机原图或背景设置。远程 RPC 请求上限现容纳该位图的 base64 与 envelope，其他 POST 入口仍保留 64 KiB 上限。

## 无头 Server 可以回显大封面

[Server 图片运行时](D:/Project/Twilight_Echo/src/main/server/imageResize.ts)复用现有 `pngjs` 和 FFmpeg／swscale，输出最长边不超过 500 像素、编码不超过 180000 字节的 PNG 预览，保留透明度和宽高比的整像素取整。现有 FFmpeg 构建没有 PNG 编解码器，因此 PNG 解码／编码由已安装的 `pngjs` 负责，JPEG／WebP 解码和统一缩放由独立 `twilight_image_node.node` 负责；不加载 Electron 或音频引擎、不打开设备，也不改变原图。

原生模块随现有 CMake 构建和暂存入口产出；新 Server 打包要求带上它，旧桌面纯播放打包合同不增加这项要求。生产联调覆盖超过旧 64 KiB 请求上限的完整 PNG，写入、预览、隐藏、恢复自动图片及旧元数据 revision 拒绝。

## 真实 TLS 与 SQLite 已验证

- [生产联调](D:/Project/Twilight_Echo/.remote-library-production.log)：无 Electron 的 `service-child`、真实配对 TLS、原 Core 和 SQLite。完成 4.5 星评分、收藏、标签成员、三条件 Focus 命中、保存／重命名／更新 Focus、创建／添加／重命名／移除歌单成员及人工简介；拒绝旧 token 和重复 command ID。原模拟 DAC PCM 链路继续通过，不打开本机设备。
- [109 项回归](D:/Project/Twilight_Echo/.remote-library-regression.log)：Core 权限与 Catalog 来源解析、原遥控／HTTP／媒体调用、设备隔离、路径投影、重复请求、Focus 回执、歌单持久化和个人偏好。
- 联调修复了已有收藏投影问题：Catalog 的展示快照故意不含路径，不能直接作为本地收藏的私有来源快照。当前从精确本地行建立快照；离线或同 Track ID 文件已替换时，保留原 Catalog source key 的路径／子轨／CUE 身份，不绑定替换文件。普通歌单保存与离线身份两项回归通过，公开 Catalog 快照仍不含路径。
- [Android 软件验证](D:/Project/Twilight_Echo_Android/.remote-library-android-build.log)：Core client 共 **154 项通过**，其中新增 5 项覆盖真实 Server DTO、分页 token、路由切换、旧 epoch、取消和不确定播放回执。Player／宿主 Kotlin 编译通过。测试读取[真实 TLS 联调生成的样例](D:/Project/Twilight_Echo_Android/core-client/src/test/resources/desktop-library-wire.json)，不以手写 DTO 样例代替两端合同。
- [Core 类型检查](D:/Project/Twilight_Echo/.remote-library-core-types.log)、[Node 类型检查](D:/Project/Twilight_Echo/.remote-library-node-types.log)、[相关代码 lint](D:/Project/Twilight_Echo/.remote-library-lint.log)与[测试归属门禁](D:/Project/Twilight_Echo/.remote-library-gate.log)通过。

实体界面这轮的软件证据：

- [Android 构建／单测](D:/Project/Twilight_Echo_Android/.remote-library-editor-android-final.log)：Core client 154 项、Player 151 项通过；其中编辑状态机 10 项覆盖具体版本选择、205 个候选／151 个已分配标签、部分提交、旧会话／选图票据、迟到读取、不确定写结果及独立域加载。艺人编辑来源另有精确成员回归。
- [原生图片与 Server 测试](D:/Project/Twilight_Echo/.server-artwork-native-tests.log)：真实 PNG／JPEG／WebP 解码缩放、透明度、容量和路径边界。已检查原生生成的预览图。
- [新生产联调](D:/Project/Twilight_Echo/.remote-library-editor-production.log)：原 54 项回归与真实配对 TLS／Core／SQLite／模拟 DAC 链路、大图设定／清除／重置通过。[HTTP 15 项](D:/Project/Twilight_Echo/.remote-library-artwork-http.log)验证原授权与旧入口容量合同。
- [Node 类型检查](D:/Project/Twilight_Echo/.remote-library-editor-node-types.log)、[Core 类型检查](D:/Project/Twilight_Echo/.remote-library-editor-core-types.log)、[lint](D:/Project/Twilight_Echo/.remote-library-editor-lint.log)、[归属／打包门禁](D:/Project/Twilight_Echo/.remote-library-editor-gates.log)通过。
- [独立目录交付联调](D:/Project/Twilight_Echo/.remote-library-editor-package-integration.log)用新自包含目录内的 Node、原生服务宿主、依赖和图片模块重走配对 TLS、真实 SQLite、资料／大图管理及模拟 DAC 链路，通过。目录为 `C:\Users\XOS\AppData\Local\Temp\TwilightEchoServer-entity-editor-1793683580806`，不依赖源码目录作为运行根；本轮未制作新的 ZIP，旧 ZIP 仍保持原版本内容。

复现桌面软件联调：

```powershell
cd D:\Project\Twilight_Echo
node --run test:remote-library
```

更新跨语言样例时，在同一测试中明确设置 `TWILIGHT_REMOTE_LIBRARY_SAMPLES` 为 Android 资源文件绝对路径；普通运行不会改写该样例。Android 使用现有离线 Gradle：

```powershell
cd D:\Project\Twilight_Echo_Android
.\gradlew.bat :core-client:test :feature:player:compileDebugKotlin --offline
```

## 后续范围

无 GUI DSP 资产／插件管理、NAS／容器交付继续实施，再推进第四阶段。新增工作区的模拟 Core 页面检查与软件联调记录在[使用与交付记录](./session-queues-mobile.md)；实体资料表单的图片转换实机检查、实际 SCM／服务账号、真实手机／双机／DAC 验收仍保留后置安排。
