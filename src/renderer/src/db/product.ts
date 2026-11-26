import Dexie, { type Table } from 'dexie'
import {
  clearSoftDelete,
  dedupeTrashName,
  db,
  type IssueAttachment,
  type IssueStatus,
  type Category,
  type Severity,
  type SoftDeleteFields,
  type TrashKind,
  type TrashOpResult,
  type TrashRow
} from './index'

/** ───────────── 产品标注数据模型 ───────────── */

/** 产品标注项目 */
export interface ProductProject extends SoftDeleteFields {
  id: string
  name: string
  /** 项目 Logo 相对路径（可选） */
  logoPath?: string
  /** 无 Logo 时文字占位底色（hex，空串 = 自动按项目散列取色） */
  logoColor?: string
  /** 侧边栏手动排序值（拖拽生成，小值在前），缺省按创建时间 */
  sortNo?: number
  createdAt: number
  updatedAt: number
}

/** 产品文件夹（支持多级嵌套） */
export interface ProductFolder extends SoftDeleteFields {
  id: string
  projectId: string
  /** 父文件夹 ID，undefined 表示项目根级 */
  parentId?: string
  name: string
  /** 预置图标 key */
  icon?: string
  /** 图标主题色（hex） */
  color?: string
  /** 手动排序值（拖拽生成，小值在前），缺省按创建时间 */
  sortNo?: number
  createdAt: number
}

/**
 * 产品标注集 = 项目详情网格中的一张「页面」卡片（对等 UI 走查的页面概念）。
 * 一个标注集内包含多张页面图，进入画板后以左侧缩略图导航与管理（而非在项目里并列展示）。
 */
export interface ProductAnnotationSet extends SoftDeleteFields {
  id: string
  projectId: string
  /** 所属文件夹 ID，undefined 表示项目根级 */
  folderId?: string
  /** 集名称（如"登录页"、"商品详情页"） */
  name: string
  /** 手动排序值（拖拽生成，小值在前），缺省按创建时间 */
  sortNo?: number
  createdAt: number
  updatedAt: number
}

/** 页面缩略图 webp dataURL 的最长边上限（960 ≈ 网格卡片 2× DPR 显示宽度：卡片最宽 300+ CSS px，480px 源图在 Retina 屏下发虚；旧分辨率缩略图按 thumbMax 标记懒升级） */
export const PRODUCT_THUMB_MAX = 960

/** 产品页面 = 标注集内的一张图片 + 上面的标注 */
export interface ProductPage extends SoftDeleteFields {
  id: string
  projectId: string
  /** 所属标注集 ID（一个集内多张页面以左侧缩略图导航） */
  setId?: string
  /** 旧版遗留字段：所属文件夹 ID（迁移后页面一律挂集，仅兜底兼容） */
  folderId?: string
  /** 页面名称（如"登录页"、"商品详情页"） */
  name: string
  /** 页面图片 Blob（从本地文件读取后存入 IndexedDB，不落盘） */
  image: Blob
  /** 缩略图 webp dataURL（最长边 ≤ PRODUCT_THUMB_MAX，供网格卡片与缩略导航栏渲染用） */
  thumbDataUrl: string
  /** 生成缩略图时的最长边上限（旧数据为 240 或缺省，用于进入项目时懒升级判断） */
  thumbMax?: number
  /** 页面排序值（拖拽生成，小值在前），缺省按创建时间 */
  sortNo?: number
  createdAt: number
}

/** 产品标注（画在页面上的标记）——复用走查侧 Category / Severity / IssueStatus / IssueAttachment 类型 */
export interface ProductAnnotation {
  id: string
  pageId: string
  /** 标注形状类型 */
  type: 'rect' | 'point' | 'arrow' | 'text' | 'measure' | 'picker'
  /** 归一化坐标（0~1），标注框左上角与宽高 */
  x: number
  y: number
  width: number
  height: number
  /** 备注内容 */
  description: string
  /** 自定义颜色（hex），缺省按严重度着色 */
  color?: string
  /** 测量标注的尺寸文案（如"128px"） */
  measureValue?: string
  /** 吸色标注取样色（hex） */
  sampleColor?: string
  /** 序号（用于标注编号排序，拖拽生成，缺省按创建时间排序） */
  sortNo?: number
  /** 严重度（与走查 Issue 共用枚举，供 IssueDrawer 着色与筛选） */
  severity?: Severity
  /** 状态（与走查 Issue 共用枚举，产品模式无 design-confirmed） */
  status?: IssueStatus
  /** 分类（与走查 Issue 共用枚举） */
  category?: Category
  /** 截图附件（与走查 Issue 共用类型） */
  attachments?: IssueAttachment[]
  createdAt: number
}

/** 产品模式问题清单（与走查 Issue 独立） */
export interface ProductIssue {
  id: string
  pageId: string
  /** 问题标题 */
  title: string
  /** 问题描述 */
  description: string
  /** 严重度 */
  severity: 'suggestion' | 'minor' | 'major'
  /** 状态 */
  status: 'pending' | 'in-progress' | 'fixed' | 'ignored'
  /** 关联标注 id（可选，可关联到某个 ProductAnnotation） */
  annotationId?: string
  createdAt: number
  updatedAt: number
}

