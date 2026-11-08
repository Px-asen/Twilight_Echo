# 常态内存优化（2026-11-08）

本轮减少启动空闲和普通播放时提前加载的代码，并回收停止浏览后的曲库索引。源码已更新；正常启动开发版或重新构建后生效。前一轮的峰值与长期增长修复见 [内存优化记录](memory-optimization-2026-11-08.md)。

## 默认界面按需加载隐藏面板

播放栏的 HiFi、队列、保存/添加歌单、compact 可视化，以及侧栏导入对话框、插件嵌入页面，现在首次展示时才加载。导入和添加歌单对话框第一次打开后继续保留实例，维持关闭动画和局部状态。

同一构建配置下，入口、App、PlayerBar、SongList 和 SideMenu 的静态依赖闭包变化如下。只统计递归 `imports`，不把 `dynamicImports` 算入默认加载。

| 指标                  |      修改前 |      修改后 |                   减少 |
| --------------------- | ----------: | ----------: | ---------------------: |
| JavaScript            | 2,982,926 B | 2,342,174 B | 640,752 B（625.7 KiB） |
| CSS                   |   780,358 B |   670,751 B | 109,607 B（107.0 KiB） |
| 播放栏自身 JavaScript |   336,407 B |   138,180 B |              198,227 B |

这些是加载代码体积，内存还受编译、对象和浏览器资源影响。构建闭包证据为 `.artifacts/steady-memory-20261108/renderer-closure.json`。行为测试使用真实宿主组件及面板替身，验证默认不加载、首次打开、关闭后保留、再次打开和插件入口。

## 后台进程只加载使用到的 Node 模块

`src/adapters-node/index.ts` 的文件、网络、TLS、UDP、压缩等端口改为同步 getter，在首次访问时加载对应模块；接口和返回类型保持不变。只注册适配层时，不再初始化所有内置模块。

独立 Node 进程预热 TypeScript/Core ports 后，对 GC 后的堆增量测量三次：旧实现约 3,486,128 B，新实现 70,288 B，约减少 3.26 MiB。这是适配层隔离测量；实际进程若使用某个模块，仍会正常加载它。

DSP 配置导入和 AutoMix 模型安装也延迟访问 ZIP 端口，默认导入不再加载相关 19 个 npm 模块。这两个服务的独立导入堆增量由 1,326,248 B 降至 741,040 B。导入与模型安装的 Store、Deflate、LZMA 路径回归通过。

## 停止浏览 90 秒后释放曲库索引

沿用数据库原有的 90 秒浏览闲置周期，补充清理整库排序 ID、查询统计和语句缓存，再通过 `PRAGMA shrink_memory` 释放 SQLite 不再使用的页。活动时的 16 MiB 页缓存预算不变；后续浏览按需重建。普通播放的队列翻页、曲目和元数据读取不会延长浏览计时。

10 万曲目、3 种排序、闲置 92 秒的独立进程诊断中，旧实现仍持有 30 万个排序 ID，新实现归零。显式 GC 后的 JS 堆由 26,235,728 B 降至 14,240,896 B，约减少 11.4 MiB。此场景要求相应曲库规模及至少 90 秒不再浏览；收益不能套用于每次冷启动。冻结队列、元数据和重新浏览的结果经过回归核对。

## 验证与整机测量限制

- 整合后的 `pnpm run test:memory`：79 项通过。
- Core、Node、Web 类型检查、生产构建和 renderer 资源预算通过。
- 三个分工范围分别通过 Node 端口 4 项、数据库 48 项、ZIP/启动 17 项及界面相关 45 项测试；这些与整合集存在重叠，不累加为独立测试总数。
- 最终候选产物：`.artifacts/steady-memory-20261108/production`。对照基线保留在 `.artifacts/memory-optimization-20261108/production`。

新增 `--scenario steady`，固定运行曲库空闲、持续播放、暂停三个阶段。原完整基准和验收要求保持不变。Windows 采样器也修复了 PID 复用误判：同时核对父子进程创建时间，避免把无关旧进程计入应用。

本机普通沙箱渲染器启动问题已在空白窗口复现，因此此次桌面探测显式使用隔离的 `--diagnostic-no-sandbox`。修正 PID 计量后的完整三次基线又因系统可用内存低于 1 GiB 自动中止，重试仍触发相同保护；未执行候选整机对照。不会以这些压力中的工作集变化宣称总量下降。

无效/未完成报告保留在 `.artifacts/steady-memory-20261108/before`、`before-validated`、`before-final`，分别记录 PID 误计和内存压力。需要在沙箱渲染器能正常启动、可用内存充足的桌面会话中继续整机对照；其他用户进程未被停止。

```powershell
pnpm run test:memory
node scripts/benchmark-memory.cjs --scenario steady --build-root .artifacts/memory-optimization-20261108/production --output .artifacts/steady-before-new --sizes 1057 --runs 3 --settle-seconds 45 --soak-seconds 60
node scripts/benchmark-memory.cjs --scenario steady --build-root .artifacts/steady-memory-20261108/production --output .artifacts/steady-after-new --sizes 1057 --runs 3 --settle-seconds 45 --soak-seconds 60
```

先完成基线，再运行候选；避免同时编译或运行其他压力测试。各局部测量不可直接相加为整机节省量。
