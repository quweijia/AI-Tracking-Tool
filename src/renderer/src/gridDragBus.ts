/**
 * 网格卡片拖拽状态广播：页面/标注集/文件夹卡片从网格拖起时经 window CustomEvent 通知全局，
 * 供面包屑胶囊（项目详情页）与侧边栏树（Layout）作为放置目标使用（拖到目标上高亮、释放即移动）。
 */

/** 网格拖拽信息（拖拽中非空；结束/取消时广播 null） */
export type GridDragInfo = {
  /** 数据源：walk 走查库（page），product 产品库（标注集 set） */
  mode: 'walk' | 'product'
  kind: 'page' | 'set' | 'folder'
  id: string
  projectId: string
  /** 当前所在父级（页面/标注集 = folderId，文件夹 = parentId；undefined = 项目根） */
  parentId?: string
}

export const GRID_DRAG_EVENT = 'grid-drag-change'

/** 广播网格拖拽状态变化（info 为 null 表示拖拽已结束，含中途取消） */
export function emitGridDrag(info: GridDragInfo | null): void {
  window.dispatchEvent(new CustomEvent<GridDragInfo | null>(GRID_DRAG_EVENT, { detail: info }))
}