/** 产品模式访问记录（供「最近访问」页统计；结构对等走查侧 Visit，pageId 存标注集 ID） */
export interface ProductVisit {
  id: string
  /** 标注集 ID（产品模式的访问单位 = 标注集，对等 UI 走查的页面） */
  pageId: string
  projectId: string
  visitedAt: number
}

/** ───────────── 独立数据库 ───────────── */

export class ProductAnnotationDB extends Dexie {
  projects!: Table<ProductProject, string>
  folders!: Table<ProductFolder, string>
  sets!: Table<ProductAnnotationSet, string>
  pages!: Table<ProductPage, string>
  annotations!: Table<ProductAnnotation, string>
  issues!: Table<ProductIssue, string>
  visits!: Table<ProductVisit, string>

  constructor() {
    super('product-annotation-db')
    this.version(1).stores({
      projects: 'id, name',
      pages: 'id, projectId, sortNo',
      annotations: 'id, pageId, type, sortNo',
      issues: 'id, pageId, status, severity, [pageId+status]'
    })
    // v2: 添加 folders 表 + pages 添加 folderId 索引
    this.version(2).stores({
      projects: 'id, name',
      folders: 'id, projectId, parentId',
      pages: 'id, projectId, folderId, sortNo',
      annotations: 'id, pageId, type, sortNo',
      issues: 'id, pageId, status, severity, [pageId+status]'
    })
    // v3: 引入标注集（sets）——项目网格以「标注集」为并列单位，集内多页面在画板左侧缩略图导航；
    // 旧数据迁移：每张既有 page 自动创建同名 set（沿用 sortNo/folderId），page.setId 指向该集
    this.version(3)
      .stores({
        projects: 'id, name',
        folders: 'id, projectId, parentId',
        sets: 'id, projectId, folderId, sortNo',
        pages: 'id, projectId, setId, folderId, sortNo',
        annotations: 'id, pageId, type, sortNo',
        issues: 'id, pageId, status, severity, [pageId+status]'
      })
      .upgrade(async (tx) => {
        const pagesTable = tx.table('pages')
        const setsTable = tx.table('sets')
        const pages: ProductPage[] = await pagesTable.toArray()
        for (const p of pages) {
          if (p.setId) continue
          const setId = genId()
          await setsTable.add({
            id: setId,
            projectId: p.projectId,
            folderId: p.folderId,
            name: p.name,
            sortNo: p.sortNo,
            createdAt: p.createdAt,
            updatedAt: p.createdAt
          })
          await pagesTable.update(p.id, { setId })
        }
      })
    // v4: 添加 visits 表（访问记录，供产品模式「最近访问」页统计）
    this.version(4).stores({
      projects: 'id, name',
      folders: 'id, projectId, parentId',
      sets: 'id, projectId, folderId, sortNo',
      pages: 'id, projectId, setId, folderId, sortNo',
      annotations: 'id, pageId, type, sortNo',
      issues: 'id, pageId, status, severity, [pageId+status]',
      visits: 'id, pageId, projectId, visitedAt'
    })
  }
}

export const productDb = new ProductAnnotationDB()

/** ───────────── 工具函数 ───────────── */

/** 生成唯一 id（与 WalkthroughDB 中的 genId 独立副本） */
export function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** 树状菜单/列表统一排序：手动 sortNo 优先（小值在前），未拖过的按创建时间 */
export const bySort = <T extends { sortNo?: number; createdAt: number }>(a: T, b: T) =>
  (a.sortNo ?? a.createdAt) - (b.sortNo ?? b.createdAt)

/** 级联删除单个标注集（删除集内所有页面及其标注/问题清单） */
export async function deleteProductSetCascade(setId: string): Promise<void> {
  const pages = await productDb.pages.where('setId').equals(setId).toArray()
  const pageIds = pages.map((p) => p.id)
  if (pageIds.length) {
    await productDb.annotations.where('pageId').anyOf(pageIds).delete()
    await productDb.issues.where('pageId').anyOf(pageIds).delete()
  }
  await productDb.pages.where('setId').equals(setId).delete()
  await productDb.sets.delete(setId)
}

/** 级联删除产品文件夹（BFS 收集所有子孙文件夹，删除其下标注集、页面和标注） */
export async function deleteProductFolderCascade(folderId: string): Promise<void> {
  const allIds: string[] = []
  const seen = new Set<string>([folderId])
  let frontier = [folderId]
  while (frontier.length) {
    allIds.push(...frontier)
    const children = await productDb.folders
      .where('parentId')
      .anyOf(frontier)
      .filter((f) => !seen.has(f.id))
      .toArray()
    frontier = children.map((f) => f.id)
    frontier.forEach((id) => seen.add(id))
  }
  // 删除所有文件夹下的标注集（级联页面与标注）
  const sets = await productDb.sets.where('folderId').anyOf(allIds).toArray()
  for (const s of sets) {
    await deleteProductSetCascade(s.id)
  }
  // 兜底：清理仍直接挂在文件夹下的旧数据页面及其标注
  const pages = await productDb.pages.where('folderId').anyOf(allIds).toArray()
  for (const page of pages) {
    await productDb.annotations.where('pageId').equals(page.id).delete()
    await productDb.issues.where('pageId').equals(page.id).delete()
  }
  await productDb.pages.where('folderId').anyOf(allIds).delete()
  await productDb.folders.bulkDelete(allIds)
}

