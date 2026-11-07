# 用手机管理 Server 的 DSP 资料、配置包和 VST3 参数

更新：2026-11-04。

手机控制电脑时，进入「声区 → 处理 → 管理资料与插件」。旧的「电脑输出与音频链」面板也提供同一入口。页面标题下显示当前声区，资料、场景和插件目录分别保存在该声区。

## 导入资料，保存场景，再应用

1. 在「资料」页从手机选择 WAV／FLAC／AIFF 脉冲响应、TXT／APO 校正 EQ、`.vstpreset` 预设或 `.vststate`／`.bin` 插件状态。单个文件上限 64 MiB，分块传到 Server 后才登记为资料。
2. 在「场景」页新建自定义场景。新场景默认不参与自动匹配。
3. 回到资料页点「绑定」，选择场景并确认。IR 替换场景中的卷积节点，校正 EQ 替换均衡器节点；编辑当前场景会立即更新处理。
4. 在场景页点「应用」并确认，启用、固定此场景，同时开启它需要的卷积／均衡器模块。确认框说明 DSD 转 PCM 的授权；DSP 总开关和直通模式仍由处理面板控制。
5. 不再使用的节点可以移除。资料仍被任一保存场景或旧式卷积配置引用时不能删除；解除引用后再删除资料副本。

资料与插件分页读取。写入保留打开页面时的电脑 generation、Core epoch、声区和音频 revision。文件选择器返回时还检查页面身份，防止旧文件落到后来打开的声区。写入中不能关闭或换目标；命令没有自动重发，结果不确定时先刷新核对。

## VST3 扫描使用 Server 已授权的目录

停止 Server，在数据目录的 `server.json` 中配置 `vst3Roots`，例如 `["D:\\AudioPlugins\\VST3"]`，然后重启。Server 启动时将这些目录用于各声区，撤销的旧目录不会继续沿用。手机只能发起扫描，不能提交主机路径或上传可执行插件。

在「插件」页查看宿主／扫描器是否可用、启停 VST3、扫描授权目录、查看结果和解除隔离重扫。扫描在后台运行，刷新读取结果。选中可用插件后，选择自定义场景及可选预设／状态，再确认添加。第三方 VST3 模块需要预先安装在 Server，包内提供扫描器和宿主。

同步组成员的 DSP 修改先暂停共享播放；扫描可能改变插件可用性与延迟，扫描完成后由用户重新播放。扫描期间仍可立即停止。额外声区现在与主会话一样接通自己的 IR、VST3 模块与状态解析器。

## 预览并导入 .tedsp 配置包

进入「配置包」页，选择 `.tedsp` 文件。上传后先显示场景、节点数量、资料数量与大小，以及缺失项目。预览只使用暂存资料，取消不会添加场景。

点「确认导入」后，包内场景以新 ID 加入当前声区，全部保持未启用；现有场景与当前选择保留。到场景页明确点「应用」才使用导入的场景。原包的 DSD 转 PCM 授权不随导入转移，应用时重新确认。同步组导入先暂停共享播放以重新协调。

跨电脑导入 VST3 时，目标 Server 须先安装并扫描插件。预览按插件类 ID 匹配本机目录；存在多个版本又无法精确匹配时，需要先整理目录。缺失插件／资料或包含原生应用扩展的包停留在预览，解决后重新导入。插件可执行文件不包含在 `.tedsp` 中。

点「导出此声区配置包」，下载完成后点「保存到文件…」。导出包含该声区保存的场景及其引用的 IR、校正 EQ、VST3 预设／状态，旧式 IR 路径会转为嵌入资料。缺失引用会报错，不生成缺资料的包。上传、导出以及解压内容均限制在 64 MiB；超过限制需先拆分或整理场景。

## 编辑场景中的 VST3 参数

在场景的 VST3 节点旁点「参数」。参数以标准化的 0–100% 显示，连续参数可拖动，离散参数保存时按插件步数对齐；只读或隐藏参数不能写入。修改后明确点「保存」，编辑当前场景会更新正在使用的处理；同步组会先暂停。

绑定预设／状态但没有单独覆盖的参数显示「预设值（未读取）」。点「设置覆盖值」后才能编辑；「移除覆盖」恢复使用预设或插件默认值。添加插件时不再把扫描默认值写成整组覆盖，因此选中的预设可以保留自己的参数。

## 没有手机时用命令行

以下命令连接正在运行的实例；`--zone` 省略时为 `local`，其他 ID 从 `zones.list` 获取。

```powershell
.\server.cmd dsp-library --data D:\ServerData\TwilightEcho --zone zone-example
.\server.cmd dsp-import --data D:\ServerData\TwilightEcho --zone zone-example --from D:\IR\room.wav
.\server.cmd dsp-remove --data D:\ServerData\TwilightEcho --zone zone-example --id impulseResponse:资料摘要
.\server.cmd vst3-scan --data D:\ServerData\TwilightEcho --zone zone-example
.\server.cmd dsp-profile-import --data D:\ServerData\TwilightEcho --zone zone-example --from D:\DSP\room.tedsp
.\server.cmd dsp-profile-import --data D:\ServerData\TwilightEcho --zone zone-example --from D:\DSP\room.tedsp --apply
.\server.cmd dsp-profile-export --data D:\ServerData\TwilightEcho --zone zone-example --to D:\DSP\room-backup.tedsp
.\server.cmd dsp-parameters --data D:\ServerData\TwilightEcho --zone zone-example --scene 场景ID --node 节点ID
```

