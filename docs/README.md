# Twilight Echo 文档索引

本目录保留当前技术规范、架构说明、功能契约、操作指南、发布说明、法律依据，以及仍被测试或技术说明引用的机器可读基准。

## 开发与架构

- [开发者文档](./DEVELOPER_README.md)
- [宏观质量门禁](./quality-gates.md)
- [音频引擎架构](./twilight-audio-engine-architecture.md)
- [音频引擎 API](./audio-engine-api.md)
- [安全加固边界](./security-hardening.md)

## 音频、设备与发布

- [发布能力状态](./release-capability-status.md)
- [本体更新](./app-updates.md)
- [ASIO 与 DSD 输出契约](./asio-dsd.md)
- [ASIO helper process 隔离 ADR](./asio-helper-process-adr.md)
- [Windows 发布门禁](./windows-release-gate.md)
- [Windows HiFi 真实设备检查](./windows-phase-6c-smoke-checklist.md)
- [真实设备音频证据规则](./audio-smoke-evidence.md)
- [VST3 宿主工具链](./vst3-host-toolchain.md)
- [AutoMix 运行与验证指南](../audio-engine/automix-native/README.md)
- [1.3.0 发布说明](./release-notes/1.3.0.md)
- [1.1.0 发布说明](./release-notes/1.1.0.md)

## 插件与主题

- [插件开发导读](./PLUGIN_README.md)
- [插件系统权威规范](./twilight-echo-plugin-spec.md)
- [主题插件开发](./theme-plugin-authoring.md)

## 本地库与播放功能

- [本地库元数据补全](./local-library-metadata-enrichment.md)
- [库内批量响度分析](./audio-engine-api.md#库内批量响度分析)
- [本地库移除策略](./local-library-removal-policy.md)
- [本地库排序与筛选](./local-library-sorting-and-filters.md)
- [搜索与跨来源歌曲身份](./search-and-library-identity.md)
- [播放模式](./playback-modes.md)
- [播放队列虚拟化](./playback-queue-virtualization.md)
- [播放列表生命周期](./playlist-lifecycle.md)
- [歌词管理](./lyrics-management.md)
- [CUE 支持](./cue-support.md)
- [标签与重复歌曲检测](./duplicate-detection.md)
- [睡眠定时器与静音](./sleep-timer-and-mute.md)
- [持久化基准](./persistence-benchmark.md)
- [多协议网络音乐源架构与接口](./network-music-sources.md)
- [网络音乐源真机验证清单](./network-music-sources-verification.md)

## 界面设计

- [Twilight Echo 界面语言](./interface-language.md)
- [页面文字规范](./ui-typography.md)
- [材质契约](./material-contract.md)
- [交互动效规范](./ui-motion.md)
- [界面材质语言](./material-language.md)
- [控件样式与 Token 契约](./ui-style-unification.md)

## 统计与法律

- [日活与使用统计契约](./telemetry-dau.md)
- `legal/`：ASIO clean-room 兼容层的来源、决策与互操作规范。
- `audit-evidence/`：公共 IPC 契约基线、持久化、队列虚拟化及重复检测基准。

## 文档维护规则

- AI 对话转录、会话记忆、提示词包、任务拆分、实施计划、交接记录和历次审计产物不保存到仓库；此规则同样适用于音频引擎、插件包等子目录。
- 临时计划与进度放在 Issue 或 Pull Request 中；当前行为由代码、测试和技术规范说明。
- 同一主题只保留一个权威规范和必要的使用导读；被替代的草案和重复指南应删除。
- 指南不追加单次会话的检查点、执行流水或本机验证日志；版本更新记录集中放在 `release-notes/`。
- 测试、发布流程或当前技术说明仍引用的基准与法律材料应保留。