/** ───────────── 软删除（回收站）：仅打标记隐藏，记录与库内 Blob 一律保留 ───────────── */

/**
 * 产品项目软删除（级联）：项目本体与其下全部文件夹（含子孙）、标注集、页面打同一批
 * deletedAt 标记；页面 Blob 直存库内随记录保留，标注/问题清单/访问记录不动。
 * 幂等：已是软删状态（deletedAt 非空）的记录保持原标记不覆盖。
 */
export async function softDeleteProductProjects(projectIds: string[], now?: number): Promise<void> {
  if (!projectIds.length) return
  const ts = now ?? Date.now()
  const projects = (await productDb.projects.bulkGet(projectIds)).filter(
    (p): p is ProductProject => !!p && !p.deletedAt
  )
  await productDb.projects.bulkPut(
    projects.map((p) => ({
      ...p,
      deletedAt: ts,
      originalParentId: null,
      restoreOrder: p.sortNo ?? null,
      deletedInMode: 'product' as const
    }))
  )
  const mark = <T extends { deletedAt?: number | null }>(rows: T[]) => rows.filter((r) => !r.deletedAt)
  const folders = mark(await productDb.folders.where('projectId').anyOf(projectIds).toArray())
  if (folders.length) {
    await productDb.folders.bulkPut(
      folders.map((f) => ({
        ...f,
        deletedAt: ts,
        originalParentId: f.parentId ?? null,
        restoreOrder: f.sortNo ?? null,
        deletedInMode: 'product' as const
      }))
    )
  }
  const sets = mark(await productDb.sets.where('projectId').anyOf(projectIds).toArray())
  if (sets.length) {
    await productDb.sets.bulkPut(
      sets.map((s) => ({
        ...s,
        deletedAt: ts,
        originalParentId: s.folderId ?? null,
        restoreOrder: s.sortNo ?? null,
        deletedInMode: 'product' as const
      }))
    )
  }
  const pages = mark(await productDb.pages.where('projectId').anyOf(projectIds).toArray())
  if (pages.length) {
    await productDb.pages.bulkPut(
      pages.map((p) => ({
        ...p,
        deletedAt: ts,
        originalParentId: p.setId ?? p.folderId ?? null,
        restoreOrder: p.sortNo ?? null,
        deletedInMode: 'product' as const
      }))
    )
  }
}

/**
 * 产品文件夹软删除（级联）：BFS 收集全部子孙文件夹（防环，与 deleteProductFolderCascade
 * 同口径），连同树下标注集、集内页面与旧数据直挂文件夹的页面打同一批 deletedAt 标记。
 * 幂等：跳过已软删记录。
 */
export async function softDeleteProductFolders(folderIds: string[], now?: number): Promise<void> {
  if (!folderIds.length) return
  const ts = now ?? Date.now()
  const allIds: string[] = []
  const seen = new Set<string>(folderIds)
  let frontier = [...folderIds]
  while (frontier.length) {
    allIds.push(...frontier)
    const children = await productDb.folders
      .where('parentId')
      .anyOf(frontier)
      .filter((f) => !seen.has(f.id))
      .toArray()
    frontier = children.map((f) => f.id)
    frontier.forEach((id) => seen.add(id))
  }
  const folders = (await productDb.folders.bulkGet(allIds)).filter(
    (f): f is ProductFolder => !!f && !f.deletedAt
  )
  if (folders.length) {
    await productDb.folders.bulkPut(
      folders.map((f) => ({
        ...f,
        deletedAt: ts,
        originalParentId: f.parentId ?? null,
        restoreOrder: f.sortNo ?? null,
        deletedInMode: 'product' as const
      }))
    )
  }
  const sets = (await productDb.sets.where('folderId').anyOf(allIds).toArray()).filter(
    (s) => !s.deletedAt
  )
  if (sets.length) {
    await productDb.sets.bulkPut(
      sets.map((s) => ({
        ...s,
        deletedAt: ts,
        originalParentId: s.folderId ?? null,
        restoreOrder: s.sortNo ?? null,
        deletedInMode: 'product' as const
      }))
    )
  }
  // 页面：集内页面 + 旧数据兜底（直接挂文件夹的页面），跳过已软删
  const setIds = sets.map((s) => s.id)
  const pageRows = [
    ...(setIds.length ? await productDb.pages.where('setId').anyOf(setIds).toArray() : []),
    ...(await productDb.pages.where('folderId').anyOf(allIds).toArray())
  ]
  const pageMap = new Map<string, ProductPage>()
  for (const p of pageRows) if (!p.deletedAt) pageMap.set(p.id, p)
  if (pageMap.size) {
    await productDb.pages.bulkPut(
      [...pageMap.values()].map((p) => ({
        ...p,
        deletedAt: ts,
        originalParentId: p.setId ?? p.folderId ?? null,
        restoreOrder: p.sortNo ?? null,
        deletedInMode: 'product' as const
      }))
    )
  }
}

