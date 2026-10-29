import Dexie, { type Table } from 'dexie'
import type { IssueSource, ParsedToken, SpecDegradation, TokenType, TokenKind, TokenSource } from '../../../shared/types'
import { extractFigmaFileKey } from '../../../shared/figmaUrl'

export type Platform = 'h5' | 'pc' | 'dashboard' | 'electron'
export type PageStatus = 'pending' | 'reviewing' | 'completed'
export type IssueStatus = 'pending' | 'in-progress' | 'fixed' | 'ignored' | 'design-confirmed'
export type Severity = 'suggestion' | 'minor' | 'major'
export type Category =
  | 'spacing'
  | 'typography'
  | 'color'
  | 'style'
  | 'missing-component'
  | 'interaction'
  | 'compatibility'
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

/** 分组文件夹：项目内与页面并列展示，支持多层嵌套（parentId 缺省挂项目根级） */
export interface Folder {
  id: string
  projectId: string
  /** 父文件夹 id（缺省为项目根级） */
  parentId?: string
  name: string
  /** 文件夹 icon（预设 key，见 components/FolderIcon） */
  icon?: string
  /** 文件夹主题色（色值，用于 icon 着色） */
  color?: string
  /** 侧边栏树状菜单手动排序值（拖拽生成，小值在前），缺省按创建时间 */
  sortNo?: number
  createdAt: number
}

export interface WalkthroughPage {
  id: string
  /** 所属分组文件夹（可选，缺省直接挂在项目根级与文件夹并列展示） */
  folderId?: string
  projectId: string
  pageName: string
  platform: Platform
  designImagePath: string
  screenshotPath: string
  /** 设计稿 Figma 链接（非必选），报告中可点击跳转 */
  figmaUrl?: string
  /** 开发环境页面 URL（自动走查用，非必选） */
  devUrl?: string
  /** 自动走查独立双图：Figma 采集设计稿（与手动上传的设计稿隔离，不互相覆盖） */
  walkDesignPath?: string
  /** 自动走查独立双图：开发页面采集截图（与手动上传的开发截图隔离） */
  walkShotPath?: string
  status: PageStatus
  /** 侧边栏树状菜单手动排序值（拖拽生成，小值在前），缺省按创建时间 */
  sortNo?: number
  createdAt: number
  /** 最后修改时间（重新上传图片/编辑信息时刷新），用于「最近访问」排序 */
  updatedAt?: number
  /** 验收状态：导出报告页点击「验收通过」后置为 true，分析报告页状态列联动显示「已完成」 */
  accepted?: boolean
  acceptedAt?: number
}

/** 页面访问记录：用于「最近访问」页统计与分组展示 */
export interface Visit {
  id: string
  pageId: string
  projectId: string
  visitedAt: number
}

