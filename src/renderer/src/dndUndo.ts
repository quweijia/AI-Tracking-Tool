import { db, type WalkDeleteEntry } from './db'
import { productDb, type ProductDeleteEntry } from './db/product'
import { tr } from './i18n'
import { showToast } from './components/Toast'

/** 位置快照：Cmd+Z 撤销拖拽排序 / 移动层级所需的最小还原数据
 *  文件夹按 parentId（undefined = 根级），页面/标注集按 folderId（undefined = 根级）；
 *  页面/标注集含 projectId（跨项目移动后撤销需还原所属项目） */
type ItemSnap = { id: string; projectId?: string; parentId?: string; folderId?: string; sortNo?: number }

/** 撤销栈条目：位置快照（拖拽排序 / 移动）或删除快照（批量删除撤回，LIFO 交错正确） */
type UndoEntry =
  | { kind: 'pos'; folders: ItemSnap[]; pages: ItemSnap[] }
  | { kind: 'del-walk'; data: WalkDeleteEntry }
  | { kind: 'del-product'; data: ProductDeleteEntry }

/** 会话级撤销栈（内存）：走查 / 产品两库独立记录；上限 30 步 */
const undoStacks: Record<'walk' | 'product', UndoEntry[]> = { walk: [], product: [] }

/** 是否有可撤销记录（快捷键里同步判断是否拦截按键） */
export function hasUndo(mode: 'walk' | 'product'): boolean {
  return undoStacks[mode].length > 0
}

/** 压栈：全量快照某库的文件夹与页面/标注集位置，拖拽排序 / 移动层级写库前 await 调用 */
export async function pushUndo(mode: 'walk' | 'product'): Promise<void> {
  const folderTable = mode === 'walk' ? db.folders : productDb.folders
  const pageTable = mode === 'walk' ? db.pages : productDb.sets
  const [folders, pages] = await Promise.all([folderTable.toArray(), pageTable.toArray()])
  const stack = undoStacks[mode]
  stack.push({
    kind: 'pos',
    folders: folders.map((f) => ({ id: f.id, parentId: f.parentId, sortNo: f.sortNo })),
    pages: pages.map((p) => ({ id: p.id, projectId: p.projectId, folderId: p.folderId, sortNo: p.sortNo }))
  })
  if (stack.length > 30) stack.shift()
}

/** 压栈：批量删除快照（删除前 await capture*Undo 拿到快照，删除落库成功后调用） */
export function pushDeleteUndo(
  mode: 'walk' | 'product',
  data: WalkDeleteEntry | ProductDeleteEntry
): void {
  const stack = undoStacks[mode]
  stack.push(
    mode === 'walk'
      ? { kind: 'del-walk', data: data as WalkDeleteEntry }
      : { kind: 'del-product', data: data as ProductDeleteEntry }
  )
  if (stack.length > 30) stack.shift()
}

/** 撤销最近一次位置变更：按快照逐一恢复，无记录返回 false。
 *  update 传 undefined 值时 Dexie 会删除该属性，正好还原「根级（无 parentId/folderId）」的初始态 */
export async function undoOnce(mode: 'walk' | 'product'): Promise<boolean> {
  const entry = undoStacks[mode].pop()
  if (!entry) return false
  if (entry.kind !== 'pos') {
    await undoDelete(mode, entry)
    return true
  }
  const folderTable = mode === 'walk' ? db.folders : productDb.folders
  const pageTable = mode === 'walk' ? db.pages : productDb.sets
  await Promise.all([
    ...entry.folders.map((s) => folderTable.update(s.id, { parentId: s.parentId, sortNo: s.sortNo })),
    ...entry.pages.map((s) => pageTable.update(s.id, { projectId: s.projectId, folderId: s.folderId, sortNo: s.sortNo }))
  ])
  return true
}

/** 撤销批量删除：走查侧先按快照路径从回收站恢复图片文件，再事务回写全部记录；产品侧图片为 Blob 直存，直接回写 */
async function undoDelete(
  mode: 'walk' | 'product',
  entry: Extract<UndoEntry, { kind: 'del-walk' | 'del-product' }>
): Promise<void> {
  const ns = mode === 'walk' ? 'pageGrid' : 'productProjectList'
  if (entry.kind === 'del-walk') {
    const d = entry.data
    // 先恢复文件再写记录：页面卡片读图依赖磁盘文件
    await window.electronAPI.restoreImages(d.imagePaths).catch(() => 0)
    await db.transaction('rw', db.folders, db.pages, db.issues, db.visits, async () => {
      if (d.folders.length) await db.folders.bulkPut(d.folders)
      if (d.pages.length) await db.pages.bulkPut(d.pages)
      if (d.issues.length) await db.issues.bulkPut(d.issues)
      if (d.visits.length) await db.visits.bulkPut(d.visits)
    })
    showToast(tr('undoRestored', ns, { n: d.pages.length }), { tone: 'success' })
  } else {
    const d = entry.data
    await productDb.transaction(
      'rw',
      productDb.folders,
      productDb.sets,
      productDb.pages,
      productDb.annotations,
      productDb.issues,
      async () => {
        if (d.folders.length) await productDb.folders.bulkPut(d.folders)
        if (d.sets.length) await productDb.sets.bulkPut(d.sets)
        if (d.pages.length) await productDb.pages.bulkPut(d.pages)
        if (d.annotations.length) await productDb.annotations.bulkPut(d.annotations)
        if (d.issues.length) await productDb.issues.bulkPut(d.issues)
      }
    )
    showToast(tr('undoRestored', ns, { n: d.sets.length }), { tone: 'success' })
  }
}