/** 标注集软删除（级联）：集与其内全部页面打同一批 deletedAt 标记，标注/问题清单不动。幂等。 */
export async function softDeleteProductSets(setIds: string[], now?: number): Promise<void> {
  if (!setIds.length) return
  const sets = (await productDb.sets.bulkGet(setIds)).filter(
    (s): s is ProductAnnotationSet => !!s && !s.deletedAt
  )
  if (!sets.length) return
  const ts = now ?? Date.now()
  await productDb.sets.bulkPut(
    sets.map((s) => ({
      ...s,
      deletedAt: ts,
      originalParentId: s.folderId ?? null,
      restoreOrder: s.sortNo ?? null,
      deletedInMode: 'product' as const
    }))
  )
  const pages = (await productDb.pages.where('setId').anyOf(sets.map((s) => s.id)).toArray()).filter(
    (p) => !p.deletedAt
  )
  if (pages.length) {
    await productDb.pages.bulkPut(
      pages.map((p) => ({
        ...p,
        deletedAt: ts,
        originalParentId: p.setId ?? p.folderId ?? null,
        restoreOrder: p.sortNo ?? null,
        deletedInMode: 'product' as const
      }))
    )
  }
}

/** ───────────── 回收站（阶段 2）：读取 / 还原 / 彻底删除 ───────────── */

/** 回收站是否有内容（任一表存在软删记录即 true）：供侧边栏按需显示「回收站」菜单 */
export async function hasProductTrash(): Promise<boolean> {
  for (const table of [productDb.projects, productDb.folders, productDb.sets, productDb.pages]) {
    if ((await table.filter((r) => !!r.deletedAt).limit(1).count()) > 0) return true
  }
  // 产品导出报告存于走查库 reportRecords 表（两模式共用），按 deletedInMode 取本模式记录
  if ((await db.reportRecords.filter((r) => !!r.deletedAt && r.deletedInMode === 'product').limit(1).count()) > 0) {
    return true
  }
  return false
}

/** 产品侧回收站报告行（kind 'report'）：产品导出与走查导出共用 reportRecords 表（walk 库），
 *  按 deletedInMode='product' 取本模式记录；原位置 = 产品项目 + 标注集（pageId 缺省 = 项目级报告） */
export async function getProductTrashReports(): Promise<TrashRow[]> {
  const [reports, projects, sets] = await Promise.all([
    db.reportRecords.toArray(),
    productDb.projects.toArray(),
    productDb.sets.toArray()
  ])
  const projectMap = new Map(projects.map((p) => [p.id, p]))
  const setMap = new Map(sets.map((s) => [s.id, s]))
  return reports
    .filter((r) => !!r.deletedAt && r.deletedInMode === 'product')
    .map((r) => {
      const set = r.pageId ? setMap.get(r.pageId) : undefined
      const proj = projectMap.get(r.projectId)
      return {
        kind: 'report' as const,
        id: r.id,
        name: r.name,
        projectId: r.projectId,
        parentId: r.pageId || null,
        locationPath: [...(proj ? [proj.name] : []), ...(set ? [set.name] : [])],
        deletedAt: r.deletedAt!,
        objects: 1,
        attachments: 0
      }
    })
}

/** 还原产品侧软删报告：所属标注集也被软删时一并还原；标注集已被彻底删除则放弃还原
 *  （pageId 为空的项目级报告直接还原本体） */
export async function restoreProductReports(ids: string[]): Promise<TrashOpResult> {
  const res: TrashOpResult = { ok: 0, toRoot: 0, failed: 0 }
  for (const id of ids) {
    try {
      const row = await db.reportRecords.get(id)
      if (!row || !row.deletedAt || (row.deletedInMode && row.deletedInMode !== 'product')) {
        res.failed++
        continue
      }
      if (row.pageId) {
        const set = await productDb.sets.get(row.pageId)
        if (!set) {
          console.warn('[TRASH] 还原报告失败（原标注集已不存在）:', id)
          res.failed++
          continue
        }
        if (set.deletedAt) {
          const r = await restoreProductSets([set.id])
          if (r.ok === 0) {
            res.failed++
            continue
          }
        }
      }
      await db.reportRecords.put(clearSoftDelete(row))
      res.ok++
    } catch (err) {
      console.warn('[TRASH] 还原报告失败:', id, err)
      res.failed++
    }
  }
  return res
}

/** 读取产品侧回收站全部软删记录（项目/文件夹/标注集），归一为 TrashRow。
 *  标注集对等 UI 走查的「页面」卡片，TrashRow.kind 用 'page'；集内图片页随集进出，不单独成行 */
