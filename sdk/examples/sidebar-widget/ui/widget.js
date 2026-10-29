// Example readings only. Keep real device access in the plugin's main process.
const devices = [
  { name: '本机电池', level: 100 },
  { name: 'Razer Viper V4 Pro', level: 44 },
  { name: 'BWV4 TKL', level: 86 }
]
let refreshes = 0
function render() {
  document.querySelector('#devices').replaceChildren(
    ...devices.map(({ name, level }) => {
      const row = document.createElement('li')
      const label = document.createElement('span')
      label.className = 'name'
      label.textContent = name
      label.title = name
      const progress = document.createElement('progress')
      progress.max = 100
      progress.value = level
      progress.setAttribute('aria-label', name)
      const value = document.createElement('span')
      value.className = 'value'
      value.textContent = `${level}%`
      row.append(label, progress, value)
      return row
    })
  )
}
document.querySelector('#refresh').addEventListener('click', () => {
  refreshes++
  devices[1].level = refreshes % 2 ? 43 : 44
  render()
})
render()

window.addEventListener(
  'message',
  (event) => {
    if (
      event.source !== parent ||
      event.data?.type !== 'twilight-experience-connect' ||
      event.data.bridgeVersion !== 2 ||
      !event.ports[0]
    )
      return
    const port = event.ports[0]
    port.onmessage = ({ data }) => {
      if (data?.event !== 'appearance') return
      const appearance = data.value
      const root = document.documentElement
      root.style.colorScheme = appearance.theme === 'dark' ? 'dark' : 'light'
      for (const key of ['text', 'muted', 'accent', 'border']) {
        if (appearance.colors[key]) root.style.setProperty(`--${key}`, appearance.colors[key])
      }
      if (appearance.fontFamily) root.style.fontFamily = appearance.fontFamily
      if (appearance.fontSize) root.style.fontSize = appearance.fontSize
    }
    port.start()
  },
  { once: true }
)
parent.postMessage({ type: 'twilight-experience-ready', bridgeVersion: 2 }, '*')
