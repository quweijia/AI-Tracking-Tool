import Dexie, { type Table } from 'dexie'

export type Platform = 'h5' | 'pc' | 'dashboard' | 'electron'
export type PageStatus = 'pending' | 'reviewing' | 'completed'
export type IssueStatus = 'pending' | 'in-progress' | 'fixed' | 'ignored' | 'design-confirmed'
export type Severity = 'suggestion' | 'minor' | 'major'
export type Category = 'spacing' | 'typography' | 'color' | 'style' | 'interaction' | 'compatibility'
export type TargetImage = 'design' | 'screenshot'
/** 标注形状：框选 / 点位 / 箭头 / 文字 / 测量距离 / 吸色取样（旧数据无 shape 字段，默认按 rect 渲染） */
export type AnnotationShape = 'rect' | 'point' | 'arrow' | 'text' | 'measure' | 'picker'

/** 树状菜单/列表统一排序：手动 sortNo 优先（小值在前），未拖过的按创建时间 */
export const bySort = <T extends { sortNo?: number; createdAt: number }>(a: T, b: T) =>
  (a.sortNo ?? a.createdAt) - (b.sortNo ?? b.createdAt)

export interface Project {
  id: string
  name: string
  /** 适用端类型（可多选；旧数据为单选字符串，读取时用 platformList 归一化） */
  platform: Platform[]
  /** 项目 Logo 图片（本地相对路径），缺省用名称首字符占位 */
  logoPath?: string
  /** 无 Logo 时文字占位底色（用户自选），缺省按 id 散列取色 */
  logoColor?: string
  /** 侧边栏树状菜单手动排序值（拖拽生成，小值在前），缺省按创建时间 */
  sortNo?: number
  createdAt: number
  updatedAt: number
}

export interface Version {
  id: string
  projectId: string
  name: string
  /** 侧边栏树状菜单手动排序值（拖拽生成，小值在前），缺省按创建时间 */
  sortNo?: number
  createdAt: number
}

export interface WalkthroughPage {
  id: string
  versionId: string
  projectId: string
  pageName: string
  platform: Platform
  designImagePath: string
  screenshotPath: string
  /** 设计稿 Figma 链接（非必选），报告中可点击跳转 */
  figmaUrl?: string
  status: PageStatus
  /** 侧边栏树状菜单手动排序值（拖拽生成，小值在前），缺省按创建时间 */
  sortNo?: number
  createdAt: number
  /** 最后修改时间（重新上传图片/编辑信息时刷新），用于「最近访问」排序 */
  updatedAt?: number
}

/** 页面访问记录：用于「最近访问」页统计与分组展示 */
export interface Visit {
  id: string
  pageId: string
  projectId: string
  visitedAt: number
}

export interface Issue {
  id: string
  pageId: string
  targetImage: TargetImage
  /** 归一化坐标（0~1），标注框左上角与宽高 */
  x: number
  y: number
  width: number
  height: number
  description: string
  severity: Severity
  category: Category
  status: IssueStatus
  /** 标注形状，缺省视为 rect */
  shape?: AnnotationShape
  /** 自定义标注颜色（hex），缺省按严重度着色 */
  color?: string
  /** 测量标注的尺寸文案（如「128px」），创建时按图片原始尺寸计算，可直接修改 */
  measureValue?: string
  /** 吸色标注：设计稿取样色（hex） */
  sampleA?: string
  /** 吸色标注：开发截图取样色（hex），与 sampleA 组成双图对比 */
  sampleB?: string
  /** AI 候选标记 */
  isAISuggested?: boolean
  aiConfirmed?: boolean
  /** AI 结构化修复建议（现状 → 建议改法 → 涉及属性），采纳后随报告导出 */
  aiSuggestion?: { current: string; fix: string; properties?: string }
  /** 复验 */
  fixScreenshotPath?: string
  fixStatus?: 'passed' | 'failed'
  fixNote?: string
  /** 最近一次复验时间戳 */
  verifiedAt?: number
  /** 复验判定次数（通过/打回各计一次） */
  reverifyCount?: number
  createdAt: number
}

export function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

class WalkthroughDB extends Dexie {
  projects!: Table<Project, string>
  versions!: Table<Version, string>
  pages!: Table<WalkthroughPage, string>
  issues!: Table<Issue, string>
  visits!: Table<Visit, string>

  constructor() {
    super('walkthrough-db')
    this.version(1).stores({
      projects: 'id, name',
      versions: 'id, projectId',
      pages: 'id, versionId, projectId',
      issues: 'id, pageId, status, severity, category'
    })
    // v2：新增访问记录表（最近访问页统计/分组/清空）
    this.version(2).stores({
      visits: 'id, pageId, projectId, visitedAt'
    })
  }
}

export const db = new WalkthroughDB()

