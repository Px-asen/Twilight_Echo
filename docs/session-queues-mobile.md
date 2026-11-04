# 用手机给声区选歌，管理 Server 曲库

更新：2026-11-04。

## 选择音乐到具体声区

1. 手机配对 Core，选择「控制电脑」。打开「声区」，进入一个声区或同步组，点「选歌与队列」。
2. 搜索歌曲，打开结果并勾选具体音源。也可以在电脑专辑详情的歌曲菜单点「播放到声区…」。
3. 选择目标声区／同步组，点载入，再明确选择「替换并播放」或「仅载入，保持暂停」。离线 Bridge 可以先建立暂停队列。
4. 切到「队列」查看后续分页、点击具体项播放、移除或上下移动；也可随机排序、恢复原始顺序，或确认清空。

底部主播放栏继续控制原主会话。手机本地音乐和原有电脑文件串流入口不变。

搜索与目标来自同一个 Core。声区页跟随播放控制电脑；专辑详情、Focus、标签和 Server 歌单跟随正在浏览的曲库电脑。选择来源时记录的连接 generation 与 Core epoch 会随操作保留，不能把旧电脑的来源发给后来切换的电脑。

## Focus、标签与 Server 歌单

在音乐库的设备菜单选择已连接的电脑，点顶部「管理」。

- **Focus：** 组合关键词、评分、年份、来源／格式、偏好、最近未播放天数；条件支持全部满足、任一满足和排除。流派／来源／偏好分面、标签条件可继续收窄结果。可切换歌曲／发行版、在库／全部资料、排序，保存／更新／重命名／删除条件，并将完整结果播放到所选声区。高级保存条件在快捷编辑器中保留原树。
- **标签：** 创建、重命名、删除，分页浏览标签与成员，移除成员，将标签中的完整库内音乐载入声区。给具体歌曲／发行版／艺人添加标签继续使用资料整理表单。
- **Server 歌单：** 新建、复制、重命名、删除、置顶，分页浏览成员，从电脑曲库选择音源添加、移除／上下移动成员，并载入声区。它与手机本地歌单分别保存。

添加音源单次最多 200 个；Focus、标签和歌单播放由 Core 分页构建完整队列，不受手机当前可见页限制。普通歌单沿用同一曲目身份去重；直接选歌建立的播放队列保留重复 occurrence。

## 对结果不确定时先核对

写入中的面板暂不能关闭或换目标。命令不自动重试；旧版本、断连或回读失败后，先点「重新读取」／「刷新」核对。旧窗口不能把一次点击改发到新电脑。清空队列与删除标签／歌单都有确认，不删除音乐文件。

## 软件证据

- Core／Node 类型检查和变更文件 ESLint 通过。Core 应用、Zone／同步组、Focus／标签与远程网关的相关回归 **101 项通过**，包含 SQL 重复 occurrence、会话隔离、编组冻结、替换确认、准备中 Stop、TLS、路径投影与旧版本拒绝。[日志](../.session-workspace-regression.log)。
- 真实独立 Node Server、配对 TLS、Core／SQLite 与模拟 DAC 的 **2 项生产联调通过**；覆盖 Catalog／标签／Focus／Server 歌单加载、重复 occurrence、移除与旧版本拒绝。旧资料与大图管理链路继续通过。[日志](../.session-queue-production.log)。
- Android Core client **168 项**、Player **202 项**软件测试通过，使用[真实 Server 样例](D:/Project/Twilight_Echo_Android/core-client/src/test/resources/desktop-session-wire.json)核对新增 DTO；覆盖跨电脑／epoch、原目标确认、结果不确定不重发、105 项分页和保存查询树。最新构建见[日志](D:/Project/Twilight_Echo_Android/build/session-workspace-delivery-build.log)。
- 独立 API 36 模拟器上 **4 项界面交互检查通过**：选择目标声区／音源并确认暂停载入、重复 occurrence 队列移动、Focus 组合条件、标签成员与 Server 歌单入口。页面使用模拟 Core 状态，不连接真实设备或 DAC。[日志](D:/Project/Twilight_Echo_Android/build/session-workspace-ui.log)与[截图](D:/Project/Twilight_Echo_Android/build/session-workspace-qa/workspace-shots)。

复现：

```powershell
cd D:\Project\Twilight_Echo
node --run test:remote-library
node --run test:audio-sync-groups

cd D:\Project\Twilight_Echo_Android
.\gradlew.bat :core-client:test :feature:player:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest --offline
```

## 交付与继续事项

两端需一起更新：新增会话队列接口在旧 Server ZIP 中不存在。当前 Android Debug APK 位于 `D:/Project/Twilight_Echo_Android/app/build/outputs/apk/debug/app-debug.apk`。

- [Server Windows x64 工作区版 ZIP](D:/Project/Twilight_Echo/dist/TwilightEchoServer-1.4.0-win32-x64-workspace-20261104.zip)，**111,956,880 字节、5,640 个文件**，版本仍为 1.4.0；含 Node 24.21.0、283 个实际安装依赖位置、图片运行时及新接口。旧包保留。
- [传输校验文件](D:/Project/Twilight_Echo/dist/TwilightEchoServer-1.4.0-win32-x64-workspace-20261104.zip.sha256)沿用现有发布格式。
- 从最终 ZIP 解压后，包内 Node／原生宿主／依赖在源码目录外完成 **3 项交付验证**：自包含入口、迁入卷积的 TLS／模拟 DAC PCM、显式声区的四类选歌／队列编辑及重复 occurrence 播放。没有全局 Node 或 Electron 运行依赖。[日志](../.session-workspace-package-integration.log)。
- 现有 Electron 桌面入口也已重建至 `D:/Project/Twilight_Echo/out`，采用同一 Core 接口；[构建日志](../.session-workspace-desktop-build.log)。这不是新的桌面安装包。

后续同日已增加逐声区 DSP 资料、场景与 VST3 日常管理，见[管理入口与新包](./server-dsp-library.md)。NAS／容器、WAN／离线／移动网络策略／Android Auto 继续按原路线推进。真实手机、双机／DAC 和 SCM／服务账号验收保留原后置安排。