export async function getProductTrashRows(): Promise<TrashRow[]> {
  const [projects, folders, sets, pages] = await Promise.all([
    productDb.projects.toArray(),
    productDb.folders.toArray(),
    productDb.sets.toArray(),
    productDb.pages.toArray()
  ])
  const projectMap = new Map(projects.map((p) => [p.id, p]))
  const folderMap = new Map(folders.map((f) => [f.id, f]))
  const delProjects = projects.filter((p) => !!p.deletedAt)
  const delFolders = folders.filter((f) => !!f.deletedAt)
  const delSets = sets.filter((s) => !!s.deletedAt)
  const delPages = pages.filter((p) => !!p.deletedAt)

  // 附件数按 pageId 汇总（标注截图附件，走查/产品共用 IssueAttachment）
  const pageIds = delPages.map((p) => p.id)
  const pageAnnotations = pageIds.length
    ? await productDb.annotations.where('pageId').anyOf(pageIds).toArray()
    : []
  const attByPage = new Map<string, number>()
  for (const a of pageAnnotations) {
    const n = a.attachments?.length ?? 0
    if (n) attByPage.set(a.pageId, (attByPage.get(a.pageId) ?? 0) + n)
  }
  const pageAttSum = (list: ProductPage[]): number =>
    list.reduce((sum, pg) => sum + (attByPage.get(pg.id) ?? 0), 0)

  const ancestorNames = (folderId?: string): string[] => {
    const chain: string[] = []
    const seen = new Set<string>()
    let cur = folderId ? folderMap.get(folderId) : undefined
    while (cur && !seen.has(cur.id)) {
      chain.unshift(cur.name)
      seen.add(cur.id)
      cur = cur.parentId ? folderMap.get(cur.parentId) : undefined
    }
    return chain
  }
  const descendantsOf = (rootId: string): Set<string> => {
    const out = new Set<string>([rootId])
    let frontier = [rootId]
    while (frontier.length) {
      const children = folders.filter(
        (f) => f.parentId != null && frontier.includes(f.parentId) && !out.has(f.id)
      )
      children.forEach((c) => out.add(c.id))
      frontier = children.map((c) => c.id)
    }
    return out
  }

  const rows: TrashRow[] = []
  for (const p of delProjects) {
    const subSets = delSets.filter((s) => s.projectId === p.id)
    const subPages = delPages.filter((pg) => pg.projectId === p.id)
    rows.push({
      kind: 'project',
      id: p.id,
      name: p.name,
      locationPath: [],
      deletedAt: p.deletedAt!,
      objects: 1 + delFolders.filter((f) => f.projectId === p.id).length + subSets.length + subPages.length,
      attachments: pageAttSum(subPages)
    })
  }
  for (const f of delFolders) {
    const desc = descendantsOf(f.id)
    const innerSets = delSets.filter((s) => s.folderId != null && desc.has(s.folderId))
    const setIds = new Set(innerSets.map((s) => s.id))
    // 集内页面 + 旧数据直挂文件夹的页面（与 softDeleteProductFolders 同口径）
    const innerPages = delPages.filter((pg) => (pg.setId && setIds.has(pg.setId)) || (pg.folderId != null && desc.has(pg.folderId)))
    rows.push({
      kind: 'folder',
      id: f.id,
      name: f.name,
      projectId: f.projectId,
      parentId: f.parentId ?? null,
      locationPath: [
        ...(projectMap.get(f.projectId)?.name ? [projectMap.get(f.projectId)!.name] : []),
        ...ancestorNames(f.id)
      ],
      deletedAt: f.deletedAt!,
      objects: desc.size + innerSets.length + innerPages.length,
      attachments: pageAttSum(innerPages)
    })
  }
  for (const s of delSets) {
    const proj = projectMap.get(s.projectId)
    const innerPages = delPages.filter((pg) => pg.setId === s.id)
    rows.push({
      kind: 'page',
      id: s.id,
      name: s.name,
      projectId: s.projectId,
      parentId: s.originalParentId ?? s.folderId ?? null,
      locationPath: [...(proj ? [proj.name] : []), ...ancestorNames(s.folderId)],
      deletedAt: s.deletedAt!,
      objects: 1 + innerPages.length,
      attachments: pageAttSum(innerPages)
    })
  }
  return rows
}

/** 还原链顶软删项目记录（仅本体清字段，不级联其其他子孙）；记录不存在返回 false */
async function restoreProductProjectRecord(projectId: string): Promise<boolean> {
  const proj = await productDb.projects.get(projectId)
  if (!proj) return false
  if (proj.deletedAt) await productDb.projects.put(clearSoftDelete(proj))
  return true
}

/** 还原软删父级链（标注集还原时用）：沿 parentId 向上还原软删祖先文件夹；
 *  链上记录已被彻底删除视为断链返回 false，调用方挂到项目根目录 */