`dsp-library` 支持 `--asset-offset 100`、`--plugin-offset 100`。`dsp-edit --request D:\DSP\edit.json` 接受一个编辑对象，例如 `{"kind":"createScene","name":"客厅校正"}`。绑定对象为 `{"kind":"bindImpulse","sceneId":"场景 ID","assetId":"资料 ID"}`；应用为 `{"kind":"applyScene","sceneId":"场景 ID","confirmDsdPcmFallback":false}`。命令行读取当前音频版本后提交一次；发生冲突时重新查看状态。

`dsp-profile-import` 默认只预览，`--apply` 才新增未启用的场景；预览存在问题时仍不导入。导出路径必须是尚不存在的绝对 `.tedsp` 路径，失败会清理本次不完整输出。`dsp-parameters` 支持 `--offset 100`；通过 `dsp-edit` 提交 `{"kind":"parameter","sceneId":"场景 ID","nodeId":"节点 ID","parameterId":100,"value":0.5}`，`value:null` 移除覆盖。

本机 CLI 与手机走相同 Core 操作。上传、预览和下载句柄绑定认证客户端与声区，有十分钟失效边界和同时两份的限制；重启清理未完成暂存。确认导入检查音频 revision，失败回滚本次新增资料。正式资料继续使用原内容寻址库和引用保护。

## 本轮验证与交付

- Android Core client **172 项**、Player **207 项**测试通过；覆盖配置包、参数分页、旧电脑／epoch、未知结果和真实 Server DTO。[构建记录](D:/Project/Twilight_Echo_Android/build/dsp-profile-build-final.log)。
- Core DSP、声区／同步组、TLS 网关、HTTP、资料库和扫描器 **97 项回归通过**，含预览隔离、追加导入、失败回滚、插件跨目录匹配及参数覆盖。[记录](../.dsp-profile-regression.log)。Core／Node 类型检查、变更文件 ESLint 与桌面构建通过。
- API 36 独立模拟器的 **2 项交互检查通过**，验证配置包预览确认、未知预设值的显式覆盖，以及既有资料绑定／场景应用。已检查截图：Android `build/dsp-profile-qa/10-profile-preview.png`、`11-vst3-parameters.png`。[交互记录](D:/Project/Twilight_Echo_Android/build/dsp-profile-ui.log)。
- 标准 ZIP 解压后的 **4 项 Server 检查通过**：自包含启动、迁移卷积、会话队列、真实配对 TLS／CLI 配置包往返及 ADelay 插件参数输出。ADelay 使用本机 SDK 构建的测试模块，接收端为模拟 DAC。最终 ZIP 的同入口验收见[交付日志](../.dsp-profile-package-integration.log)。
- 修复音频服务退出后 VST3 宿主残留的问题；宿主现在归属引擎持有的 Windows Job。原生回归验证 2,048 个参数的传输、音频处理，以及不运行析构函数时宿主随所有者退出。[记录](../.dsp-profile-bridge-native.log)。
- 已把工作区现有 Afterglow 测试登记到原测试脚本，**19 项测试归属／打包依赖检查和 2 项 Afterglow 测试通过**。[门禁记录](../.dsp-profile-gates.log)。

两端需要一起更新。Android APK：`D:/Project/Twilight_Echo_Android/app/build/outputs/apk/debug/app-debug.apk`。Server 本轮包：`D:/Project/Twilight_Echo/dist/TwilightEchoServer-1.4.0-win32-x64-profiles-20261104.zip`。版本仍为 1.4.0，包含 Node 24.21.0 和 283 个依赖位置；旧包保留。桌面入口同步重建至 `out`，没有另建桌面安装包。

源码目录的 VST3 直接联调曾被本机权限条件阻断：工作区宿主是低完整性文件，外部 Node 进程是高完整性，Windows 拒绝共享内存访问。未修改 ACL／完整性标签；插件运行证据来自正式归档的标准解压环境。首次运行还发现宿主退出清理缺陷，上述 Windows Job 修复后重新通过整包验证。

2026-11-05 后续进展：`.tep` 管理已接通，见 [Server 扩展](./server-extensions.md)；Android 离线下载、计费网络控制、外网地址与车载浏览已实现，见 Android 仓库 `MOBILE_LIBRARY.md`。Linux x86_64 的容器与 CI 入口已提供，实际镜像验收因缺少环境待办，见 [Linux 部署](./server-linux.md)。真实手机／DAC、WAN／车机、第三方插件实机兼容以及 SCM／服务账号验收继续后置，大曲库性能工作仍暂停。
