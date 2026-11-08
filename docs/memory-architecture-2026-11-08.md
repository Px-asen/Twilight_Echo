# 前台常驻内存架构重构（2026-11-08）

新架构保留为显式试用路径。默认仍使用 Electron utility host；前台播放总私有工作集降低 30% 的生产验收尚未完成，不能据此发布默认切换。

## 运行新宿主

本地构建桌面与独立后台后，使用同一桌面配置启动：

```powershell
pnpm run build
pnpm run build:desktop-core
$env:TWILIGHT_CORE_HOST = 'node'
pnpm start
```

安装包使用 `TwilightEcho.exe --core-host=node`。明确回退使用 `--core-host=electron`，或移除环境变量后按默认方式启动。缺少运行时、平台不匹配或启动失败时会报错，不会静默更换宿主。

Windows x64 的现有打包入口会先暂存 Node v24.21.0、完整许可证、生产依赖和服务入口，再校验成品。构建机可通过 `TWILIGHT_DESKTOP_NODE_EXECUTABLE` 指定该版本的绝对路径；终端用户无需安装 Node。运行时位于安装目录的 `resources/core-node`，处于 `app.asar` 外。macOS/Linux 继续原有打包与默认宿主。

## 后台与服务生命周期

- Electron 主进程继续拥有窗口、权限桥和紧急停止音频的监督通道。桌面配置和数据库路径直接传给现有 Core，没有创建 Server profile。
- Core、数据库、音频、扫描、分析、模型安装和插件宿主使用同一打包 Node。业务数据通过现有私有 socket 直连，数据库、音频与插件仍分别隔离。
- Electron 与 Node 的 V8 序列化版本不同，监督通道改为有版本的类型编码，保留二进制、Map、Set、BigInt、循环和共享引用。纯 Server 默认传输保持原样。
- 桌面后台以一个 Rollup 模块图构建共享 CJS chunk，延迟功能不会复制 Core ports 单例。备份、导入、重复检测、体检、云传输和插件市场按需构造；状态查询读取轻量状态。恢复日志和持久待处理导入仍按原条件恢复。
- 模型安装独立进程在完成、取消和平台子任务收尾后退出。已执行但回执丢失的写操作不自动重放。

## 页面和浏览缓存

流媒体详情栈保存 Core 会话句柄，页面退出后保存筛选、排序、滚动、详情历史和草稿状态。曲目以每页最多 200 条写入 profile 下独立的 `browse-cache`，展示窗口最多 5 页；流媒体详情使用 4 页，为同页面的小型推荐和搜索显示留出预算。历史页面不再保留组件、整份曲目数组或分页加载函数。

完整播放、随机播放、全选、收藏、移除、复制与加入歌单从完整会话逐页读取。未知总数的来源在全选前完成计数。Bilibili 分 P 的折叠、组内翻页和完整播放分别处理，折叠状态不会缩短播放队列。

缓存按窗口、提供方、账号上下文和插件数据版本校验。退出导航会话释放引用；注销清理相关页面与草稿，迟到响应不能重建旧账号数据。Core 替换后的旧 epoch 句柄作废，下一次缓存写入清理遗留 epoch 目录。普通组件卸载不会重新联网获取已浏览页。

外观与音频工作台卸载组件后保存独立 JSON 状态，恢复草稿、Undo、编辑位置和预览相机。进行中的保存先收尾；原有离开确认和独立 DSP 窗口行为保持。

## 已有验证

以下测试使用合成 profile，不访问实际账号或用户曲库。

| 验证 | 结果与范围 |
| --- | --- |
| 生产构建、Core/Node/Web 类型检查 | 已通过；最终产物位于 `.artifacts/memory-architecture-20261108/production` |
| 架构专项 | 包含运行时打包、跨版本传输、懒加载、模型进程、浏览缓存及草稿恢复 |
| 真实桌面 Node 集成 | SQLite、桌面权限拒绝/授权、原生音频/DSP 握手、数据库和插件独立故障、音频恢复、取消、未知写结果不重放、Core 自动恢复及明确重试、退出清理通过 |
| 纯 Server 回归 | 真实 SQLite、直接服务通信、数据库/Core 恢复、多音区队列恢复及退出通过 |
| 10 万条缓存深页读取 | 20 次 bounded window 恢复，p95 约 4 ms；仅磁盘和服务/窗口逻辑，不包含跨进程 IPC 与 DOM |
| 真实流媒体页面恢复 | 4,201 条、50 轮卸载/恢复，深页位置和草稿保持；播放全部覆盖 4,201 条；最终隔离 UI 运行的 p95 为 73.7 ms，包含 IPC 与 DOM 恢复 |
| 视觉和交互 | 明暗主题、宽/窄屏、人物列表返回、详情页、播放定位、虚拟列表、外观确认与主题草稿恢复通过 |

UI 行为测试沿用仓库既有的隔离 `--no-sandbox` 测试方式，能验证功能与布局，不能用于生产内存验收。图片清晰度、渲染分辨率、玻璃效果和音频算法未作为压缩手段。

## 尚未通过的发布门槛

本环境中的工作区 Electron 启动正常沙箱空白 renderer 会退出，代码为 `-2147483645`。复制到不同完整性级别的目录可以加载，但这改变了执行环境，未用于正式对照，也未修改系统 ACL 或降低生产沙箱要求。此前低于 1 GiB 可用物理内存而中止的运行同样不计入结果。

因此以下要求仍待在正常桌面执行环境中验收：

- 1,057、10,000、100,000 条曲库各三次，空闲、完整主窗口播放、暂停和返回曲库的整进程私有工作集/提交量对照，GPU 单列。
- 常用规模前台播放中位数至少下降 30%，10 万条没有新增无界增长。
- 30 分钟完整播放，以及实际 WASAPI/ASIO、无缝播放、多音区和音频桥的端到端体验。

基线保留在 `.artifacts/steady-memory-20261108/production`。使用相同硬件、窗口、DPI、沙箱和负载依次运行：

```powershell
node scripts/benchmark-memory.cjs --build-root .artifacts/steady-memory-20261108/production --core-host electron --output .artifacts/architecture-before
node scripts/benchmark-memory.cjs --build-root .artifacts/memory-architecture-20261108/production --core-host node --output .artifacts/architecture-after
node scripts/compare-memory.cjs .artifacts/architecture-before/report.json .artifacts/architecture-after/report.json
```

默认基准包含三次重复、50 轮导航和 30 分钟播放。比较器拒绝压力中止、不完整负载和不同窗口/DPI的数据；报告重复间的中位数与范围，同时列出私有提交量和 GPU。内存比较通过也不替代音频、页面恢复和兼容性门槛。

复核入口：`pnpm run test:memory-architecture`；真实宿主集成：设置 `TWILIGHT_DESKTOP_TEST_BUILD_ROOT` 为候选目录后运行 `pnpm run test:core:desktop-node`。详细日志、失败诊断和 UI 截图在 `.artifacts/memory-architecture-20261108`。
