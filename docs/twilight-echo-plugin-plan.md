# Twilight Echo 插件系统 — 分阶段实施计划

> 配套文档：《Twilight Echo 插件系统规范》（twilight-echo-plugin-spec.md）
> 版本：v0.1（2026-06-10）
> 适用项目：Twilight Echo（Electron + Vue 3 + TypeScript + Twilight Audio Engine C++20）

## 总体架构定位：双轨插件体系

| 轨道                          | 语言/载体                       | 覆盖类型                        | 运行位置                               |
| ----------------------------- | ------------------------------- | ------------------------------- | -------------------------------------- |
| **JS 插件**（主体生态）       | TypeScript/JavaScript 包        | 音源/内容、工具/自动化、UI/主题 | 主进程侧插件宿主进程 + Renderer 注入点 |
| **原生 DSP 插件**（高阶生态） | C ABI 动态库（.dll/.so/.dylib） | 音频效果器                      | Twilight Audio Engine 进程内 DSP 管线  |

**关键原则：两轨完全独立演进。**
JS 插件 API 与 DSP C ABI 各自有独立版本号、独立的稳定性承诺。绝大多数开发者只接触 JS 轨道；DSP 轨道门槛高、风险高，单独管理。

生态定位决策（已确认）：

- 插件类型：音源/内容、音频 DSP、UI/主题、工具/自动化 全覆盖
- 目标开发者：第三方开放生态
- 安全模式：信任式安装（保留收紧空间，见风险章节）
- MVP 优先级：通用插件框架先行

---

## Phase 0 — 规范定稿（只写文档，不写代码）

**目标**：在动手前锁定所有格式与契约，避免返工。

### 任务

1. 定稿 manifest 规范、插件包格式、API 命名空间、版本策略（即配套规范文档）。
2. 盘点宿主能力清单：梳理现有 `usePlayerStore` / `useMusicStore` / `useNcmStore` / `useSettingsStore`、主进程 IPC 通道、`audioEngineManager` 中可暴露给插件的能力，形成 API 草案。
3. 产出物：
   - `docs/twilight-echo-plugin-spec.md`（权威规范）
   - `docs/PLUGIN_README.md`（开发导读）
   - `packages/plugin-api` 与 `packages/create-twilight-plugin`（类型和脚手架/打包工具）

### 验收标准

- 能用规范在纸面上完整描述"一个 Bilibili 音源插件"和"一个 Discord 状态同步插件"，且**不需要修改规范本身**。

---

## Phase 1 — 通用插件框架 MVP

**目标**：插件能被发现、安装、加载、停用、卸载，且任何插件故障不影响播放链路。

### 任务

1. **插件宿主（Plugin Host）**
   - 主进程中的插件管理器：发现（扫描插件目录）、解析 manifest、校验 `engines` 兼容范围、按依赖序加载、激活/停用、卸载、崩溃捕获。
   - 依赖由 manifest 可选 `dependencies` 声明；Phase 1 只做启用校验与拓扑加载，不做自动安装或自动启用。
   - JS 插件运行在独立 `utilityProcess` 插件宿主进程中，通过 IPC 与主进程 API 网关通信（目的：崩溃隔离与可观测性，而非安全沙箱）。
2. **生命周期**
   - `activate(context)` / `deactivate()`；context 注入 API 句柄、插件私有存储目录、设置读写、日志器。
3. **API 网关**
   - 插件不直接 import 内部模块，只能通过有版本号的 `twilight` API 对象访问宿主能力。这是后续兼容性的生命线。
4. **插件管理 UI**
   - 设置页新增"插件"标签：插件列表、启用/禁用、权限声明展示、错误状态、从本地文件安装。
5. **错误隔离**
   - 单个插件抛错 → 标记失败并停用，不影响播放链路。
   - 启动时坏插件不阻塞应用启动。
   - 每个插件独立日志通道：`logs/plugins/<id>.log`，管理页可查看。

### 验收标准

- 写一个 hello-world 工具插件（如"曲目切换时输出日志"），可完成 安装 → 启用 → 禁用 → 卸载 全流程。
- 插件内故意抛错/死循环，应用与播放功能无感。

---

## Phase 2 — 音源 Provider 扩展点 + Dogfooding

**目标**：第三方可以按文档接入新音源；官方网易云功能跑在插件 API 上以验证其完整性。

### 任务

