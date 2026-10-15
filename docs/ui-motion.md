# 控件与临时边缘动画接口

更新日期：2026-10-13。

`src/renderer/src/app/uiMotion.ts` 提供按文档复用的动画控制器。按钮、输入框、选择框、滑块、面板和插件渲染的 HTML 控件都可以调用，不需要为每个控件安装事件监听器或循环。

```ts
import { uiMotionFor } from '../app/uiMotion'

const motion = uiMotionFor(element.ownerDocument)
const entering = motion.control(element, 'reveal')
const feedback = motion.control(button, 'press')
const outline = motion.edge(element, { edges: 'all', radius: 6 })
const titleEcho = motion.edge(titleBar, { edges: 'bottom', radius: 0 })
// 编辑器可以指定中性轮廓，其他调用仍使用默认主题强调色。
const neutralEdge = motion.edge(canvas, { color: 'var(--te-settings-text)' })

await entering.finished
// 调用方在离开或卸载时取消尚未结束的效果。
outline.cancel()
titleEcho.cancel()
feedback.cancel()
neutralEdge.cancel()
```

控件和边缘是两个通道。同一元素、同一通道的新调用会取消旧效果；自然完成和取消都会正常结束 `finished`。控制器不写入目标的布局样式，默认控件效果只改变透明度。边缘是短暂的固定覆盖层，适用于不能容纳子元素的原生输入框，点击仍传到原控件。

`register(name, { full, reduced })` 可以注册后续效果并返回注销函数。变体分别包含 `keyframes` 和 `timing`，控件效果限制为透明度和局部变换；已有布局变换会保留。自定义效果需提供有意义的减少动画版本，避免把装饰性运动当成必须反馈。

动画遵守现有的 `data-te-motion`、系统减少动画设置和窗口可见状态。显式选择完整动画时使用完整版本；减少动画只保留不超过 120ms 的透明度反馈并跳过装饰边缘，关闭动画或隐藏窗口不安排任务。只有活跃效果才监听策略变化，完成后解除监听；`dispose()` 释放控制器。

偏好优先级为显式选择高于系统设置：`system` 随系统解析为 `full` 或 `reduced`；用户明确选择 `full` 时，外观部件聚焦、2D／3D 切换、鼠标跟随和属性浮层继续提供完整缓动。CSS 的 `prefers-reduced-motion` 仅作未选择完整动效时的回退，不能重新覆盖 `data-te-motion="full"`。减少或关闭动效仍停用镜头和视差运动。用于截图的独立预览配置不得作为实际交互动效检查的默认偏好。

外观编辑器先显示圆角矩形占位和中性的短暂轮廓，真实标题栏底边同步呼应。预览部件完成首次实际测量、轮廓出现后，再淡入同一窗口场景；占位没有加载文字，完成后只保留少量通用示意标签，使用 `aria-busy` 提供加载状态。关闭动画时不等待装饰阶段。临时边缘完成后删除，画布没有装饰内框。当前部件保留中性 2px 选择轮廓，键盘焦点使用独立 3px 提示；两者没有阴影光晕。`edge` 的可选 `color` 只影响本次临时覆盖层，不修改控件或根主题色。

默认入场 220ms、按压反馈 110ms、边缘 700ms。边缘的颜色与光晕保持静态，只动画透明度，不生成模糊滤镜或永久 GPU 图层。编辑器相机仅在移动和拖动时请求变换图层，隐藏或卸载时取消任务；后续调用应遵守相同的按需原则。

运行 `pnpm run test:appearance-editor` 验证策略、取消、清理、加载顺序、编辑器和草稿行为。
