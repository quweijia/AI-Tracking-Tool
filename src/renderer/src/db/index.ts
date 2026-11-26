import Dexie, { type Table } from 'dexie'
import type { IssueLevel, IssueSource, ParsedToken, SpecDegradation, TokenType, TokenKind, TokenSource } from '../../../shared/types'
import { extractFigmaFileKey } from '../../../shared/figmaUrl'

export type Platform = 'h5' | 'pc' | 'dashboard' | 'electron'
export type PageStatus = 'pending' | 'reviewing' | 'completed'
export type IssueStatus = 'pending' | 'in-progress' | 'fixed' | 'ignored' | 'design-confirmed'
export type Severity = 'suggestion' | 'minor' | 'major'
export type Category =
  | 'prototype'
  | 'spacing'
  | 'typography'
  | 'color'
  | 'style'
  | 'missing-component'
  | 'interaction'
  | 'compatibility'
/** 分类「未选择」哨兵（空串）：仅创建/编辑弹窗内表示待手动选择，保存前必须选择，不会以此值落库 */
export const CATEGORY_UNSET = '' as unknown as Category
export type TargetImage = 'design' | 'screenshot'
/** 标注形状：框选 / 点位 / 箭头 / 文字 / 测量距离 / 吸色取样（旧数据无 shape 字段，默认按 rect 渲染） */
export type AnnotationShape = 'rect' | 'point' | 'arrow' | 'text' | 'measure' | 'picker'

/** 树状菜单/列表统一排序：手动 sortNo 优先（小值在前），未拖过的按创建时间 */
export const bySort = <T extends { sortNo?: number; createdAt: number }>(a: T, b: T) =>
  (a.sortNo ?? a.createdAt) - (b.sortNo ?? b.createdAt)

/** 回收站所属模式：走查 / 产品标注（两库天然隔离，标记用于还原时校验，防跨模式还原） */
export type TrashMode = 'walk' | 'product'

/**
 * 软删除（回收站）公共字段：可选非索引字段，仅打标记隐藏，记录与磁盘文件保留。
 * 旧数据无这些字段时按「未删除」处理，读取处统一以 `!deletedAt` 过滤，不做迁移、不报错。
 */
export interface SoftDeleteFields {
  /** 软删除时间戳；缺省/null = 未删除 */
  deletedAt?: number | null
  /** 删除前的父级 id（文件夹用 parentId，页面/标注集用 folderId；项目无父级恒为 null） */
  originalParentId?: string | null
  /** 删除前在父级内的排序位置（sortNo），还原时插回原位 */
  restoreOrder?: number | null
  /** 记录所属模式，防止跨模式还原 */
  deletedInMode?: TrashMode
}

