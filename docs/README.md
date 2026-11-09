# Twilight Echo 开发文档

- [应用开发入门](./DEVELOPER_README.md)：安装、运行、项目结构、原生构建与验证。
- [插件开发导读](./PLUGIN_README.md)：从创建插件到打包发布。
- [插件系统规范](./twilight-echo-plugin-spec.md)：Manifest、权限、API 与兼容性。
- [主题开发](./theme-plugin-authoring.md)：主题字段、Token 与兼容边界。
- [完整界面开发](./plugin-full-interface.md)：可切换界面与可运行示例。
- [侧栏小组件](./plugin-sidebar-widgets.md)：嵌入式组件的接入与生命周期。
- [界面桥接协议](./plugin-experiences.md)：页面、面板与宿主通信。

原生引擎见 [audio-engine/README.md](../audio-engine/README.md)，插件工具见 [脚手架说明](../packages/create-twilight-plugin/README.md)。

## 维护约定

本目录只提交本页及以上 7 份面向开发者的文档。根目录 `.gitignore` 默认忽略 `docs/**`，按精确路径放行。

实现说明、AI 计划、任务进度、调研、诊断记录、截图、基准输出和 release note 均留在本地；不要因文件提到架构、接口或测试就加入白名单。对外版本说明发布在 GitHub Releases。

新增公开内容优先补充现有指南。测试必需的固定数据放在 `scripts/fixtures/`；构建和测试不依赖本地文档。
