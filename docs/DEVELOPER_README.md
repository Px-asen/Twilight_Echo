# Twilight Echo 应用开发入门

修改桌面应用从这里开始；开发扩展请阅读 [插件开发导读](./PLUGIN_README.md)。

## 安装并运行

使用 Node.js 24 和 `package.json` 固定的 `pnpm@11.7.0`。在仓库根目录执行：

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run dev
```

依赖以 `pnpm-lock.yaml` 为准；内置 NCM 修补通过 `pnpm-workspace.yaml` 安装。不要混用 npm 安装或提交本机工具路径。音频播放还需要构建并暂存原生运行时，见下方原生构建。

## 代码从哪里看

| 目录 | 职责 |
| --- | --- |
| `src/core/` | 曲库、播放、队列与插件等共享业务 |
| `src/main/` | Electron 主进程、Core 监督、IPC 与系统集成 |
| `src/preload/` | 向界面提供受控 API |
| `src/renderer/` | Vue 3 界面、页面状态与交互 |
| `src/shared/` | 跨进程类型和纯契约 |
| `audio-engine/` | C++20 音频引擎、平台输出与 Node-API |
| `packages/`、`sdk/` | 插件类型、脚手架与示例 |
| `scripts/` | 构建、测试、暂存和发布工具 |

Core 是曲库与播放状态的所有者；renderer 通过现有命令和查询访问业务，不直接操作数据库或文件系统。公共 API 变更需同步调用端、类型、权限校验及相关测试。第三方插件源码放在独立插件仓库；应用仓库保留宿主、SDK 和内置 NCM provider。

## 日常验证

```powershell
pnpm run typecheck
pnpm run lint
pnpm run build
```

按改动选择 `package.json` 中已有的 `test:*` 入口。`pnpm run test:quality-policy` 检查测试归属、IPC 基线与架构边界；`pnpm run test:product` 执行产品行为测试。

插件工具链可运行 `pnpm run build:plugin-api`、`pnpm run test:plugin-tooling` 和 `pnpm run test:plugins`。公共 IPC 基线位于 `scripts/fixtures/ipc-channel-baseline.json`；确认接口变更后用 `node scripts/write-ipc-channel-baseline.cjs` 更新。

## Windows 原生音频构建

安装 vcpkg、w64devkit 和 Git for Windows 后，在当前终端设置实际路径：

```powershell
$env:VCPKG_ROOT = 'C:\path\to\vcpkg'
$env:W64DEVKIT_ROOT = 'C:\path\to\w64devkit'
$env:TWILIGHT_GNU_PATCH = 'C:\Program Files\Git\usr\bin\patch.exe'
$env:TAE_MINGW_BUILD_DIR = 'C:\twilight-build\mingw-static'
pnpm run test:audio-toolchain
pnpm run configure:audio-engine:mingw
pnpm run build:audio-engine:mingw
pnpm run test:audio-engine:mingw
```

构建目录必须可写且完整路径不含空白。`TWILIGHT_GNU_PATCH` 应指向 GNU patch，避免选中 BusyBox 的同名程序。配置、构建、CTest 和暂存共用 `TAE_MINGW_BUILD_DIR`。原生目标、暂存步骤和设备验证见 [音频引擎 README](../audio-engine/README.md)。

## Server 开发

`pnpm run build:server` 构建独立 Node Core，`node out/server/server.cjs --help` 列出启动、配对、迁移、DSP 与扩展管理命令。使用独立数据目录，不能直接让 Server 打开正在运行的桌面配置。Windows 自包含包使用 `pnpm run package:server -- --to <新目录> --zip <新归档>`；Linux 部署见 [部署 README](../deploy/server/README.md)。

## Required Commands

Windows 发布前从仓库根目录顺序执行完整验证：

```powershell
pnpm run lint
pnpm run typecheck
pnpm run test:production-audit
pnpm run audit:production -- --output output/release-evidence/production-dependency-audit.json
pnpm run test:plugins
pnpm run test:core
pnpm run test:audio-manager
pnpm run test:radio-remote
pnpm run test:network-sources
pnpm run test:tag-duplicate-management
pnpm run test:duplicate-detection-benchmark
pnpm run benchmark:duplicate-detection:ci -- --output output/release-evidence/duplicate-detection-benchmark.json --manifest output/release-evidence/duplicate-detection-benchmark.manifest.json
pnpm run test:playback-routing
pnpm run test:playlist-lifecycle
pnpm run test:lyrics-management
pnpm run test:cue
pnpm run test:local-perf
pnpm run test:themes
pnpm run test:appearance-workspace
pnpm run test:dsp-graph
pnpm run test:dsp-assets
pnpm run test:plugin-tooling
pnpm run test:audio-toolchain
pnpm run test:renderer-data-tooling
pnpm run test:sleep-timer
pnpm run test:cross-cutting-regressions
pnpm run test:app
pnpm run build
pnpm run configure:audio-engine:mingw
pnpm run build:audio-engine:mingw
pnpm run test:core:electron
```

| 测试入口 | 验证范围 |
| --- | --- |
| `test:core` | 业务所有权、队列、事务及进程边界 |
| `test:radio-remote` | 电台、远程控制与访问授权 |
| `test:network-sources` | 网络源配置、路径与适配器 |
| `test:themes` | 主题契约、归档与运行时 |
| `test:appearance-workspace` | 外观持久化、导航与真实界面 |
| `test:renderer-data-tooling` | 界面数据、类型边界与资源预算 |
| `test:sleep-timer` | 定时停止、淡出及静音交互 |
| `test:cross-cutting-regressions` | 退出持久化、字体与可见性 |

性能基准需串行运行。`test:core:electron` 使用已构建的应用与原生运行时，必须在两者完成后执行。软件测试不代替 DAC、ASIO、DoP 或物理双机验证；macOS 和 Linux 尚未达到 Windows 同等级别的发布及真实设备验证。

## 发布能力声明

下面的表格由发布门禁读取，必须与暂存原生文件和带来源的运行观察一致。允许状态为 `available`、`experimental`、`unverified`、`not-built` 和 `unsupported`；设备未验证时保持 `unverified`。

| Capability          | Product status | Build presence | Runtime observation | Real-device verification |
| ------------------- | -------------- | -------------- | ------------------- | ------------------------ |
| ASIO                | `experimental` | `available`    | `available`         | `unverified`             |
| VST3                | `available`    | `available`    | `unverified`        | `unverified`             |
| SoXR                | `unverified`   | `unverified`   | `unverified`        | `unverified`             |
| ebur128             | `available`    | `available`    | `available`         | `unverified`             |
| CUDA                | `not-built`    | `not-built`    | `not-built`         | `unverified`             |
| Native DSD provider | `available`    | `available`    | `available`         | `unverified`             |

发布命令生成并校验暂存目录中的 `audio-capabilities.json` 和 `release-capability-status.json`。任一受控声明与构建、运行或设备事实不一致时停止发布。

## 提交约定

沿用相邻文件的 TypeScript、Vue 和格式约定。提交源码、必要测试与开发者使用说明；本机计划、执行记录、release note 和性能采样留在被忽略的目录。新增公开文档需明确调整白名单。