/** 导出历史记录（HTML 报告 / 飞书文档），为后续推送项目管理工具预留 */
export interface ReportRecord {
  id: string
  pageId: string
  projectId: string
  /** 导出类型：html 交互报告 / feishu 飞书文档 / tencent 腾讯文档 / kingsoft 金山文档 / dev 研发修改报告 */
  type: 'html' | 'feishu' | 'tencent' | 'kingsoft' | 'dev'
  name: string
  /** 飞书文档链接等可回访地址 */
  url?: string
  /** HTML 报告导出文件绝对路径（分析报告页打开用；旧记录无此字段） */
  filePath?: string
  /** 导出时的问题统计 */
  total: number
  createdAt: number
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
  /** 问题来源：结构化比对 / 图片视觉比对（AI）/ 手动标注（旧数据缺省视为手动） */
  source?: IssueSource
  /** 图集归属：walk=自动走查双图上的标注，manual=手动上传双图上的标注（缺省视为 manual，实现自动/手动结果隔离） */
  imgSet?: 'manual' | 'walk'
  /** 结构化比对回溯：设计稿 Figma 节点 ID */
  figmaNodeId?: string
  /** 结构化比对回溯：DOM 选择器路径 */
  domPath?: string
  /** 结构化比对回溯：匹配置信度 0~1 */
  matchConfidence?: number
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

/** ───────────── 设计规范空间（Dexie v6 五表） ───────────── */

/** 端分类（规范空间一级菜单）：预置 4 类映射 Platform，可改名不可删；自定义分类创建时强制选择映射端类型 */
export interface SpecCategory {
  id: string
  name: string
  /** 映射的页面端类型（走查取套依据：page.platform → platformKey） */
  platformKey: Platform
  /** 预置标记：1=预置（可改名不可删），0=自定义（可删） */
  builtin: 0 | 1
  sortNo?: number
  createdAt: number
}

/** 规范套：一个端分类下可建多套，走查项目按端分类各绑一套 */
export interface DesignSpec {
  id: string
  categoryId: string
  name: string
  /** Figma 规范链接（Token 提取以链接 API 解析为准） */
  figmaUrl?: string
  /** 解析出的 Figma file key（同步时回填） */
  figmaFileKey?: string
  /** Figma 文件名（同步时回填） */
  figFileName?: string
  /** .fig 上传存档路径（仅存档不解析） */
  figArchivePath?: string
  note?: string
  /** 最近同步时间 */
  lastSyncedAt?: number
  createdAt: number
  updatedAt: number
}

/** 同步历史版本：当前生效 = 最新版本；回滚 = 历史版本 Token 复制为新版本（追加式保留审计链） */
export interface SpecVersion {
  id: string
  specId: string
  /** 递增版本号 V1..Vn */
  no: number
  syncedAt: number
  sourceFileKey?: string
  tokenCount: number
  /** 变更摘要（新增/删除/修改 计数），同步完成 toast 与历史列表展示 */
  summary?: string
}

/** Token 行：value 为 SpecTokenValue（shared/types）的 JSON 序列化串 */
export interface SpecToken {
  id: string
  specId: string
  versionId: string
  kind: TokenKind
  /** Figma 原始变量名（最后一段用户命名，不自动改名），导出保留原名 */
  name: string
  /** 完整分组路径（变量集/文件夹层级，/ 分组，导出命名依据） */
  path: string
  /** JSON 序列化的 SpecTokenValue */
  value: string
  source: TokenSource
  /** Figma 变量描述 */
  description?: string
  /** Figma 原生 variable id（映射与回溯依据） */
  tokenId?: string
  /** Figma 完整原始变量名（含文件夹段），解析预览对照表左列 */
  figmaName?: string
  /** 所属模式（浅色/深色…），多模式每模式一行 */
  mode?: string
  /** 三层 Token 体系归属层（Primitive / Semantic / Component），单层体系缺省 */
  tier?: string
  /** 是否集合默认模式 */
  isDefaultMode?: boolean
  /** codeSyntax 自动生成代码别名（独立字段，不覆盖 name） */
  rawCode?: string
  /** 对外标准类型（kind 的用户口径映射） */
  type?: TokenType
  /** 别名引用链原始文本（{a.b.c} 去花括号原文 / 目标变量完整原始名），引用 Token 点击查看解析值 */
  aliasRef?: string
  /** 入库序号：保持 Figma 解析 / JSON 导入的原始分组与排序（查询后按此排序展示） */
  sortNo?: number
}

/** 项目↔规范绑定：一项目可绑多套（每端分类一套），走查按页面端类型自动取套 */
export interface ProjectSpecBinding {
  id: string
  projectId: string
  specId: string
  createdAt: number
}

/**
 * 规范 Token 映射：原始解析 token ↔ 目标标准 token 绑定关系。
 * 按项目+规范隔离持久化，切换项目/规范互不影响；sourceKey = `${tokenId ?? name}|${mode ?? ''}`。
 */
export interface SpecTokenMapping {
  id: string
  projectId: string
  specId: string
  /** 源 token 唯一键：`${tokenId ?? name}|${mode ?? ''}` */
  sourceKey: string
  /** 源 token 展示信息快照（映射表直接渲染，免联表） */
  sourceName: string
  sourcePath: string
  /** 目标标准 token 名称与分组路径 */
  targetName: string
  targetPath: string
  /** 已匹配 / 待确认 */
  status: 'matched' | 'pending'
  createdAt: number
  updatedAt: number
}

/** ───────────── AI 小助手对话（Dexie v8） ───────────── */

/** 助手消息携带的 @引用：type 决定注入的上下文对象，label 为引用气泡展示文案 */
export interface AssistantRef {
  type: 'project' | 'page' | 'report' | 'issue'
  /** 引用目标 id（项目/页面/报告/问题） */
  id: string
  label: string
}

/** AI 小助手对话消息：按项目/页面维度隔离持久化（pageId 空串 = 项目列表页的项目级会话） */
export interface AssistantMessage {
  id: string
  projectId: string
  pageId: string
  /** user=用户提问，assistant=AI 回复 */
  role: 'user' | 'assistant'
  content: string
  /** 用户消息携带的 @引用快照（assistant 消息无此字段） */
  refs?: AssistantRef[]
  createdAt: number
}

export function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** AI 标注候选（与 preload aiAnnotate 返回结构一致） */
export interface AIAnnotationCandidate {
  targetImage: TargetImage
  shape: AnnotationShape
  x: number
  y: number
  width: number
  height: number
  description: string
  severity: Severity
  category: Category
  suggestion?: { current: string; fix: string; properties?: string }
}

/** 离屏画布缓存：dataUrl → canvas（AI 结果换算测量 px / 吸色取样用，按 url 失效） */
const aiCanvasCache = new Map<string, HTMLCanvasElement>()

async function loadAiCanvas(dataUrl: string): Promise<HTMLCanvasElement | null> {
  const hit = aiCanvasCache.get(dataUrl)
  if (hit) return hit
  try {
    const img = new Image()
    img.src = dataUrl
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d', { willReadFrequently: true })?.drawImage(img, 0, 0)
    aiCanvasCache.set(dataUrl, canvas)
    return canvas
  } catch {
    return null
  }
}

/** 读取离屏画布上归一化坐标处的像素色（hex），失败返回 undefined */
function sampleAiHex(canvas: HTMLCanvasElement | null, nx: number, ny: number): string | undefined {
  if (!canvas || !canvas.width || !canvas.height) return undefined
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return undefined
  const px = Math.min(canvas.width - 1, Math.max(0, Math.round(nx * canvas.width)))
  const py = Math.min(canvas.height - 1, Math.max(0, Math.round(ny * canvas.height)))
  try {
    const d = ctx.getImageData(px, py, 1, 1).data
    return `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
  } catch {
    return undefined
  }
}

/** AI 标注候选 → Issue 行：
 *  measure 按所在图片原始尺寸换算 px 写入 measureValue；
 *  picker 在设计稿与开发截图同一坐标分别取样，写入 sampleA/sampleB 双色对比 */
export async function aiAnnotationsToIssues(
  pageId: string,
  annotations: AIAnnotationCandidate[],
  designDataUrl: string,
  shotDataUrl: string,
  opts: { imgSet?: 'manual' | 'walk'; startAt?: number } = {}
): Promise<Issue[]> {
  const [designCanvas, shotCanvas] = await Promise.all([loadAiCanvas(designDataUrl), loadAiCanvas(shotDataUrl)])
  const startAt = opts.startAt ?? Date.now()
  return annotations.map((a, idx) => {
    const own = a.targetImage === 'design' ? designCanvas : shotCanvas
    const row: Issue = {
      id: genId(),
      pageId,
      targetImage: a.targetImage,
      x: a.x,
      y: a.y,
      width: a.shape === 'picker' ? 0 : a.width,
      height: a.shape === 'picker' ? 0 : a.height,
      shape: a.shape ?? 'rect',
      description: a.description,
      severity: a.severity,
      category: a.category,
      status: 'pending',
      source: 'visual',
      ...(opts.imgSet ? { imgSet: opts.imgSet } : {}),
      isAISuggested: true,
      aiConfirmed: false,
      aiSuggestion: a.suggestion,
      createdAt: startAt + idx
    }
    if (a.shape === 'measure' && own) {
      row.measureValue = `${Math.round(Math.hypot(a.width * own.width, a.height * own.height))}px`
    }
    if (a.shape === 'picker') {
      row.sampleA = sampleAiHex(designCanvas, a.x, a.y)
      row.sampleB = sampleAiHex(shotCanvas, a.x, a.y)
    }
    return row
  })
}

class WalkthroughDB extends Dexie {
  projects!: Table<Project, string>
  folders!: Table<Folder, string>
  pages!: Table<WalkthroughPage, string>
  issues!: Table<Issue, string>
  visits!: Table<Visit, string>
  reportRecords!: Table<ReportRecord, string>
  specCategories!: Table<SpecCategory, string>
  designSpecs!: Table<DesignSpec, string>
  specVersions!: Table<SpecVersion, string>
  specTokens!: Table<SpecToken, string>
  projectSpecBindings!: Table<ProjectSpecBinding, string>
  specTokenMappings!: Table<SpecTokenMapping, string>
  assistantMessages!: Table<AssistantMessage, string>

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
    // v3：自动走查——导出历史表（页面 devUrl 与 Issue source 等为非索引字段，无需建索引）
    this.version(3).stores({
      reportRecords: 'id, pageId, projectId, createdAt'
    })
    // v4：取消版本管理，改为「分组文件夹 + 页面」并列结构；
    // 旧 versions 数据原样迁移为同名文件夹（保留 id/sortNo，侧边栏拖拽排序不丢），
    // 页面 versionId → folderId（未分组页面缺省挂项目根级）。
    this.version(4)
      .stores({
        versions: null, // 删除旧版本表
        folders: 'id, projectId',
        pages: 'id, folderId, projectId'
      })
      .upgrade(async (trans) => {
        const oldVersions = await trans.table('versions').toArray()
        if (oldVersions.length) {
          await trans
            .table('folders')
            .bulkPut(
              oldVersions.map((v: Record<string, unknown>) => ({
                id: v.id,
                projectId: v.projectId,
                name: v.name,
                sortNo: v.sortNo,
                createdAt: v.createdAt
              }))
            )
        }
        await trans.table('pages').toCollection().modify((pg: Record<string, unknown>) => {
          pg.folderId = pg.versionId
          delete pg.versionId
        })
      })
    // v5：文件夹支持多层嵌套——folders 增加 parentId 索引（数据无需迁移，缺省即根级）
    this.version(5).stores({
      folders: 'id, projectId, parentId'
    })
    // v6：设计规范空间——端分类/规范套/同步历史/Token/项目绑定 五表（纯新增无迁移）；
    // Dexie 要求每个 version 声明全部存在的表，未声明的表会被删除，故此处完整列出
    // projectSpecBindings 带 [projectId+specId] 复合索引，绑定唯一性在应用层保证
    this.version(6).stores({
      projects: 'id, name',
      folders: 'id, projectId, parentId',
      pages: 'id, folderId, projectId',
      issues: 'id, pageId, status, severity, category',
      visits: 'id, pageId, projectId, visitedAt',
      reportRecords: 'id, pageId, projectId, createdAt',
      specCategories: 'id, platformKey',
      designSpecs: 'id, categoryId',
      specVersions: 'id, specId',
      specTokens: 'id, specId, versionId, kind',
      projectSpecBindings: 'id, projectId, specId, [projectId+specId]'
    })
    // v7：规范 Token 映射表（项目+规范隔离持久化；SpecToken 扩展字段为非索引列无需迁移）；
    // Dexie 要求每个 version 声明全部存在的表，未声明的表会被删除，故此处完整列出
    this.version(7).stores({
      projects: 'id, name',
      folders: 'id, projectId, parentId',
      pages: 'id, folderId, projectId',
      issues: 'id, pageId, status, severity, category',
      visits: 'id, pageId, projectId, visitedAt',
      reportRecords: 'id, pageId, projectId, createdAt',
      specCategories: 'id, platformKey',
      designSpecs: 'id, categoryId',
      specVersions: 'id, specId',
      specTokens: 'id, specId, versionId, kind',
      projectSpecBindings: 'id, projectId, specId, [projectId+specId]',
      specTokenMappings: 'id, projectId, specId, [projectId+specId]'
    })
    // v8：AI 小助手对话表（按项目/页面维度隔离持久化，pageId 空串 = 项目级会话；纯新增无迁移）；
    // Dexie 要求每个 version 声明全部存在的表，未声明的表会被删除，故此处完整列出
    this.version(8).stores({
      projects: 'id, name',
      folders: 'id, projectId, parentId',
      pages: 'id, folderId, projectId',
      issues: 'id, pageId, status, severity, category',
      visits: 'id, pageId, projectId, visitedAt',
      reportRecords: 'id, pageId, projectId, createdAt',
      specCategories: 'id, platformKey',
      designSpecs: 'id, categoryId',
      specVersions: 'id, specId',
      specTokens: 'id, specId, versionId, kind',
      projectSpecBindings: 'id, projectId, specId, [projectId+specId]',
      specTokenMappings: 'id, projectId, specId, [projectId+specId]',
      assistantMessages: 'id, projectId, pageId, createdAt, [projectId+pageId]'
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
  'missing-component': '组件缺失',
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

/** 预置端分类（platformKey → 默认名，与 PLATFORM_LABELS 一致；界面展示时 builtin 分类走 i18n label） */
const BUILTIN_SPEC_CATEGORIES: { name: string; platformKey: Platform }[] = [
  { name: '移动端', platformKey: 'h5' },
  { name: 'PC 端', platformKey: 'pc' },
  { name: '可视化大屏', platformKey: 'dashboard' },
  { name: 'Electron 桌面', platformKey: 'electron' }
]

/** 预置端分类初始化（幂等）：按 platformKey 缺失即补建，供规范空间一级菜单使用 */
export async function ensureSpecCategories(): Promise<void> {
  try {
    const existing = await db.specCategories.toArray()
    const keys = new Set(existing.map((c) => c.platformKey))
    const missing = BUILTIN_SPEC_CATEGORIES.filter((p) => !keys.has(p.platformKey))
    if (missing.length) {
      const base = Date.now()
      await db.specCategories.bulkAdd(
        missing.map((p, i) => ({
          id: genId(),
          name: p.name,
          platformKey: p.platformKey,
          builtin: 1 as const,
          sortNo: existing.length + i,
          createdAt: base + i
        }))
      )
    }
  } catch {
    // 初始化失败不阻塞主流程（进入规范空间时会再次尝试）
  }
}
void ensureSpecCategories()

/** 级联删除一组页面：先删本地图片文件（失败不阻塞），再删标注、页面记录 */
export async function deletePagesCascade(pageIds: string[]): Promise<void> {
  if (!pageIds.length) return
  const pages = await db.pages.bulkGet(pageIds)
  const issues = await db.issues.where('pageId').anyOf(pageIds).toArray()
  const imagePaths = [
    ...pages.flatMap((p) =>
      p ? [p.designImagePath, p.screenshotPath, p.walkDesignPath, p.walkShotPath] : []
    ),
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

/** 级联删除项目：其下全部文件夹、页面、问题记录与图片文件，以及规范绑定关系与 Token 映射 */
export async function deleteProjectCascade(projectId: string): Promise<void> {
  const pages = await db.pages.where('projectId').equals(projectId).toArray()
  await deletePagesCascade(pages.map((p) => p.id))
  await db.transaction('rw', db.projects, db.folders, db.visits, db.projectSpecBindings, db.specTokenMappings, async () => {
    await db.visits.where('projectId').equals(projectId).delete()
    await db.folders.where('projectId').equals(projectId).delete()
    await db.projectSpecBindings.where('projectId').equals(projectId).delete()
    await db.specTokenMappings.where('projectId').equals(projectId).delete()
    await db.projects.delete(projectId)
  })
}

/**
 * 级联删除分组文件夹：递归收集全部子孙文件夹，
 * 先删各层文件夹内页面（含标注与图片），再删所有文件夹记录。
 */
export async function deleteFolderCascade(folderId: string): Promise<void> {
  // BFS 收集子孙文件夹（防环：访问集去重）
  const allIds: string[] = []
  const seen = new Set<string>([folderId])
  let frontier = [folderId]
  while (frontier.length) {
    allIds.push(...frontier)
    const children = await db.folders
      .where('parentId')
      .anyOf(frontier)
      .filter((f) => !seen.has(f.id))
      .toArray()
    frontier = children.map((f) => f.id)
    frontier.forEach((id) => seen.add(id))
  }
  const pages = await db.pages.where('folderId').anyOf(allIds).toArray()
  await deletePagesCascade(pages.map((p) => p.id))
  await db.folders.bulkDelete(allIds)
}

/** 级联删除一套规范：绑定关系、全部历史版本的 Token、Token 映射、版本记录与规范行（.fig 存档文件保留不动） */
export async function deleteSpecCascade(specId: string): Promise<void> {
  await db.transaction(
    'rw',
    db.designSpecs,
    db.specVersions,
    db.specTokens,
    db.projectSpecBindings,
    db.specTokenMappings,
    async () => {
      await db.projectSpecBindings.where('specId').equals(specId).delete()
      await db.specTokens.where('specId').equals(specId).delete()
      await db.specVersions.where('specId').equals(specId).delete()
      await db.specTokenMappings.where('specId').equals(specId).delete()
      await db.designSpecs.delete(specId)
    }
  )
}

/** 级联删除端分类：其下全部规范套连带删除（预置分类在 UI 层禁删，此处不做拦截） */
export async function deleteSpecCategoryCascade(categoryId: string): Promise<void> {
  const specs = await db.designSpecs.where('categoryId').equals(categoryId).toArray()
  for (const s of specs) await deleteSpecCascade(s.id)
  await db.specCategories.delete(categoryId)
}

/** 从本地配置读取 Figma PAT：MCP 管理第一个启用且填了 pat 的服务，回退 legacy figmaMcp.pat */
export async function getFigmaPat(): Promise<string> {
  try {
    const cfg = await window.electronAPI.getConfig()
    const mcps = (cfg.mcps as { pat?: string; enabled?: boolean }[] | undefined) ?? []
    const hit = mcps.find((m) => m.enabled !== false && m.pat && m.pat.trim())
    if (hit) return hit.pat!.trim()
    const legacy = cfg.figmaMcp as { pat?: string } | undefined
    return legacy?.pat?.trim() ?? ''
  } catch {
    return ''
  }
}

/** 某规范当前最新版本行（no 最大；无版本返回 undefined） */
export async function latestSpecVersion(specId: string): Promise<SpecVersion | undefined> {
  const versions = await db.specVersions.where('specId').equals(specId).toArray()
  return versions.sort((a, b) => b.no - a.no)[0]
}

/** 同步结果（含变更摘要，供 toast 与历史列表展示） */
export interface SpecSyncOutcome {
  versionId: string
  versionNo: number
  tokenCount: number
  sourceLevel: string
  fileName?: string
  summary: string
  /** 降级明细（如 variable 级失败原因 + 处理建议） */
  degraded?: SpecDegradation[]
  /** 变量级 403（PAT 无变量读取权限）：未入库，待用户选择是否改同步样式 */
  variableDenied?: boolean
}

/** 导入模式：replace=删除原数据重导为 V1；merge=与最新版本按 kind+name+mode 去重叠加后存新版本 */
export type SpecImportMode = 'replace' | 'merge'

/** 版本 diff 键：kind + name + mode（多模式展开后同名 token 靠 mode 区分） */
const specDiffKey = (t: { kind: string; name: string; mode?: string }) =>
  `${t.kind}|${t.name}|${t.mode ?? ''}`

interface AppendSpecVersionOpts {
  /** 摘要前缀标签（如「JSON 导入」） */
  label?: string
  sourceLevel: string
  fileName?: string
  /** 是否回写规范的 Figma 文件元信息（JSON 导入不回写） */
  touchFileName: boolean
  /** 导入模式（有历史版本时由用户选择；缺省按叠加处理） */
  mode?: SpecImportMode
}

/** 追加新版本 + 全量重写该版本 Token（Figma 同步与 JSON 导入共用；支持清空重导/去重叠加两种模式） */
async function appendSpecVersion(
  spec: DesignSpec,
  tokens: ParsedToken[],
  opts: AppendSpecVersionOpts
): Promise<SpecSyncOutcome> {
  // 清空重导：先删除该规范全部版本与 Token（历史一并移除），之后按 V1 重新入库
  if (opts.mode === 'replace') {
    await db.transaction('rw', db.specVersions, db.specTokens, async () => {
      await db.specTokens.where('specId').equals(spec.id).delete()
      await db.specVersions.where('specId').equals(spec.id).delete()
    })
  }
  const prev = await latestSpecVersion(spec.id)
  let effective = tokens
  // 去重叠加：最新版本 Token 为底，同 kind+name+mode 键新值覆盖，旧有新无保留
  if (opts.mode === 'merge' && prev) {
    // 旧 Token 先按 sortNo 归位（保持原 JSON/Figma 顺序），新增 Token 依序追加在尾部
    const prevRows = (await db.specTokens.where('versionId').equals(prev.id).toArray()).sort(
      (a, b) => (a.sortNo ?? 0) - (b.sortNo ?? 0)
    )
    const map = new Map<string, ParsedToken>()
    for (const r of prevRows) {
      map.set(specDiffKey(r), {
        kind: r.kind,
        name: r.name,
        path: r.path,
        value: JSON.parse(r.value) as ParsedToken['value'],
        source: r.source,
        description: r.description,
        tokenId: r.tokenId,
        figmaName: r.figmaName,
        mode: r.mode,
        tier: r.tier,
        isDefaultMode: r.isDefaultMode,
        rawCode: r.rawCode,
        aliasRef: r.aliasRef,
        type: r.type
      })
    }
    for (const t of tokens) map.set(specDiffKey(t), t)
    effective = [...map.values()]
  }
  const prevTokens = prev
    ? (await db.specTokens.where('versionId').equals(prev.id).toArray()).map(specDiffKey)
    : []
  const nextKeys = effective.map(specDiffKey)
  const prevSet = new Set(prevTokens)
  const nextSet = new Set(nextKeys)
  const added = nextKeys.filter((k) => !prevSet.has(k)).length
  const removed = prevTokens.filter((k) => !nextSet.has(k)).length
  const kept = nextKeys.length - added
  const changed = Math.min(prevTokens.length - removed, kept)
  const parts: string[] = []
  if (added) parts.push(`新增 ${added}`)
  if (removed) parts.push(`删除 ${removed}`)
  if (changed) parts.push(`更新 ${changed}`)
  if (!parts.length) parts.push('无变更')
  const summary = opts.label ? `${opts.label} · ${parts.join(' · ')}` : parts.join(' · ')

  const now = Date.now()
  const versionId = genId()
  const versionNo = (prev?.no ?? 0) + 1
  const fileKey = opts.touchFileName ? (extractFigmaFileKey(spec.figmaUrl ?? '') ?? undefined) : undefined
  await db.transaction('rw', db.specVersions, db.specTokens, db.designSpecs, async () => {
    await db.specVersions.add({
      id: versionId,
      specId: spec.id,
      no: versionNo,
      syncedAt: now,
      sourceFileKey: fileKey,
      tokenCount: effective.length,
      summary
    })
    await db.specTokens.bulkAdd(
      effective.map((t, i) => ({
        id: genId(),
        specId: spec.id,
        versionId,
        kind: t.kind,
        name: t.name,
        path: t.path,
        value: JSON.stringify(t.value),
        source: t.source,
        description: t.description,
        tokenId: t.tokenId,
        figmaName: t.figmaName,
        mode: t.mode,
        tier: t.tier,
        isDefaultMode: t.isDefaultMode,
        rawCode: t.rawCode,
        aliasRef: t.aliasRef,
        type: t.type,
        // 解析顺序即 JSON/Figma 原始顺序（分组按首次出现、变量按文件内顺序）
        sortNo: i
      }))
    )
    await db.designSpecs.update(
      spec.id,
      opts.touchFileName
        ? {
            figFileName: opts.fileName || spec.figFileName,
            figmaFileKey: fileKey,
            lastSyncedAt: now,
            updatedAt: now
          }
        : { lastSyncedAt: now }
    )
  })
  return {
    versionId,
    versionNo,
    tokenCount: effective.length,
    sourceLevel: opts.sourceLevel,
    fileName: opts.touchFileName ? opts.fileName : undefined,
    summary
  }
}

/** 同步选项：导入模式（清空重导/去重叠加）与起始解析级别（变量无权限时跳过变量级） */
export interface SpecSyncOptions {
  mode?: SpecImportMode
  startLevel?: 'variable' | 'style'
}

/**
 * 一键同步：调主进程三级解析 → 追加新版本 + 全量重写该版本 Token → 更新规范同步元信息。
 * 摘要与上一版本按「kind+name+mode」对比：新增/删除/修改 计数。
 * 变量级 403（无变量读取权限）时中断未入库，返回 variableDenied 交由上层询问用户。
 */
export async function syncSpecFromFigma(spec: DesignSpec, opts?: SpecSyncOptions): Promise<SpecSyncOutcome> {
  const pat = await getFigmaPat()
  if (!pat) throw new Error('未配置 Figma Token，请先在「设置 → MCP 管理」中填写 PAT')
  if (!spec.figmaUrl) throw new Error('该规范未填写 Figma 规范链接')
  const res = await window.electronAPI.specSyncTokens({
    pat,
    figmaUrl: spec.figmaUrl,
    startLevel: opts?.startLevel
  })
  if (res.variableDenied) {
    return {
      versionId: '',
      versionNo: 0,
      tokenCount: 0,
      sourceLevel: 'variable',
      summary: '',
      variableDenied: true,
      degraded: res.degraded
    }
  }
  const tokens = res.tokens ?? []
  if (!tokens.length) throw new Error('解析完成但未提取到任何 Token')
  const outcome = await appendSpecVersion(spec, tokens, {
    sourceLevel: res.sourceLevel ?? '',
    fileName: res.fileName,
    touchFileName: true,
    mode: opts?.mode
  })
  return { ...outcome, degraded: res.degraded }
}

/** JSON 导入：Figma REST 同构 / Tokens Studio / W3C DTCG JSON → 按所选模式入库新版本 */
export async function importSpecTokensFromJson(
  spec: DesignSpec,
  tokens: ParsedToken[],
  opts?: { mode?: SpecImportMode }
): Promise<SpecSyncOutcome> {
  if (!tokens.length) throw new Error('导入文件中未解析到任何 Token')
  return appendSpecVersion(spec, tokens, {
    label: 'JSON 导入',
    sourceLevel: 'variable',
    touchFileName: false,
    mode: opts?.mode
  })
}

// ==================== 规范 Token 映射（按项目隔离持久化） ====================

/** 列出某项目下某规范的映射表 */
export async function listSpecTokenMappings(projectId: string, specId: string): Promise<SpecTokenMapping[]> {
  return db.specTokenMappings.where('[projectId+specId]').equals([projectId, specId]).toArray()
}

/** 新增或更新映射（按 sourceKey 幂等：同 sourceKey 仅一条，重复保存视为修改） */
export async function upsertSpecTokenMapping(
  input: Omit<SpecTokenMapping, 'id' | 'createdAt' | 'updatedAt'>
): Promise<SpecTokenMapping> {
  const now = Date.now()
  const existing = await db.specTokenMappings
    .where('[projectId+specId]')
    .equals([input.projectId, input.specId])
    .filter((m) => m.sourceKey === input.sourceKey)
    .first()
  if (existing) {
    const updated: SpecTokenMapping = { ...existing, ...input, updatedAt: now }
    await db.specTokenMappings.put(updated)
    return updated
  }
  const record: SpecTokenMapping = { ...input, id: genId(), createdAt: now, updatedAt: now }
  await db.specTokenMappings.add(record)
  return record
}

/** 删除单条映射 */
export async function deleteSpecTokenMapping(id: string): Promise<void> {
  await db.specTokenMappings.delete(id)
}

/** 清空某项目下某规范的映射表 */
export async function clearSpecTokenMappings(projectId: string, specId: string): Promise<void> {
  await db.specTokenMappings.where('[projectId+specId]').equals([projectId, specId]).delete()
}

/** 回滚：历史版本 Token 复制为新版本（追加式保留审计链，当前生效切到新版本） */
export async function rollbackSpecVersion(specId: string, versionId: string): Promise<SpecSyncOutcome> {
  const [target, tokens] = await Promise.all([
    db.specVersions.get(versionId),
    db.specTokens.where('versionId').equals(versionId).toArray()
  ])
  if (!target || target.specId !== specId) throw new Error('版本不存在')
  const latest = await latestSpecVersion(specId)
  if (latest?.id === versionId) throw new Error('该版本已是当前生效版本')
  const now = Date.now()
  const newId = genId()
  const summary = `回滚自 V${target.no}`
  await db.transaction('rw', db.specVersions, db.specTokens, db.designSpecs, async () => {
    await db.specVersions.add({
      id: newId,
      specId,
      no: (latest?.no ?? 0) + 1,
      syncedAt: now,
      sourceFileKey: target.sourceFileKey,
      tokenCount: tokens.length,
      summary
    })
    await db.specTokens.bulkAdd(
      tokens.map((t) => ({ ...t, id: genId(), versionId: newId }))
    )
    await db.designSpecs.update(specId, { lastSyncedAt: now })
  })
  return {
    versionId: newId,
    versionNo: (latest?.no ?? 0) + 1,
    tokenCount: tokens.length,
    sourceLevel: '',
    summary
  }
}

/** 删除历史版本（连同该版本全部 Token 一并移除，不可恢复；当前生效版本不可删） */
export async function deleteSpecVersion(specId: string, versionId: string): Promise<void> {
  const target = await db.specVersions.get(versionId)
  if (!target || target.specId !== specId) throw new Error('版本不存在')
  const latest = await latestSpecVersion(specId)
  if (latest?.id === versionId) throw new Error('当前生效版本不可删除')
  await db.transaction('rw', db.specVersions, db.specTokens, async () => {
    await db.specVersions.delete(versionId)
    await db.specTokens.where('versionId').equals(versionId).delete()
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
