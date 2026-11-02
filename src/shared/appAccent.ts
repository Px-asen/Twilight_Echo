export const APP_ACCENT_COLORS: Readonly<Record<string, string>> = Object.freeze({
  violet: '#8b5cf6',
  blue: '#2563eb',
  emerald: '#10b981',
  rose: '#e11d48',
  amber: '#f59e0b',
  slate: '#334155'
})
export function resolveAppAccentColor(color: string): string {
  return APP_ACCENT_COLORS[color] ?? color.trim()
}