async function restoreProductFolderChain(folderId: string): Promise<boolean> {
  let curId: string | undefined = folderId
  const seen = new Set<string>()
  while (curId && !seen.has(curId)) {
    seen.add(curId)
    const row: ProductFolder | undefined = await productDb.folders.get(curId)
    if (!row) return false
    if (row.deletedAt) await productDb.folders.put(clearSoftDelete(row))
    curId = row.parentId ?? undefined
  }
  return true
}

/** 还原产品侧软删项目：本体插回根目录（同名加序号后缀），全部软删子项（文件夹/标注集/页面）一并还原 */
export async function restoreProductProjects(ids: string[]): Promise<TrashOpResult> {
  const res: TrashOpResult = { ok: 0, toRoot: 0, failed: 0 }
  const taken = new Set(
    (await productDb.projects.toArray()).filter((p) => !p.deletedAt).map((p) => p.name)
  )
  for (const id of ids) {
    try {
      const row = await productDb.projects.get(id)
      // 幂等：记录不存在 / 已还原 / 模式不符直接跳过
      if (!row || !row.deletedAt || (row.deletedInMode && row.deletedInMode !== 'product')) {
        res.failed++
        continue
      }
      const next = clearSoftDelete(row)
      next.name = dedupeTrashName(next.name, taken)
      taken.add(next.name)
      await productDb.projects.put(next)
      const fs = (await productDb.folders.where('projectId').equals(id).toArray()).filter((f) => f.deletedAt)
      if (fs.length) await productDb.folders.bulkPut(fs.map(clearSoftDelete))
      const ss = (await productDb.sets.where('projectId').equals(id).toArray()).filter((s) => s.deletedAt)
      if (ss.length) await productDb.sets.bulkPut(ss.map(clearSoftDelete))
      const ps = (await productDb.pages.where('projectId').equals(id).toArray()).filter((p) => p.deletedAt)
      if (ps.length) await productDb.pages.bulkPut(ps.map(clearSoftDelete))
      res.ok++
    } catch (err) {
      console.warn('[TRASH] 还原项目失败:', id, err)
      res.failed++
    }
  }
  return res
}

/** 还原产品侧软删文件夹：整条父级链一并还原，全部软删子孙文件夹、标注集与页面同批还原 */
export async function restoreProductFolders(ids: string[]): Promise<TrashOpResult> {
  const res: TrashOpResult = { ok: 0, toRoot: 0, failed: 0 }
  for (const id of ids) {
    try {
      const row = await productDb.folders.get(id)
      if (!row || !row.deletedAt || (row.deletedInMode && row.deletedInMode !== 'product')) {
        res.failed++
        continue
      }
      // 链顶项目已被彻底删除 → 文件夹无处可挂，放弃还原
      if (!(await restoreProductProjectRecord(row.projectId))) {
        console.warn('[TRASH] 还原文件夹失败（原项目已不存在）:', id)
        res.failed++
        continue
      }
      // 上级文件夹路径：父目录软删 → 同步还原整条祖先链（项目级联删除后单还原子文件夹的场景）；
      // 链上目录已被彻底删除 → 挂项目根目录
      let parentId: string | undefined = row.originalParentId ?? row.parentId ?? undefined
      if (parentId) {
        const parent = await productDb.folders.get(parentId)
        if (!parent) {
          parentId = undefined
          res.toRoot++
        } else if (parent.deletedAt && !(await restoreProductFolderChain(parent.id))) {
          parentId = undefined
          res.toRoot++
        }
      }
      const sameLayer = (await productDb.folders.where('projectId').equals(row.projectId).toArray()).filter(
        (f) => !f.deletedAt && f.id !== id && (f.parentId ?? undefined) === parentId
      )
      const taken = new Set(sameLayer.map((f) => f.name))
      const next = clearSoftDelete(row)
      next.parentId = parentId
      next.name = dedupeTrashName(next.name, taken)
      await productDb.folders.put(next)
      // BFS 收集软删子孙文件夹（与 softDeleteProductFolders 同口径），连同其下标注集、页面一并还原
      const allIds = [id]
      const seen = new Set([id])
      let frontier = [id]
      while (frontier.length) {
        const children = await productDb.folders
          .where('parentId')
          .anyOf(frontier)
          .filter((f) => !seen.has(f.id))
          .toArray()
        frontier = children.map((f) => f.id)
        frontier.forEach((fid) => seen.add(fid))
        allIds.push(...frontier)
      }
      const childFolders = (await productDb.folders.bulkGet(allIds.filter((fid) => fid !== id))).filter(
        (f): f is ProductFolder => !!f && !!f.deletedAt
      )
      if (childFolders.length) await productDb.folders.bulkPut(childFolders.map(clearSoftDelete))
      const childSets = (await productDb.sets.where('folderId').anyOf(allIds).toArray()).filter((s) => s.deletedAt)
      if (childSets.length) await productDb.sets.bulkPut(childSets.map(clearSoftDelete))
      const setIds = childSets.map((s) => s.id)
      const childPages = (
        await productDb.pages.where(setIds.length ? 'setId' : 'folderId').anyOf(setIds.length ? setIds : allIds).toArray()
      )
        .concat(setIds.length ? await productDb.pages.where('folderId').anyOf(allIds).toArray() : [])
        .filter((p) => p.deletedAt)
      const pageMap = new Map(childPages.map((p) => [p.id, p]))
      if (pageMap.size) await productDb.pages.bulkPut([...pageMap.values()].map(clearSoftDelete))
      res.ok++
    } catch (err) {
      console.warn('[TRASH] 还原文件夹失败:', id, err)
      res.failed++
    }
  }
  return res
}

