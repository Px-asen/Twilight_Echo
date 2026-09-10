# Lyrics Timing And Manual Management

Lyrics timing is a renderer presentation concern. Twilight Echo never rewrites
an LRC file merely to correct its timing. A user may explicitly save their
edited original lyrics as a separate LRC file from the Lyrics manager.

- A global offset and a per-track offset are stored in milliseconds. Both are
  bounded to `-120000..120000` and are added to the playback clock when the
  active line is selected. Clicking a line applies the inverse offset before
  seeking.
- Per-track choices are persisted in `lyrics-management.json`, independently
  from the scanned library, playlist data, audio metadata, and playback
  session. A library rescan cannot discard a manual lyric edit.
- `Auto`, `Local LRC`, and `Provider` retain the existing lyric
  resolver and its fallback order. `Manual` has explicit precedence only for
  the selected track and never overwrites the resolver result held by the
  playback queue.
- Import accepts a user-selected `.lrc` or `.txt` file through the main-process
  dialog, strips a UTF-8 BOM, and rejects content above 1 MiB. Lyrics files
  may be UTF-8 with or without BOM, GBK, or GB18030; decoding is fatal, so
  malformed byte sequences are rejected instead of becoming `U+FFFD` mojibake.
  The same decoder powers the lazy external-LRC loader and SACD ISO sibling
  lyrics during scans. The UI supports editing original, translation, and
  romanization text before saving.
- `Save LRC` opens a main-process Save dialog. The renderer cannot provide a
  destination path. Only non-empty, valid LRC text (at most 1 MiB) is written;
  an existing destination is copied to `<name>.lrc.bak`, data is fsynced to a
  same-directory temporary file, and the temporary file is atomically
  replaced. A failed replacement restores the backup before reporting the
  error. `Save lyrics` separately commits the per-track management settings.
- Original, translation, and romanization are independent global display
  toggles. Hidden tracks are retained in the stored document, so re-enabling a
  toggle does not require a new lookup.

The persistence file uses the shared versioned-data envelope and compare-and-
swap revisions. A stale renderer write is rejected instead of replacing a
newer document.

### 任务栏歌词浮层（2026-09-10）

桌面歌词新增 `placement: desktop | taskbar`，继续走既有桌面歌词会话和设置通道。任务栏模式在主屏显示单行透明浮层，强制置顶、鼠标穿透，保留原桌面模式的字体/横竖排/翻译设置；返回桌面模式时恢复这些设置。任务栏专用宽度、水平位置和字号可单独调整。横向任务栏使用显示器工作区与屏幕边界计算位置，自动隐藏或垂直任务栏时落在屏幕底部。此实现不是 Explorer 内嵌控件，不自动识别或避让任务栏应用图标；用户可调整位置。显示器缩放/工作区变化后重新计算。

下载可同时保存音源提供的 `.lrc`、翻译 `.translated.lrc`，以及逐字 `.word.lrc` / `.yrc` / `.ttml` 文件。无可用歌词时提示用户，不改变音频下载结果。

FluentFlyout 通过标准 Windows SMTC 读取媒体会话，沿用项目现有原生 SMTC 功能。是否在第三方工具中正确显示封面、时间线和控制按钮需要在 Windows 安装包与该工具共同运行时验收；不能由组件预览替代。参考：[FluentFlyout 官方 FAQ](https://fluentflyout.com/faq/)。