1. 定义 `MediaProvider` 接口：搜索、获取播放 URL/流、歌词、封面、歌单、登录态（可选实现）。
2. **将网易云接入重构为第一个自带基础插件**——随软件分发、默认启用、插件页可见，可停用但不可卸载；这是检验 API 完整性的唯一可靠手段。
3. 统一多音源数据模型：曲目 ID 带 provider 前缀，来源标识贯穿播放队列、音乐库与会话持久化。

### 验收标准

- 网易云以自带基础插件形式存在；禁用它后应用其余功能（本地库、播放、设置）完全正常，并在流媒体页明确提示网易云插件已停用。
- 第三方按文档可写出新音源插件，并出现在搜索/播放流程中。

---

## Phase 3 — 工具/自动化 + UI/主题扩展点

**目标**：开放事件订阅与克制的 UI 注入能力。

### 任务

1. **事件总线**：曲目切换、播放/暂停、进度、队列变更、应用启停等事件订阅（工具类插件的核心）。
2. **UI 扩展点**（克制地开放）：
   - 侧边栏自定义页面（宿主渲染受控页面壳，插件通过 command 提供业务动作）
   - PlayerBar 附加按钮
   - 设置页插件配置区
   - 主题：CSS 变量包 + 自定义样式表，用户显式选择后一次只应用一个插件主题
   - API v1 主题可选提供 schemaVersion 1 的结构化明暗令牌；API v2 追加 schemaVersion 2 的宿主注册 modes；旧 variables + stylesheet 保持兼容
3. UI 插件代码在 renderer 中以受控方式注入；业务逻辑仍在宿主进程，渲染入口只拿到受限桥接对象。主题类插件只允许声明式样式，不执行脚本。
4. UI command 使用 request/response 与短超时隔离；command 抛错或超时只影响所属插件，不阻塞 renderer。

### 验收标准

- 示例插件落地："scrobbler 播放上报"（事件订阅 + PlayerBar / 设置页 / 侧边栏受控入口）+ 一个可在外观页选择的深色主题包。

---

## Phase 4 — DSP 原生插件 C ABI

**目标**：外部原生效果器可挂入引擎 DSP 链，且故障可自动 bypass 与恢复。

### 任务

1. 将引擎内 `PluginRegistry` 做实：定义稳定 C ABI（见规范文档第 5 节），加载外部动态库挂入 DSP 链（与现有 EQ / FIR Convolver / Crossfeed 同级）。
2. 插件管理 UI 中 DSP 插件单独分区，明确标注："原生插件运行在可重启音频服务内，崩溃会触发音频服务恢复"。
3. 引擎侧防护：加载失败 / 处理超时 / 异常时自动 bypass，并通过 `GetPlaybackInfo()` 诊断字段上报（沿用现有 recovery diagnostics 思路）。
4. DSD / passthrough 路径下 DSP 插件自动 bypass（与现有 `outputPerfect` 语义一致）。

### 验收标准

- 将现有某个内置 DSP（如 Crossfeed）用插件 ABI 重新封装并跑通。
- 一个故意崩溃的测试插件不会杀死整个应用（引擎可恢复或可重启）。

### 当前实现说明

- ABI v1 已落地为 Twilight Echo 自有 C ABI，当前范围限定为 float32 interleaved PCM。
- 宿主可安装并启用纯 DSP 插件；纯 DSP 插件不启动 JS 宿主，只更新 native DSP chain。
- `GetPlaybackInfo()` 通过 `outputInfo.nativeDsp` 暴露 DSP 插件诊断、参数元数据与
  当前值；DSD / passthrough 路径自动旁路 DSP v1。
- 官方 Crossfeed ABI 示例和 crash fixture 用于验收；硬崩溃插件应只杀死并重启音频
  服务，不退出主应用。

---

## Phase 5 — 生态建设

**目标**：让第三方开发者"开箱即写"，让用户应用内可发现插件。

### 任务

1. 插件打包格式定稿 + CLI 脚手架（`create-twilight-plugin` 模板仓库，含 lint/test/打包脚本）。
2. 插件索引/市场：起步可为 GitHub 仓库托管的 `plugins.json` 索引 + 应用内浏览安装。
3. 开发者文档站；发布纯类型包 `@twilight-echo/plugin-api` 到 npm。
4. 可选签名机制启用评估（manifest 已预留 `signature` 字段）。

### 验收标准

- 新开发者从模板到可运行插件 ≤ 30 分钟。
- 应用内可浏览索引并一键安装插件。

### 当前实现说明