/** 还原产品侧软删标注集：集内页面一并还原；原文件夹已被彻底删除时挂到项目根目录 */
export async function restoreProductSets(ids: string[]): Promise<TrashOpResult> {
  const res: TrashOpResult = { ok: 0, toRoot: 0, failed: 0 }
  for (const id of ids) {
    try {
      const row = await productDb.sets.get(id)
      if (!row || !row.deletedAt || (row.deletedInMode && row.deletedInMode !== 'product')) {
        res.failed++
        continue
      }
      if (!(await restoreProductProjectRecord(row.projectId))) {
        console.warn('[TRASH] 还原标注集失败（原项目已不存在）:', id)
        res.failed++
        continue
      }
      // 父目录：originalParentId 优先；目录软删 → 还原整条父级链；目录已被彻底删除 → 挂项目根目录
      const parentId = row.originalParentId ?? row.folderId ?? undefined
      let folderId: string | undefined = undefined
      if (parentId) {
        const parent = await productDb.folders.get(parentId)
        if (!parent) {
          folderId = undefined
          res.toRoot++
        } else if (parent.deletedAt) {
          const chainOk = await restoreProductFolderChain(parent.id)
          if (!chainOk) {
            folderId = undefined
            res.toRoot++
          } else folderId = parent.id
        } else folderId = parent.id
      }
      const sameLayer = (await productDb.sets.where('projectId').equals(row.projectId).toArray()).filter(
        (s) => !s.deletedAt && s.id !== id && (s.folderId ?? undefined) === folderId
      )
      const taken = new Set(sameLayer.map((s) => s.name))
      const next = clearSoftDelete(row)
      next.folderId = folderId
      next.name = dedupeTrashName(next.name, taken)
      await productDb.sets.put(next)
      // 还原父项时子项一并还原：集内页面同批恢复
      const innerPages = (await productDb.pages.where('setId').equals(id).toArray()).filter((p) => p.deletedAt)
      if (innerPages.length) await productDb.pages.bulkPut(innerPages.map(clearSoftDelete))
      res.ok++
    } catch (err) {
      console.warn('[TRASH] 还原标注集失败:', id, err)
      res.failed++
    }
  }
  return res
}

/** 彻底删除产品侧软删项目：复用既有级联清理标注集/文件夹/页面/标注/问题，Logo 图片物理删除 */
export async function permanentlyDeleteProductProjects(ids: string[]): Promise<TrashOpResult> {
  const res: TrashOpResult = { ok: 0, toRoot: 0, failed: 0 }
  for (const id of ids) {
    try {
      const proj = await productDb.projects.get(id)
      if (!proj || !proj.deletedAt) {
        res.failed++
        continue
      }
      const sets = await productDb.sets.where('projectId').equals(id).toArray()
      // 先收集本项目页面的标注附件磁盘原图（共用 IssueAttachment；后续级联删除标注记录）
      const pageIds = (await productDb.pages.where('projectId').equals(id).toArray()).map((p) => p.id)
      const attPaths = pageIds.length
        ? (
            await productDb.annotations.where('pageId').anyOf(pageIds).toArray()
          ).flatMap((a) => (a.attachments ?? []).map((att) => att.relPath)).filter((p): p is string => !!p)
        : []
      for (const s of sets) await deleteProductSetCascade(s.id)
      // 兜底：旧数据直挂项目/文件夹的残余页面及其标注/问题
      const restPages = await productDb.pages.where('projectId').equals(id).toArray()
      const restIds = restPages.map((p) => p.id)
      if (restIds.length) {
        await productDb.annotations.where('pageId').anyOf(restIds).delete()
        await productDb.issues.where('pageId').anyOf(restIds).delete()
        await productDb.pages.bulkDelete(restIds)
      }
      // 项目 Logo 与本项目标注附件原图物理清理
      const purgePaths = [...new Set([...(proj.logoPath ? [proj.logoPath] : []), ...attPaths])]
      if (purgePaths.length) {
        await window.electronAPI
          .purgeImages(purgePaths)
          .catch((err) => console.warn('[TRASH] 清理产品项目图片失败:', id, err))
      }
      await productDb.folders.where('projectId').equals(id).delete()
      await productDb.projects.delete(id)
      res.ok++
    } catch (err) {
      console.warn('[TRASH] 彻底删除项目失败:', id, err)
      res.failed++
    }
  }
  return res
}

