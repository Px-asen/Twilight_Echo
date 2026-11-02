# 32 位 ASIO 驱动：构建与验收

Windows x64 播放器通过 `twilight-asio-helper-x86.exe` 加载已安装的 x86 ASIO 驱动。
解码、DSP、队列仍在 x64 引擎；Native DSD 复用原来的协商、LSB1/MSB1/NER8 和关闭恢复路径，
不因驱动是 32 位而转为 PCM。首版不提供完整 32 位应用或 ARM64 支持。

## 选择设备

- 列表同时显示 `驱动名 (ASIO x64)` 和 `驱动名 (ASIO x86)`，不为枚举加载 DLL。
- x64 ID 保留 `asio:{CLSID}`；x86 为 `asio:x86:{CLSID}`。同 CLSID 的两种安装独立缓存能力。
- 自动选择优先 x64；旧名称优先匹配 x64，否则只接受唯一的 x86 名称。明确选中的 ID 不会自动换架构。
- 位数仅说明驱动架构。Native DSD 必须由探测、创建后的通道类型和实际回调共同确认，不能根据 BRAVO-HD 名称推定。

## 构建与独立暂存

需要现有 x64 引擎工具链，以及 VS 2022 Build Tools 的 x86/x64 C++ 工具和 Windows SDK。
在仓库根目录运行；下列暂存目录不替换正在运行的 `resources/audio-engine`：

```powershell
$env:TAE_ASIO_MSVC_INSTALL_ROOT = 'C:\path\to\VS2022\BuildTools'
node scripts/build-asio-helper.cjs --arch x86
node scripts/stage-audio-engine.cjs `
  --build-dir $env:TAE_MINGW_BUILD_DIR `
  --asio-x86-build-dir audio-engine/build/asio-helper-msvc-x86 `
  --output-dir .cache/asio-208-runtime
```

第一条构建只编译 helper 和测试夹具：MSVC Win32、Release、静态 CRT `/MT`。
可通过 `--build-dir` 或 `TAE_ASIO_X86_BUILD_DIR` 指定 x86 输出目录。
引擎与两个 helper 必须都来自当前协议 v6；暂存和 Windows 打包会检查 PE 位数、系统 DLL 依赖、
helper 自检以及引擎 `features.asioHelperProtocolVersion`。旧 x64-only 开发暂存入口仍可使用；
正式 Windows 包缺少 x86 helper 或协议不一致时会失败。

手动路径覆盖（通常不需要）：

```powershell
$env:TAE_ASIO_HELPER_PATH = 'C:\build\x64\twilight-asio-helper.exe'
$env:TAE_ASIO_HELPER_X86_PATH = 'C:\build\x86\twilight-asio-helper-x86.exe'
```

缺少 x86 helper 只影响 x86 设备。超时、崩溃、回调停滞或格式恢复失败会安全停止，
不会自动换架构、换设备或续播。诊断记录 `processArchitecture`（引擎）、
`asioHelperArchitecture`（实际 helper）和 `asioLoadableDriverCount32/64`（注册表可解析数，非播放验证数）。
“仅 x86”数量应比较两份目录的 CLSID 集合，不能用注册数量相减。

## 自动化验证

```powershell
# 独立构建 MSVC x64 父进程、x86 helper、独立 x86 fake DLL；不访问声卡
node scripts/run-asio-x86-bridge.cjs

# 使用已构建的生产 MinGW x64 测试程序验证同一套 IPC/故障路径
$env:TAE_ASIO_X64_TEST_DIR = $env:TAE_MINGW_BUILD_DIR
node scripts/run-asio-x86-bridge.cjs
Remove-Item Env:TAE_ASIO_X64_TEST_DIR

