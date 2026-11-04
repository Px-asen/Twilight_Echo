/** Runtime state for the caption controls, separate from saved window bounds. */
export interface WindowChromeState {
  maximized: boolean
  fullScreen: boolean
  /** The caption's expand control follows the desktop platform convention. */
  maximizeBehavior: 'maximize' | 'fullscreen'
}