/** 彻底删除产品侧软删文件夹：复用既有级联（子孙文件夹/标注集/页面/标注/问题全清） */
export async function permanentlyDeleteProductFolders(ids: string[]): Promise<TrashOpResult> {
  const res: TrashOpResult = { ok: 0, toRoot: 0, failed: 0 }
  for (const id of ids) {
    try {
      const row = await productDb.folders.get(id)
      if (!row || !row.deletedAt) {
        res.failed++
        continue
      }
      await deleteProductFolderCascade(id)
      res.ok++
    } catch (err) {
      console.warn('[TRASH] 彻底删除文件夹失败:', id, err)
      res.failed++
    }
  }
  return res
}

/** 彻底删除产品侧软删标注集：复用既有级联（集内页面/标注/问题全清；Blob 随记录移除） */
export async function permanentlyDeleteProductSets(ids: string[]): Promise<TrashOpResult> {
  const res: TrashOpResult = { ok: 0, toRoot: 0, failed: 0 }
  for (const id of ids) {
    try {
      const row = await productDb.sets.get(id)
      if (!row || !row.deletedAt) {
        res.failed++
        continue
      }
      await deleteProductSetCascade(id)
      res.ok++
    } catch (err) {
      console.warn('[TRASH] 彻底删除标注集失败:', id, err)
      res.failed++
    }
  }
  return res
}

/** 批量删除快照：Cmd+Z 撤回所需的完整记录（图片为 Blob 直存库内，随记录一并恢复，无需文件恢复） */
export interface ProductDeleteEntry {
  folders: ProductFolder[]
  sets: ProductAnnotationSet[]
  pages: ProductPage[]
  annotations: ProductAnnotation[]
  issues: ProductIssue[]
}

/**
 * 批量删除前快照（Cmd+Z 撤回用）：收集选中文件夹的全部子孙文件夹（与
 * deleteProductFolderCascade 同口径），连同选中标注集一并取回完整级联记录。
 * 注意不含访问记录：既有删除级联本就不清 visits，恢复时也不能重复写回。
 */
export async function captureProductBatchDeleteUndo(ids: string[]): Promise<ProductDeleteEntry> {
  const isFolder = new Set(
    (await productDb.folders.bulkGet(ids))
      .filter((f): f is ProductFolder => !!f)
      .map((f) => f.id)
  )
  // BFS 收集选中文件夹的子孙文件夹（防环：访问集去重）
  const collected: string[] = []
  const seen = new Set<string>(ids.filter((id) => isFolder.has(id)))
  let frontier = [...seen]
  while (frontier.length) {
    collected.push(...frontier)
    const children = await productDb.folders
      .where('parentId')
      .anyOf(frontier)
      .filter((f) => !seen.has(f.id))
      .toArray()
    frontier = children.map((f) => f.id)
    frontier.forEach((id) => seen.add(id))
  }
  // 标注集：直接选中的（非文件夹）+ 文件夹树下的，按 id 去重
  const setMap = new Map<string, ProductAnnotationSet>()
  for (const id of ids) {
    if (isFolder.has(id)) continue
    const s = await productDb.sets.get(id)
    if (s) setMap.set(s.id, s)
  }
  if (collected.length) {
    for (const s of await productDb.sets.where('folderId').anyOf(collected).toArray())
      setMap.set(s.id, s)
  }
  // 页面：集内页面 + 旧数据兜底（直接挂文件夹的页面，与删除级联同口径），按 id 去重
  const pageMap = new Map<string, ProductPage>()
  const setIds = [...setMap.keys()]
  if (setIds.length) {
    for (const p of await productDb.pages.where('setId').anyOf(setIds).toArray()) pageMap.set(p.id, p)
  }
  if (collected.length) {
    for (const p of await productDb.pages.where('folderId').anyOf(collected).toArray())
      pageMap.set(p.id, p)
  }
  const pageIds = [...pageMap.keys()]
  return {
    folders: collected.length
      ? (await productDb.folders.bulkGet(collected)).filter((f): f is ProductFolder => !!f)
      : [],
    sets: [...setMap.values()],
    pages: [...pageMap.values()],
    annotations: pageIds.length
      ? await productDb.annotations.where('pageId').anyOf(pageIds).toArray()
      : [],
    issues: pageIds.length ? await productDb.issues.where('pageId').anyOf(pageIds).toArray() : []
  }
}

/** 记录一次标注集访问（30 分钟去重，仅保留最近 500 条），供「最近访问」页统计 */
export async function recordProductVisit(setId: string, projectId: string): Promise<void> {
  const set = await productDb.sets.get(setId)
  if (!set) return
  const last = await productDb.visits.where('pageId').equals(setId).last()
  const now = Date.now()
  if (last && now - last.visitedAt < 30 * 60 * 1000) return
  await productDb.visits.add({ id: genId(), pageId: setId, projectId, visitedAt: now })
  const count = await productDb.visits.count()
  if (count > 500) {
    const stale = await productDb.visits.orderBy('visitedAt').limit(count - 500).primaryKeys()
    await productDb.visits.bulkDelete(stale)
  }
}