node --test scripts/verify-asio-helper-artifacts.test.cjs
```

发布入口 `test:asio-cross-abi` 先验证 MinGW 与 MSVC x64 DLL ABI，再用生产 MinGW 父进程运行 x86 桥接测试。
IPC 清单检查所有共享记录的大小、对齐和字段偏移；x86 驱动使用单独的黄金清单及不包含宿主 ABI 的 fake DLL。
测试覆盖 PCM/Float64、DSD 队列与边界、同 CLSID 双架构与同名歧义、旧名称、缓存/quirk 隔离、
架构切换、缺失 helper、协议错误、拒绝、超时、崩溃、回调停滞及父进程退出。

### 本次验证记录（2026-11-02）

- MSVC x86 helper 与独立 fake DLL、x86 ABI、MSVC x64→x86 IPC/路由/故障测试通过。
- MinGW x64 ASIO 后端、驱动兼容性、ABI 与 helper 自检四项 CTest 通过。
- MinGW x64→MSVC x64 fake DLL ABI 通过；路由测试 11 项、产物/SDK 策略测试 16 项、ASIO/MSVC/暂存测试 13 项通过；core/node TypeScript 检查通过。
- 独立暂存的引擎和双 helper 通过 PE/依赖/协议 v6 检查；实际枚举显示同 CLSID 的 FiiO x64、x86 两条记录。
- 生产 MinGW→MSVC helper IPC 在本机未通过：父进程令牌为高完整性，子进程为低完整性，
  `OpenFileMappingW` 返回 `ERROR_ACCESS_DENIED`。未放宽共享对象权限。环境维护者需确认降权来源，
  使父子进程在允许共享的正常运行上下文中启动，再执行上述生产父进程命令；该项仍是发布验收缺口。
- 提交前从 Git 暂存区导出独立源码快照，重新构建通过 MSVC x64 主引擎、helper 和 IPC 测试程序；
  独立 x86 ABI、MSVC x64→x86 IPC/路由/故障验证及 11 项路由测试通过，SDK-free 源码/历史扫描通过。
- 该快照的工具链、helper 产物和发布产物脚本测试为 66/68 通过；剩余两项是 CTest 注册清单与
  resampler 测试未清除 `NDEBUG` 的门禁失败，需由工具链门禁维护者处理后重跑。

本地日志：`.cache/asio-msvc-bridge-final.log`、`.cache/asio-runtime-validation.log`、
`.cache/asio-native-bridge-final.log`；提交快照日志为 `.cache/asio-208-pr-bridge.log`、
`.cache/asio-208-pr-integration.log`、`.cache/asio-208-pr-scripts.log`。已暂存运行时：`.cache/asio-208-runtime/`。

## BRAVO-HD 3.14 / DETHONRAY Clarinet 实机验收

当前机器没有目标驱动/设备，此项由设备持有人完成。安装正确的 32 位驱动、连接设备，关闭占用它的其他音频客户端，
先降低功放/耳机硬件音量，再选择列表中的 x86 项。使用确认为设备支持的档位，不把缺失样本或不支持的档位算作通过。

1. 通过 x86 项播放 PCM，记录实际采样率、容器格式、声道、helper 架构和 underrun。
2. 准备按 `dsd64` / `dsd128` 等标记文件名的 DSF/DFF 样本，仅放入待验证档位。运行：

   ```powershell
   $module = (Resolve-Path .cache/asio-208-runtime/twilight_audio_node.node).Path
   node scripts/asio-native-dsd-smoke.cjs `
     --module $module `
     --device 'asio:x86:{实际 CLSID}' --fixture-dir 'D:\DSDFixtures' --json
   ```

   JSON 保留实际输出格式、`diagnostics.asioHelperArchitecture`、underrun 和 Native DSD runtime facts。
   通过要求 `asioHelperArchitecture=x86`、`nativeDsdRuntimeState=proven`、目标速率吻合、无错误或丢缓冲。

3. 在播放器中重复 PCM→DSD→PCM、暂停→恢复、停止→重开；确认恢复 PCM、声音正确，关闭后其他客户端可重新使用设备。
4. 保存驱动版本、设备固件、Windows 版本、所用构建、样本档位、缓冲大小和各步骤 JSON/听感结果。

只有生产 IPC 复验和这些目标硬件步骤完成后，才能关闭该设备的兼容性验收。

架构和法律边界见 [helper ADR](asio-helper-process-adr.md) 与 [互操作契约](legal/asio-interoperability-spec.md)。