- Phase 5 采用“本地可发布”范围：仓库内提供 `packages/plugin-api`、`packages/create-twilight-plugin`、官方模板、本地静态索引和应用内市场，不实际发布 npm 包或创建远程 GitHub 仓库。
- `create-twilight-plugin init` 生成 `tool`、`provider`、`ui-tool`、`theme` 插件项目；`create-twilight-plugin pack` 生成 `.tep` 并排除 `node_modules`、缓存和构建噪声。
- `resources/plugin-index/plugins.json` 是 schemaVersion 1 的随包离线发现快照，不承担官方审核或信任根语义；索引包安装前校验 URL 协议、大小、sha256 和包内 manifest，并禁止覆盖内置网易云插件。
- 插件管理页展示派生的 `official` / `publisher-signed` / `index-declared` / `unverified` 信任级别、权限、兼容/已安装/可更新状态。`verified` 仅为索引声明；官方徽章还要求固定官方 URL、fresh 远程直连、origin/有效期证据和 active trusted Ed25519 signature。
- manifest 的 `main` / `icon` / `binary.*` 路径使用 POSIX `/` 做跨平台 canonical normalization，拒绝 Windows/POSIX absolute、UNC/rooted 与越界 traversal；Windows host 和 Linux signer 因此签署同一 payload。
- 远程索引 cache 使用 envelope 持久化 `origin` / `fetchedAt` / `expiresAt`；cache/legacy/bundled fallback 均不能升级信任。`list`、status 与 download 每次按当前时间重验 TTL 和 publisher key validity，resident entry 不保留过期 official。安装确认页展示实际/配置索引来源、缓存与过期状态、索引期望及最终 staged 包实际 SHA-256、签名 key/fingerprint/status、权限和任意代码执行风险；两次 hash 不同则在确认前拒绝。
- 重叠 refresh 由单调 generation 保证 latest-request-wins，旧响应不能覆盖内存状态或磁盘 cache；下载阶段绑定 origin + 完整 entry canonical 指纹，索引在下载期间修改 manifest、source URL、审核声明、签名或 checksum 均会中止安装。
- 可信发布者注册表支持多 active key、有效期和吊销以完成轮换；生产私钥仅存在于外部插件仓库的受保护发布流程，不进入应用仓库。正式公钥配置前注册表为空，未签名条目不会获得官方徽章。
- Bilibili 收藏夹音频 Provider 示例作为独立插件仓库发布：它是第三方
  `provider + ui` 插件，需要用户通过远程插件索引安装并启用；登录后通过 Provider
  API 暴露收藏夹和 `bili:<bvid>:<cid>` 音频 track，播放 URL 由插件维护的
  `127.0.0.1` loopback 代理提供。远程索引可先指向 GitHub raw JSON，后续可用
  `TWILIGHT_PLUGIN_INDEX_URL` 切换到自托管 HTTPS `plugins.json`。
- 第三方插件源码不再写入 Twilight Echo 主项目。后续新增第三方插件统一写入
  `D:\Twilight-Echo-plugins`，对应 GitHub 仓库为
  `https://github.com/Px-asen/Twilight-Echo-plugins/`；主项目只实现通用宿主能力，
  通过远程 `plugins.json` 消费插件。

---

## 质量与生态标准（贯穿各阶段）

- 官方维护：API typings 包、插件模板、每类插件至少一个官方示例。
- 文档要求：每个扩展点具备"概念说明 + 完整示例 + API 参考"三件套。
- 宿主侧 CI：插件 API 网关有契约测试（保证版本承诺）；网易云内置插件作为回归基准。
- 索引收录标准：开源、有 README、权限声明与实际行为一致、通过基本冒烟测试。

---

## 关键风险与对策

| #   | 风险                                                                  | 对策                                                                                                                                                |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **"开放生态 + 信任式安装"长期不可持续**：生态有规模后恶意插件必然出现 | 架构上预留收紧空间（utilityProcess 宿主 + API 网关 + 强制权限声明），未来切换强制权限只需在网关层加闸；Phase 5 前重新评估，至少对索引内插件引入签名 |
| 2   | **DSP 插件为同进程原生代码**，崩溃隔离只能依赖引擎进程级恢复          | Phase 4 默认使用可重启 Audio Engine Service 承载 native addon 和 DSP 动态库；崩溃后主进程标记 DSP 插件失败并清空 chain                              |
| 3   | **网易云插件化是最大重构**（Phase 2）                                 | 不建议跳过——跳过则 API 设计必然脱离实际；可拆分为接口先行、逐模块迁移                                                                               |
| 4   | 音源插件涉及第三方平台版权与 ToS                                      | 生态规范要求插件自行承担合规责任；官方索引对明显侵权源不收录                                                                                        |