export interface Project extends SoftDeleteFields {
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
export interface Folder extends SoftDeleteFields {
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

export interface WalkthroughPage extends SoftDeleteFields {
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
  /** 走查设计稿是否为手动上传（Figma 网络受限/未配置时跳过 Figma 拉取，采集尺寸取上传图原始尺寸） */
  walkDesignManual?: boolean
  /** 手动上传设计稿的采集视口宽度（弹性布局页面元素宽度随窗口宽变化，与上传图像素宽不一致时
   *  手动指定实际浏览窗口内容宽度；缺省按上传图原始像素宽采集） */
  walkViewportWidth?: number
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

/** 导出历史记录（HTML 报告 / 飞书文档），为后续推送项目管理工具预留。
 *  支持软删进回收站：走查/产品导出页删除记录仅打标记隐藏，保留期内可还原 */
export interface ReportRecord extends SoftDeleteFields {
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

/** 标注截图附件：原图落盘 userData/attachments/<pageId>/，库内仅存相对路径 + 列表缩略图（不进 IndexedDB 大字段） */
export interface IssueAttachment {
  id: string
  /** 来源：本地上传 / 截图采集（阶段2）/ 剪贴板粘贴 */
  source: 'local' | 'capture' | 'clipboard'
  /** 展示用文件名（重名时 UI 追加序号，不参与落盘命名） */
  fileName: string
  /** 相对 walkthrough-data 根的原图路径（复用 file:readImage 解析） */
  relPath: string
  width: number
  height: number
  /** 原图字节数（上传/落盘时校验与展示） */
  size: number
  /** 列表缩略图（canvas 生成 webp，最长边 240px），详情预览走原图 */
  thumbDataUrl: string
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
  /** 问题分级（仅自动走查写入）：required=必标（默认生成画布标注）；optional=备选参考（默认不标注，勾选后生效）。缺省视为 required，兼容历史数据 */
  level?: IssueLevel
  /** 分级判定理由（AI 给出或兜底规则生成） */
  levelReason?: string
  /** 备选问题是否已被用户勾选加入标注（勾选后画布生成标注，随导出开关进报告） */
  optionalChecked?: boolean
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
  /** 截图附件（可选，向后兼容：旧数据无此字段按空列表处理） */
  attachments?: IssueAttachment[]
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
  /** JSON 导入的源文件名列表（详情页本地源文件展示用） */
  jsonSourceNames?: string[]
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
  /** assistant 消息的思考过程（模型 reasoning 输出，无则缺省） */
  reasoning?: string
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
  /** 问题分级（走查侧兜底判定后注入；手动 AI 识别不分级不携带） */
  level?: IssueLevel
  /** 分级判定理由 */
  levelReason?: string
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
      // 问题分级仅自动走查链路注入（候选携带 level 才透传），手动 AI 识别不分级
      ...(a.level ? { level: a.level, levelReason: a.levelReason } : {}),
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
    // v9：导出报告软删进回收站——reportRecords 增加 deletedAt 索引（其余扩展字段为非索引列无需迁移）；
    // Dexie 要求每个 version 声明全部存在的表，未声明的表会被删除，故此处完整列出
    this.version(9).stores({
      projects: 'id, name',
      folders: 'id, projectId, parentId',
      pages: 'id, folderId, projectId',
      issues: 'id, pageId, status, severity, category',
      visits: 'id, pageId, projectId, visitedAt',
      reportRecords: 'id, pageId, projectId, createdAt, deletedAt',
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
  prototype: '原型说明',
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
    ...issues.flatMap((i) => (i.fixScreenshotPath ? [i.fixScreenshotPath] : [])),
    // 截图附件原图同步清理（旧数据无 attachments 字段按空列表处理）
    ...issues.flatMap((i) => (i.attachments ?? []).map((a) => a.relPath))
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

/** 删除问题记录并同步清理其截图附件原图（文件失败不阻塞记录删除）；支持单条或批量 */
export async function deleteIssuesCascade(issues: Issue[]): Promise<void> {
  if (!issues.length) return
  const paths = issues.flatMap((i) => (i.attachments ?? []).map((a) => a.relPath))
  for (const p of paths) await window.electronAPI.deleteImage(p).catch(() => undefined)
  await db.issues.bulkDelete(issues.map((i) => i.id))
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

/** ───────────── 软删除（回收站）：仅打标记隐藏，记录、标注与磁盘文件一律保留 ───────────── */

/**
 * 项目软删除（级联）：项目本体与其下全部文件夹（含子孙）、页面打同一批 deletedAt 标记；
 * 磁盘图片、标注、访问记录一律不动，彻底删除时才走既有 deleteProjectCascade。
 * 幂等：已是软删状态（deletedAt 非空）的记录保持原标记不覆盖。
 */
export async function softDeleteProjects(projectIds: string[], now?: number): Promise<void> {
  if (!projectIds.length) return
  const ts = now ?? Date.now()
  const mark = { deletedAt: ts, originalParentId: null, deletedInMode: 'walk' as const }
  const projects = (await db.projects.bulkGet(projectIds)).filter(
    (p): p is Project => !!p && !p.deletedAt
  )
  await db.projects.bulkPut(
    projects.map((p) => ({ ...p, ...mark, restoreOrder: p.sortNo ?? null }))
  )
  const folders = (await db.folders.where('projectId').anyOf(projectIds).toArray()).filter(
    (f) => !f.deletedAt
  )
  if (folders.length) {
    await db.folders.bulkPut(
      folders.map((f) => ({
        ...f,
        deletedAt: ts,
        originalParentId: f.parentId ?? null,
        restoreOrder: f.sortNo ?? null,
        deletedInMode: 'walk' as const
      }))
    )
  }
  const pages = (await db.pages.where('projectId').anyOf(projectIds).toArray()).filter(
    (p) => !p.deletedAt
  )
  if (pages.length) {
    await db.pages.bulkPut(
      pages.map((p) => ({
        ...p,
        deletedAt: ts,
        originalParentId: p.folderId ?? null,
        restoreOrder: p.sortNo ?? null,
        deletedInMode: 'walk' as const
      }))
    )
  }
}

/**
 * 文件夹软删除（级联）：BFS 收集全部子孙文件夹（防环，与 deleteFolderCascade 同口径），
 * 连同各层文件夹内页面打同一批 deletedAt 标记；标注、磁盘文件不动。幂等：跳过已软删记录。
 */
export async function softDeleteFolders(folderIds: string[], now?: number): Promise<void> {
  if (!folderIds.length) return
  const ts = now ?? Date.now()
  const allIds: string[] = []
  const seen = new Set<string>(folderIds)
  let frontier = [...folderIds]
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
  const folders = (await db.folders.bulkGet(allIds)).filter((f): f is Folder => !!f && !f.deletedAt)
  if (folders.length) {
    await db.folders.bulkPut(
      folders.map((f) => ({
        ...f,
        deletedAt: ts,
        originalParentId: f.parentId ?? null,
        restoreOrder: f.sortNo ?? null,
        deletedInMode: 'walk' as const
      }))
    )
  }
  const pages = (await db.pages.where('folderId').anyOf(allIds).toArray()).filter(
    (p) => !p.deletedAt
  )
  if (pages.length) {
    await db.pages.bulkPut(
      pages.map((p) => ({
        ...p,
        deletedAt: ts,
        originalParentId: p.folderId ?? null,
        restoreOrder: p.sortNo ?? null,
        deletedInMode: 'walk' as const
      }))
    )
  }
}

/** 页面软删除：仅打标记（不动标注/issues/visits 与磁盘图片）。幂等：跳过已软删记录。 */
export async function softDeletePages(pageIds: string[], now?: number): Promise<void> {
  if (!pageIds.length) return
  const pages = (await db.pages.bulkGet(pageIds)).filter(
    (p): p is WalkthroughPage => !!p && !p.deletedAt
  )
  if (!pages.length) return
  const ts = now ?? Date.now()
  await db.pages.bulkPut(
    pages.map((p) => ({
      ...p,
      deletedAt: ts,
      originalParentId: p.folderId ?? null,
      restoreOrder: p.sortNo ?? null,
      deletedInMode: 'walk' as const
    }))
  )
}

/**
 * 报告软删除（回收站）：仅打标记隐藏，HTML 文件保留在磁盘、云文档链接不动，保留期内可还原。
 * 产品导出与走查导出共用 reportRecords 表，按 mode 标记所属模式（防止跨模式还原）。
 * 幂等：跳过已软删记录。
 */
export async function softDeleteReports(ids: string[], mode: TrashMode, now?: number): Promise<void> {
  if (!ids.length) return
  const rows = (await db.reportRecords.bulkGet(ids)).filter(
    (r): r is ReportRecord => !!r && !r.deletedAt
  )
  if (!rows.length) return
  const ts = now ?? Date.now()
  await db.reportRecords.bulkPut(rows.map((r) => ({ ...r, deletedAt: ts, deletedInMode: mode })))
}

/** ───────────── 回收站（阶段 2）：读取 / 还原 / 彻底删除 ───────────── */

/** 回收站保留天数：阶段 3 起可配置（config.trashRetentionDays），读取见 db/trashCleanup.ts；
 *  此处不再导出常量，避免各处硬编码 30 天 */

export type TrashKind = 'project' | 'folder' | 'page' | 'report'

/** 回收站列表行：走查 / 产品两库归一结构，TrashPage 直接渲染 */
export interface TrashRow {
  kind: TrashKind
  id: string
  name: string
  /** 原位置父级路径（项目名 → 各级文件夹名）；项目本体为空数组（根目录） */
  locationPath: string[]
  deletedAt: number
  /** 随本项一并删除的对象总数（含本体），彻底删除确认弹窗展示 */
  objects: number
  /** 随本项一并删除的附件数量（问题附件 + 复验截图 / 标注附件） */
  attachments: number
  /** 树形归属（「全部」tab 层级展示）：所属项目 id；项目本体无此字段 */
  projectId?: string
  /** 父文件夹 id（文件夹为其上级目录，页面为其原父目录）；顶层/根级为 null */
  parentId?: string | null
}

export interface TrashOpResult {
  /** 成功处理的记录数 */
  ok: number
  /** 原目录已不存在、挂回根目录的记录数 */
  toRoot: number
  /** 无法处理数（记录不存在 / 模式不符 / 父项目已彻底删除） */
  failed: number
}

/** 目标层同名冲突自动加序号后缀（「项目 2」「项目 3」…），不覆盖现有数据 */
export function dedupeTrashName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  let i = 2
  while (taken.has(`${name} ${i}`)) i++
  return `${name} ${i}`
}

/** 还原公共字段清理：清 4 个软删字段，排序值插回删除前位置 */
export function clearSoftDelete<T extends SoftDeleteFields & { sortNo?: number }>(row: T): T {
  const next = { ...row }
  delete next.deletedAt
  delete next.originalParentId
  delete next.restoreOrder
  delete next.deletedInMode
  if (row.restoreOrder != null) next.sortNo = row.restoreOrder
  return next
}

/** 回收站是否有内容（任一表存在软删记录即 true）：供侧边栏按需显示「回收站」菜单。
 *  报告与产品导出共用 reportRecords 表，按 deletedInMode 排除产品侧记录 */
export async function hasWalkTrash(): Promise<boolean> {
  for (const table of [db.projects, db.folders, db.pages]) {
    if ((await table.filter((r) => !!r.deletedAt).limit(1).count()) > 0) return true
  }
  if (
    (await db.reportRecords.filter((r) => !!r.deletedAt && r.deletedInMode !== 'product').limit(1).count()) > 0
  ) {
    return true
  }
  return false
}

/** 读取走查侧回收站全部软删记录（项目/文件夹/页面），归一为 TrashRow（含级联统计与原位置路径） */
export async function getWalkTrashRows(): Promise<TrashRow[]> {
  const [projects, folders, pages] = await Promise.all([
    db.projects.toArray(),
    db.folders.toArray(),
    db.pages.toArray()
  ])
  const projectMap = new Map(projects.map((p) => [p.id, p]))
  const folderMap = new Map(folders.map((f) => [f.id, f]))
  const delProjects = projects.filter((p) => !!p.deletedAt)
  const delFolders = folders.filter((f) => !!f.deletedAt)
  const delPages = pages.filter((p) => !!p.deletedAt)

  // 附件数按 pageId 汇总：问题附件 + 复验截图
  const delPageIds = delPages.map((p) => p.id)
  const pageIssues = delPageIds.length ? await db.issues.where('pageId').anyOf(delPageIds).toArray() : []
  const attByPage = new Map<string, number>()
  for (const i of pageIssues) {
    const n = (i.attachments?.length ?? 0) + (i.fixScreenshotPath ? 1 : 0)
    attByPage.set(i.pageId, (attByPage.get(i.pageId) ?? 0) + n)
  }

  // 原位置路径：项目名 + 祖先文件夹链（含软删祖先，路径展示需完整）
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
  // 文件夹子孙集（BFS 防环）
  const descendantsOf = (rootId: string): Set<string> => {
    const out = new Set<string>([rootId])
    let frontier = [rootId]
    while (frontier.length) {
      const children = folders.filter((f) => f.parentId != null && frontier.includes(f.parentId) && !out.has(f.id))
      children.forEach((c) => out.add(c.id))
      frontier = children.map((c) => c.id)
    }
    return out
  }

  const rows: TrashRow[] = []
  for (const p of delProjects) {
    const subPages = delPages.filter((pg) => pg.projectId === p.id)
    rows.push({
      kind: 'project',
      id: p.id,
      name: p.name,
      locationPath: [],
      deletedAt: p.deletedAt!,
      objects: 1 + delFolders.filter((f) => f.projectId === p.id).length + subPages.length,
      attachments: subPages.reduce((sum, pg) => sum + (attByPage.get(pg.id) ?? 0), 0)
    })
  }
  for (const f of delFolders) {
    const desc = descendantsOf(f.id)
    const innerPages = delPages.filter((pg) => pg.folderId != null && desc.has(pg.folderId))
    rows.push({
      kind: 'folder',
      id: f.id,
      name: f.name,
      projectId: f.projectId,
      parentId: f.parentId ?? null,
      locationPath: [...(projectMap.get(f.projectId)?.name ? [projectMap.get(f.projectId)!.name] : []), ...ancestorNames(f.id)],
      deletedAt: f.deletedAt!,
      objects: desc.size + innerPages.length,
      attachments: innerPages.reduce((sum, pg) => sum + (attByPage.get(pg.id) ?? 0), 0)
    })
  }
  for (const pg of delPages) {
    const proj = projectMap.get(pg.projectId)
    rows.push({
      kind: 'page',
      id: pg.id,
      name: pg.pageName,
      projectId: pg.projectId,
      parentId: pg.originalParentId ?? pg.folderId ?? null,
      locationPath: [...(proj ? [proj.name] : []), ...ancestorNames(pg.folderId)],
      deletedAt: pg.deletedAt!,
      objects: 1,
      attachments: attByPage.get(pg.id) ?? 0
    })
  }
  return rows
}

/** 走查侧回收站报告行（kind 'report'）：原位置 = 所属项目 + 文件夹链 + 页面名；
 *  页面也在回收站时 parentId 指向页面（「全部」tab 树形挂为页面子级），否则顶层散件 */
export async function getWalkTrashReports(): Promise<TrashRow[]> {
  const [reports, pages, projects, folders] = await Promise.all([
    db.reportRecords.toArray(),
    db.pages.toArray(),
    db.projects.toArray(),
    db.folders.toArray()
  ])
  const pageMap = new Map(pages.map((p) => [p.id, p]))
  const projectMap = new Map(projects.map((p) => [p.id, p]))
  const folderMap = new Map(folders.map((f) => [f.id, f]))
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
  return reports
    .filter((r) => !!r.deletedAt && (!r.deletedInMode || r.deletedInMode === 'walk'))
    .map((r) => {
      const page = pageMap.get(r.pageId)
      const proj = projectMap.get(page?.projectId ?? r.projectId)
      return {
        kind: 'report' as const,
        id: r.id,
        name: r.name,
        projectId: r.projectId,
        parentId: r.pageId || null,
        locationPath: [
          ...(proj ? [proj.name] : []),
          ...(page ? [...ancestorNames(page.folderId), page.pageName] : [])
        ],
        deletedAt: r.deletedAt!,
        objects: 1,
        attachments: 0
      }
    })
}

/** 还原软删父级链（页面/文件夹还原时用）：沿 parentId 向上把软删祖先文件夹逐个还原。
 *  链上记录已被彻底删除（不存在）视为断链返回 false，调用方挂到项目根目录 */
async function restoreWalkFolderChain(folderId: string): Promise<boolean> {
  let curId: string | undefined = folderId
  const seen = new Set<string>()
  while (curId && !seen.has(curId)) {
    seen.add(curId)
    const row: Folder | undefined = await db.folders.get(curId)
    if (!row) return false
    if (row.deletedAt) await db.folders.put(clearSoftDelete(row))
    curId = row.parentId ?? undefined
  }
  return true
}

/** 还原链顶软删项目记录（仅本体清字段，不级联其其他子孙）；记录不存在返回 false */
async function restoreWalkProjectRecord(projectId: string): Promise<boolean> {
  const proj = await db.projects.get(projectId)
  if (!proj) return false
  if (proj.deletedAt) await db.projects.put(clearSoftDelete(proj))
  return true
}

/** 还原走查侧软删项目：本体插回根目录（同名加序号后缀），全部软删子文件夹/页面一并还原 */
export async function restoreWalkProjects(ids: string[]): Promise<TrashOpResult> {
  const res: TrashOpResult = { ok: 0, toRoot: 0, failed: 0 }
  const taken = new Set((await db.projects.toArray()).filter((p) => !p.deletedAt).map((p) => p.name))
  for (const id of ids) {
    try {
      const row = await db.projects.get(id)
      // 幂等：记录不存在 / 已还原 / 模式不符直接跳过
      if (!row || !row.deletedAt || (row.deletedInMode && row.deletedInMode !== 'walk')) {
        res.failed++
        continue
      }
      const next = clearSoftDelete(row)
      next.name = dedupeTrashName(next.name, taken)
      taken.add(next.name)
      await db.projects.put(next)
      // 级联还原全部软删子项（还原父项时子项一并还原）
      const fs = (await db.folders.where('projectId').equals(id).toArray()).filter((f) => f.deletedAt)
      if (fs.length) await db.folders.bulkPut(fs.map(clearSoftDelete))
      const ps = (await db.pages.where('projectId').equals(id).toArray()).filter((p) => p.deletedAt)
      if (ps.length) await db.pages.bulkPut(ps.map(clearSoftDelete))
      res.ok++
    } catch (err) {
      console.warn('[TRASH] 还原项目失败:', id, err)
      res.failed++
    }
  }
  return res
}

/** 还原走查侧软删文件夹：整条父级链一并还原，全部软删子孙文件夹与各层页面同批还原 */
export async function restoreWalkFolders(ids: string[]): Promise<TrashOpResult> {
  const res: TrashOpResult = { ok: 0, toRoot: 0, failed: 0 }
  for (const id of ids) {
    try {
      const row = await db.folders.get(id)
      if (!row || !row.deletedAt || (row.deletedInMode && row.deletedInMode !== 'walk')) {
        res.failed++
        continue
      }
      // 链顶项目已被彻底删除 → 文件夹无处可挂，放弃还原
      if (!(await restoreWalkProjectRecord(row.projectId))) {
        console.warn('[TRASH] 还原文件夹失败（原项目已不存在）:', id)
        res.failed++
        continue
      }
      // 上级文件夹路径：父目录软删 → 同步还原整条祖先链（项目级联删除后单还原子文件夹的场景）；
      // 链上目录已被彻底删除 → 挂项目根目录
      let parentId: string | undefined = row.originalParentId ?? row.parentId ?? undefined
      if (parentId) {
        const parent = await db.folders.get(parentId)
        if (!parent) {
          parentId = undefined
          res.toRoot++
        } else if (parent.deletedAt && !(await restoreWalkFolderChain(parent.id))) {
          parentId = undefined
          res.toRoot++
        }
      }
      // 本体同名冲突：与同一父层下正常文件夹重名时加序号后缀
      const sameLayer = (await db.folders.where('projectId').equals(row.projectId).toArray()).filter(
        (f) => !f.deletedAt && f.id !== id && (f.parentId ?? undefined) === parentId
      )
      const taken = new Set(sameLayer.map((f) => f.name))
      const next = clearSoftDelete(row)
      next.parentId = parentId
      next.name = dedupeTrashName(next.name, taken)
      await db.folders.put(next)
      // BFS 收集软删子孙文件夹，全部还原（与 softDeleteFolders 同口径）
      const allIds = [id]
      const seen = new Set([id])
      let frontier = [id]
      while (frontier.length) {
        const children = await db.folders
          .where('parentId')
          .anyOf(frontier)
          .filter((f) => !seen.has(f.id))
          .toArray()
        frontier = children.map((f) => f.id)
        frontier.forEach((fid) => seen.add(fid))
        allIds.push(...frontier)
      }
      const childFolders = (await db.folders.bulkGet(allIds.filter((fid) => fid !== id))).filter(
        (f): f is Folder => !!f && !!f.deletedAt
      )
      if (childFolders.length) await db.folders.bulkPut(childFolders.map(clearSoftDelete))
      const childPages = (await db.pages.where('folderId').anyOf(allIds).toArray()).filter((p) => p.deletedAt)
      if (childPages.length) await db.pages.bulkPut(childPages.map(clearSoftDelete))
      res.ok++
    } catch (err) {
      console.warn('[TRASH] 还原文件夹失败:', id, err)
      res.failed++
    }
  }
  return res
}

/** 还原走查侧软删页面：优先还原整条父级链；原目录已被彻底删除时挂到项目根目录 */
export async function restoreWalkPages(ids: string[]): Promise<TrashOpResult> {
  const res: TrashOpResult = { ok: 0, toRoot: 0, failed: 0 }
  for (const id of ids) {
    try {
      const row = await db.pages.get(id)
      if (!row || !row.deletedAt || (row.deletedInMode && row.deletedInMode !== 'walk')) {
        res.failed++
        continue
      }
      if (!(await restoreWalkProjectRecord(row.projectId))) {
        console.warn('[TRASH] 还原页面失败（原项目已不存在）:', id)
        res.failed++
        continue
      }
      // 父目录：originalParentId 优先；目录软删 → 还原整条父级链；目录已被彻底删除 → 挂项目根目录
      const parentId = row.originalParentId ?? row.folderId ?? undefined
      let folderId: string | undefined = undefined
      if (parentId) {
        const parent = await db.folders.get(parentId)
        if (!parent) {
          folderId = undefined
          res.toRoot++
        } else if (parent.deletedAt) {
          const chainOk = await restoreWalkFolderChain(parent.id)
          if (!chainOk) {
            folderId = undefined
            res.toRoot++
          } else folderId = parent.id
        } else folderId = parent.id
      }
      // 同名冲突：与同层正常页面重名时加序号后缀，不覆盖现有数据
      const sameLayer = (await db.pages.where('projectId').equals(row.projectId).toArray()).filter(
        (p) => !p.deletedAt && p.id !== id && (p.folderId ?? undefined) === folderId
      )
      const taken = new Set(sameLayer.map((p) => p.pageName))
      const next = clearSoftDelete(row)
      next.folderId = folderId
      next.pageName = dedupeTrashName(next.pageName, taken)
      await db.pages.put(next)
      res.ok++
    } catch (err) {
      console.warn('[TRASH] 还原页面失败:', id, err)
      res.failed++
    }
  }
  return res
}

/** 还原走查侧软删报告：所属页面也被软删时先还原页面及其父级链；
 *  页面已被彻底删除则报告无处可挂，放弃还原 */
export async function restoreWalkReports(ids: string[]): Promise<TrashOpResult> {
  const res: TrashOpResult = { ok: 0, toRoot: 0, failed: 0 }
  for (const id of ids) {
    try {
      const row = await db.reportRecords.get(id)
      if (!row || !row.deletedAt || (row.deletedInMode && row.deletedInMode !== 'walk')) {
        res.failed++
        continue
      }
      const page = await db.pages.get(row.pageId)
      if (!page) {
        console.warn('[TRASH] 还原报告失败（原页面已不存在）:', id)
        res.failed++
        continue
      }
      if (page.deletedAt) {
        const r = await restoreWalkPages([page.id])
        if (r.ok === 0) {
          res.failed++
          continue
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

/** 彻底删除回收站内页面：物理清理磁盘图片（原图/截图/复验图/附件），
 *  移除导出记录（HTML 文件移入废纸篓可恢复），删除问题、访问记录与页面记录。仅处理已软删记录 */
async function purgeWalkPages(pageIds: string[]): Promise<number> {
  const pages = (await db.pages.bulkGet(pageIds)).filter(
    (p): p is WalkthroughPage => !!p && !!p.deletedAt
  )
  if (!pages.length) return 0
  const ids = pages.map((p) => p.id)
  const issues = await db.issues.where('pageId').anyOf(ids).toArray()
  const imagePaths = [
    ...pages.flatMap((p) => [p.designImagePath, p.screenshotPath, p.walkDesignPath, p.walkShotPath]),
    ...issues.flatMap((i) => (i.fixScreenshotPath ? [i.fixScreenshotPath] : [])),
    ...issues.flatMap((i) => (i.attachments ?? []).map((a) => a.relPath))
  ].filter((p): p is string => !!p)
  // 磁盘图片物理删除（含此前散落在 image_trash 的同路径历史文件；单文件失败仅 [TRASH] 日志）
  if (imagePaths.length) {
    await window.electronAPI
      .purgeImages([...new Set(imagePaths)])
      .catch((err) => console.warn('[TRASH] 批量清理页面图片失败:', err))
  }
  // 导出记录：库内行删除；HTML 报告文件移入废纸篓（可恢复，不直接销毁用户文件）
  const reports = await db.reportRecords.where('pageId').anyOf(ids).toArray()
  for (const r of reports) {
    if (r.filePath) {
      await window.electronAPI
        .deleteReportFile(r.filePath)
        .catch((err) => console.warn('[TRASH] 清理报告文件失败:', r.id, err))
    }
  }
  if (reports.length) await db.reportRecords.bulkDelete(reports.map((r) => r.id))
  await db.transaction('rw', db.pages, db.issues, db.visits, async () => {
    await db.visits.where('pageId').anyOf(ids).delete()
    await db.issues.where('pageId').anyOf(ids).delete()
    await db.pages.bulkDelete(ids)
  })
  return pages.length
}

/** 彻底删除回收站内项目：子树页面/文件夹与磁盘图片全清，项目本体及关联数据移除 */
export async function permanentlyDeleteWalkProjects(ids: string[]): Promise<TrashOpResult> {
  const res: TrashOpResult = { ok: 0, toRoot: 0, failed: 0 }
  for (const id of ids) {
    try {
      const proj = await db.projects.get(id)
      if (!proj || !proj.deletedAt) {
        res.failed++
        continue
      }
      const pageIds = (await db.pages.where('projectId').equals(id).toArray()).map((p) => p.id)
      await purgeWalkPages(pageIds)
      // 项目 Logo 图片一并清理
      if (proj.logoPath) {
        await window.electronAPI
          .purgeImages([proj.logoPath])
          .catch((err) => console.warn('[TRASH] 清理项目 Logo 失败:', id, err))
      }
      // 残余导出记录兜底（按 projectId）
      const restReports = await db.reportRecords.where('projectId').equals(id).toArray()
      for (const r of restReports) {
        if (r.filePath) {
          await window.electronAPI
            .deleteReportFile(r.filePath)
            .catch((err) => console.warn('[TRASH] 清理报告文件失败:', r.id, err))
        }
      }
      if (restReports.length) await db.reportRecords.bulkDelete(restReports.map((r) => r.id))
      await db.transaction(
        'rw',
        db.projects,
        db.folders,
        db.visits,
        db.projectSpecBindings,
        db.specTokenMappings,
        async () => {
          await db.visits.where('projectId').equals(id).delete()
          await db.folders.where('projectId').equals(id).delete()
          await db.projectSpecBindings.where('projectId').equals(id).delete()
          await db.specTokenMappings.where('projectId').equals(id).delete()
          await db.projects.delete(id)
        }
      )
      res.ok++
    } catch (err) {
      console.warn('[TRASH] 彻底删除项目失败:', id, err)
      res.failed++
    }
  }
  return res
}

/** 彻底删除回收站内文件夹：子孙文件夹与各层页面记录、问题、磁盘图片全清 */
export async function permanentlyDeleteWalkFolders(ids: string[]): Promise<TrashOpResult> {
  const res: TrashOpResult = { ok: 0, toRoot: 0, failed: 0 }
  const validRoots: string[] = []
  for (const id of ids) {
    const row = await db.folders.get(id)
    if (!row || !row.deletedAt) {
      res.failed++
      continue
    }
    validRoots.push(id)
  }
  if (!validRoots.length) return res
  try {
    // 与 softDeleteFolders / deleteFolderCascade 同口径收集子孙（BFS 防环）
    const bundle = await captureBatchDeleteUndo(validRoots, [])
    const pageIds = bundle.pages.filter((p) => p.deletedAt).map((p) => p.id)
    const folderIds = bundle.folders.filter((f) => f.deletedAt).map((f) => f.id)
    if (pageIds.length) await purgeWalkPages(pageIds)
    if (folderIds.length) await db.folders.bulkDelete(folderIds)
    res.ok = validRoots.length
  } catch (err) {
    console.warn('[TRASH] 彻底删除文件夹失败:', validRoots, err)
    res.failed += validRoots.length
  }
  return res
}

/** 彻底删除回收站内页面 */
export async function permanentlyDeleteWalkPages(ids: string[]): Promise<TrashOpResult> {
  const res: TrashOpResult = { ok: 0, toRoot: 0, failed: 0 }
  try {
    res.ok = await purgeWalkPages(ids)
  } catch (err) {
    console.warn('[TRASH] 彻底删除页面失败:', ids, err)
    res.failed += ids.length
  }
  return res
}

/** 彻底删除回收站内报告：HTML 报告文件移入系统废纸篓（可恢复），库内记录删除。
 *  走查/产品两模式共用（仅处理已软删记录） */
export async function permanentlyDeleteReports(ids: string[]): Promise<TrashOpResult> {
  const res: TrashOpResult = { ok: 0, toRoot: 0, failed: 0 }
  const rows = (await db.reportRecords.bulkGet(ids)).filter(
    (r): r is ReportRecord => !!r && !!r.deletedAt
  )
  for (const r of rows) {
    try {
      if (r.filePath) {
        await window.electronAPI
          .deleteReportFile(r.filePath)
          .catch((err) => console.warn('[TRASH] 清理报告文件失败:', r.id, err))
      }
      await db.reportRecords.delete(r.id)
      res.ok++
    } catch (err) {
      console.warn('[TRASH] 彻底删除报告失败:', r.id, err)
      res.failed++
    }
  }
  res.failed += ids.length - rows.length
  return res
}

/** 批量删除快照：Cmd+Z 撤回所需的完整记录与图片路径（撤销时先恢复文件再回写记录） */
export interface WalkDeleteEntry {
  folders: Folder[]
  pages: WalkthroughPage[]
  issues: Issue[]
  visits: Visit[]
  /** 涉及的全部图片相对路径（去重），撤销时据此从回收站恢复文件 */
  imagePaths: string[]
}

/**
 * 批量删除前快照（Cmd+Z 撤回用）：收集选中文件夹的全部子孙文件夹（与 deleteFolderCascade
 * 同口径），连同选中页面一并取回完整记录（folders/pages/issues/visits）与涉及图片路径。
 */
export async function captureBatchDeleteUndo(
  folderIds: string[],
  pageIds: string[]
): Promise<WalkDeleteEntry> {
  // BFS 收集选中文件夹的子孙文件夹（防环：访问集去重）
  const collected: string[] = []
  const seen = new Set<string>(folderIds)
  let frontier = [...folderIds]
  while (frontier.length) {
    collected.push(...frontier)
    const children = await db.folders
      .where('parentId')
      .anyOf(frontier)
      .filter((f) => !seen.has(f.id))
      .toArray()
    frontier = children.map((f) => f.id)
    frontier.forEach((id) => seen.add(id))
  }
  // 选中页面 + 文件夹树内页面，按 id 去重
  const pageMap = new Map<string, WalkthroughPage>()
  if (pageIds.length) {
    for (const p of await db.pages.bulkGet(pageIds)) if (p) pageMap.set(p.id, p)
  }
  if (collected.length) {
    for (const p of await db.pages.where('folderId').anyOf(collected).toArray()) pageMap.set(p.id, p)
  }
  const pages = [...pageMap.values()]
  const pageIdList = pages.map((p) => p.id)
  const issues = pageIdList.length ? await db.issues.where('pageId').anyOf(pageIdList).toArray() : []
  const visits = pageIdList.length ? await db.visits.where('pageId').anyOf(pageIdList).toArray() : []
  const folders = collected.length
    ? (await db.folders.bulkGet(collected)).filter((f): f is Folder => !!f)
    : []
  const imagePaths = [
    ...pages.flatMap((p) => [
      p.designImagePath,
      p.screenshotPath,
      p.walkDesignPath,
      p.walkShotPath
    ]),
    ...issues.flatMap((i) => (i.fixScreenshotPath ? [i.fixScreenshotPath] : [])),
    ...issues.flatMap((i) => (i.attachments ?? []).map((a) => a.relPath))
  ].filter((p): p is string => !!p)
  return {
    folders,
    pages,
    issues,
    visits,
    imagePaths: [...new Set(imagePaths)]
  }
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