export const PLATFORM_LABELS: Record<Platform, string> = {
  h5: '移动端',
  pc: 'PC 端',
  dashboard: '可视化大屏',
  electron: 'Electron 桌面'
}

/** 项目端类型归一化：旧数据为单个字符串（单选），新数据为数组（多选） */
export function platformList(platform: Platform[] | Platform | undefined): Platform[] {
  if (!platform) return []
  return Array.isArray(platform) ? platform : [platform]
}

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  pending: '待修复',
  'in-progress': '修复中',
  fixed: '已修复',
  ignored: '已忽略',
  'design-confirmed': '设计确认不改'
}

export const SEVERITY_LABELS: Record<Severity, string> = {
  suggestion: '建议',
  minor: '一般',
  major: '严重'
}

export const CATEGORY_LABELS: Record<Category, string> = {
  spacing: '间距规范',
  typography: '文字排版',
  color: '颜色规范',
  style: '样式规范',
  interaction: '交互体验',
  compatibility: '兼容性问题'
}

export const SHAPE_LABELS: Record<AnnotationShape, string> = {
  point: '点位',
  arrow: '箭头',
  rect: '框选',
  text: '文字',
  measure: '测量',
  picker: '吸色'
}

/** 标注自定义颜色预设（value 为空 = 按严重度自动着色） */
export const ANNOTATION_COLORS: { value: string; label: string }[] = [
  { value: '', label: '按严重度' },
  { value: '#ef4444', label: '红色' },
  { value: '#f59e0b', label: '橙色' },
  { value: '#2563eb', label: '蓝色' },
  { value: '#16a34a', label: '绿色' },
  { value: '#9333ea', label: '紫色' },
  { value: '#ffffff', label: '白色' },
  { value: '#000000', label: '黑色' }
]

/**
 * 刷新页面的最后修改时间（标注/状态等变更时调用），
 * 「最近访问」页按 updatedAt 与访问时间的较大值实时排序。
 */
export async function touchPage(pageId: string): Promise<void> {
  try {
    await db.pages.update(pageId, { updatedAt: Date.now() })
  } catch {
    // 排序兜底字段，失败不阻塞主流程
  }
}

/** 旧分类枚举一次性迁移：字号 → 文字排版、缺失 → 样式规范 */
async function migrateCategories(): Promise<void> {
  try {
    await db.issues.where('category').equals('font-size').modify({ category: 'typography' })
    await db.issues.where('category').equals('missing').modify({ category: 'style' })
  } catch {
    // 迁移失败不阻塞主流程
  }
}
void migrateCategories()

/** 级联删除一组页面：先删本地图片文件（失败不阻塞），再删标注、页面记录 */
export async function deletePagesCascade(pageIds: string[]): Promise<void> {
  if (!pageIds.length) return
  const pages = await db.pages.bulkGet(pageIds)
  const issues = await db.issues.where('pageId').anyOf(pageIds).toArray()
  const imagePaths = [
    ...pages.flatMap((p) => (p ? [p.designImagePath, p.screenshotPath] : [])),
    ...issues.flatMap((i) => (i.fixScreenshotPath ? [i.fixScreenshotPath] : []))
  ]
  for (const imgPath of imagePaths) {
    if (imgPath) await window.electronAPI.deleteImage(imgPath).catch(() => undefined)
  }
  await db.transaction('rw', db.pages, db.issues, db.visits, async () => {
    await db.visits.where('pageId').anyOf(pageIds).delete()
    await db.issues.where('pageId').anyOf(pageIds).delete()
    await db.pages.bulkDelete(pageIds)
  })
}

/** 级联删除项目：其下全部版本、页面、问题记录与图片文件 */
export async function deleteProjectCascade(projectId: string): Promise<void> {
  const pages = await db.pages.where('projectId').equals(projectId).toArray()
  await deletePagesCascade(pages.map((p) => p.id))
  await db.transaction('rw', db.projects, db.versions, db.visits, async () => {
    await db.visits.where('projectId').equals(projectId).delete()
    await db.versions.where('projectId').equals(projectId).delete()
    await db.projects.delete(projectId)
  })
}

/**
 * 记录一次页面访问（用于「最近访问」页）。
 * 30 分钟内重复进入同一页面去重；全表仅保留最近 500 条。
 */
export async function recordVisit(pageId: string, projectId: string): Promise<void> {
  try {
    const cutoff = Date.now() - 30 * 60 * 1000
    const dup = await db.visits
      .where('pageId')
      .equals(pageId)
      .filter((v) => v.visitedAt > cutoff)
      .first()
    if (dup) return
    await db.visits.add({ id: genId(), pageId, projectId, visitedAt: Date.now() })
    const total = await db.visits.count()
    if (total > 500) {
      const stale = await db.visits.orderBy('visitedAt').limit(total - 500).toArray()
      await db.visits.bulkDelete(stale.map((v) => v.id))
    }
  } catch {
    // 访问记录失败不影响工作台主流程
  }
}
