export interface NativeContextMenuItem {
  id: string
  label: string
  enabled?: boolean
  submenu?: NativeContextMenuItem[]
}

export interface NativeContextMenuRequest {
  requestId: string
  items: NativeContextMenuItem[]
}
