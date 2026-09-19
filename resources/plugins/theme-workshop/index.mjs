export async function activate(context) {
  context.twilight.ui.onCommand('theme-workshop.open', () => ({ page: 'theme-workshop' }))
  await context.twilight.ui.register({
    id: 'theme-workshop',
    kind: 'sidebarPage',
    title: '主题插件工坊',
    description: '创建、定制与导出主题插件',
    icon: 'ph ph-paint-brush',
    command: 'theme-workshop.open'
  })
}

export function deactivate() {
  return undefined
}
