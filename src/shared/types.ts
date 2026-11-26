/**
 * 自动走查共用的归一化样式 Schema：
 * Figma 图层树（REST 拉取）与 webview DOM 采集（getComputedStyle）都归一化为 StyleNode，
 * 供模糊匹配与属性级比对使用。仅做只读读取，不修改任何来源数据。
 */

/** 归一化样式节点（Figma 图层 / DOM 元素通用） */
export interface StyleNode {
  /** 节点标识：Figma 为节点 ID（如 12:34），DOM 为采集序号路径（如 dom-17） */
  id: string
  /** 图层名 / DOM 标签+类名摘要 */
  name: string
  /** 归一化类型：frame | group | text | rect | ellipse | component */
  type: 'frame' | 'group' | 'text' | 'rect' | 'ellipse' | 'component'
  /** 相对根节点 / 视口左上角的 px 坐标与尺寸 */
  x: number
  y: number
  width: number
  height: number
  /** 背景填充色（hex），无填充缺省 */
  fill?: string
  /** 文本颜色（hex） */
  textColor?: string
  /** 文本内容（TEXT 节点 / 元素 innerText，截断 200 字符） */
  text?: string
  fontSize?: number
  fontWeight?: number
  fontFamily?: string
  /** 行高 px */
  lineHeight?: number
  /** 字间距 px */
  letterSpacing?: number
  textAlign?: string
  paddingTop?: number
  paddingRight?: number
  paddingBottom?: number
  paddingLeft?: number
  /** Flex/Grid 间距（Figma itemSpacing / DOM gap） */
  gap?: number
  /** 圆角（4 角，顺时针：左上/右上/右下/左下） */
  borderRadius?: number[]
  /** 圆角来源：self = 元素自身设置；parent-clip = 父容器 overflow 裁剪继承（结构化比对豁免用） */
  radiusSource?: 'self' | 'parent-clip'
  /** radiusSource = 'parent-clip' 时，产出圆角的父容器选择器路径 */
  radiusParentPath?: string
  /** 开发侧圆角为百分比（border-radius: 50% 等），比对时已按元素短边换算为 px */
  radiusPercent?: boolean
  /** 设计侧宽度自适应：auto-layout 容器 layoutSizingHorizontal=HUG 或文本 WIDTH_AND_HEIGHT；DOM 侧不设此字段 */
  hugWidth?: boolean
  /** DOM 侧直接文本子节点 Range 实测渲染宽度（多行取最宽行），hug 文本宽度比对用 */
  textContentWidth?: number
  /** DOM 侧直接文本子节点 Range 实测渲染包围盒（多行并集，文档坐标），a11y 文本类标注定位用 */
  textRect?: { x: number; y: number; width: number; height: number }
  borderWidth?: number
  borderColor?: string
  boxShadow?: string
  opacity?: number
  /** 匹配用主色：背景填充优先，文本节点取文字色 */
  dominantColor?: string
  /** 宽高比（width/height，用于模糊匹配） */
  aspectRatio?: number
  /** 精准匹配锚点：元素上的 data-figma-id 属性 */
  dataFigmaId?: string
  /** Figma 侧节点 ID（便于回溯与报告定位） */
  figmaNodeId?: string
  /** DOM 侧选择器路径（便于报告定位） */
  domPath?: string
  /** IMG 加载失败（complete && naturalWidth===0），仅 DOM 侧 IMG 节点存在 */
  imgBroken?: boolean
  /** IMG 的 alt 属性原文（未设置时缺省，元素清单与 a11y 检查用） */
  alt?: string
  /** 有效背景色（自身背景透明时向上取最近祖先背景，a11y 对比度检查用） */
  effectiveBg?: string
  /** 表单控件 placeholder（a11y 输入框标签检查用） */
  placeholder?: string
  /** 表单控件 aria-label（a11y 用） */
  ariaLabel?: string
  /** 表单控件 aria-labelledby（a11y 用） */
  ariaLabelledby?: string
  children?: StyleNode[]
}

/** 容差配置（全局一套，设置页可调，持久化在 walkthrough-config.json 的 walkTolerance 键） */
export interface ToleranceConfig {
  /** 尺寸容差 px（宽/高/位置），默认 1 */
  size: number
  /** 文字排版容差 px（字号/行高/字间距），默认 1 */
  typography: number
  /** 间距容差 px（padding/gap），默认 2 */
  spacing: number
  /** 圆角容差 px，默认 1 */
  radius: number
  /** 色差容差（ΔE CIEDE2000），默认 2 */
  color: number
  /** 描边容差 px，默认 1 */
  border: number
}

/** 默认走查容差：阈值过紧会把渲染抗锯齿/取整误差当差异报出（大面积误判），
 *  默认值按「实际落地走查可执行」口径放宽——小于阈值的渲染噪声不生成差异 */
export const DEFAULT_TOLERANCE: ToleranceConfig = {
  size: 2,
  typography: 2,
  spacing: 4,
  radius: 2,
  color: 8,
  border: 2
}

/** 校正非法容差输入并合并默认值 */
export function normalizeTolerance(raw: Partial<ToleranceConfig> | undefined): ToleranceConfig {
  const merged = { ...DEFAULT_TOLERANCE, ...(raw ?? {}) }
  const clamp = (v: unknown, fallback: number): number => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : fallback
  }
  return {
    size: clamp(merged.size, DEFAULT_TOLERANCE.size),
    typography: clamp(merged.typography, DEFAULT_TOLERANCE.typography),
    spacing: clamp(merged.spacing, DEFAULT_TOLERANCE.spacing),
    radius: clamp(merged.radius, DEFAULT_TOLERANCE.radius),
    color: clamp(merged.color, DEFAULT_TOLERANCE.color),
    border: clamp(merged.border, DEFAULT_TOLERANCE.border)
  }
}

/** 匹配结果对：一个设计稿节点与一个 DOM 节点的对应关系 */
export interface MatchPair {
  design: StyleNode
  dom: StyleNode
  /** 置信度 0~1 */
  confidence: number
  /** 匹配方式：data-figma-id 精准直通 / 特征模糊匹配 */
  method: 'figma-id' | 'fuzzy'
}

/** 结构化样式差异（属性级），category 与问题清单 6 分类中的 4 类对齐 */
export interface StyleDiff {
  /** 差异类别：间距规范 / 文字排版 / 颜色规范 / 样式规范 */
  category: 'spacing' | 'typography' | 'color' | 'style'
  severity: 'major' | 'minor' | 'suggestion'
  /** 差异属性标识（如 font-size、background、padding-top、border-radius） */
  property: string
  /** 属性中文名 */
  label: string
  designValue: string
  devValue: string
  /** 颜色类差异的开发侧色值（hex），渲染色值标注用 */
  colorHex?: string
  /** 差异备注（圆角来源说明、百分比换算说明等），详情面板展示 */
  note?: string
  /** 自动生成的差异描述 */
  description: string
  figmaNodeId?: string
  domPath?: string
  /** 该差异对应匹配对的置信度 */
  matchConfidence: number
  /** 标注框：DOM 节点相对视口的归一化坐标（0~1），直接可用于 Issue 落库 */
  rect: { x: number; y: number; width: number; height: number }
}

/** 问题来源：结构化比对 / 图片视觉比对（AI）/ 手动标注 / 设计规范 Token 校验 / 元素清单一致性 / 无障碍检查 */
export type IssueSource = 'structured' | 'visual' | 'manual' | 'spec' | 'element' | 'a11y'

/** 自动走查自定义检查项（面板「自定义检查项」弹窗，持久化在 walkCheckOptions 键） */
export interface WalkCheckOptions {
  /** 检查维度 key 列表（WALK_DIMENSIONS 子集，对应 AI 视觉走查 6 项清单） */
  dimensions: string[]
  /** 检查深度：宽松 / 标准（推荐）/ 严格 */
  depth: 'loose' | 'standard' | 'strict'
  /** AI 分析设置 key 列表（WALK_ANALYSES 子集） */
  analysis: string[]
  /** 输出风格：简洁 / 详细 */
  style: 'concise' | 'detailed'
  /** 按需叠加无障碍 a11y 检查（默认关闭） */
  a11y: boolean
  /** 组件存在性识别校验（默认关闭）：开启后才输出「组件缺失」类备选问题（该类识别易误判，仅作参考） */
  componentCheck: boolean
  /** 设计 Token 合规校验（默认开启）：走查时将页面 DOM 样式与项目绑定规范 Token 比对（设置页关闭设计规范功能后开关隐藏） */
  specCheck: boolean
}

/** 检查维度（AI 视觉比对 prompt 注入用，label 与面板勾选项一致；与 6 项视觉检查清单对齐） */
export const WALK_DIMENSIONS: { key: string; label: string }[] = [
  { key: 'text', label: '文字类' },
  { key: 'layout', label: '对齐布局' },
  { key: 'image', label: '图标图片' },
  { key: 'state', label: '组件状态' },
  { key: 'color', label: '色彩' },
  { key: 'typography', label: '排版' }
]

/** AI 分析设置 */
export const WALK_ANALYSES: { key: string; label: string }[] = [
  { key: 'locate', label: '问题定位与原因' },
  { key: 'fix', label: '修改建议' },
  { key: 'risk', label: '风险评估' },
  { key: 'priority', label: '优化优先级' }
]

export const DEFAULT_WALK_CHECK_OPTIONS: WalkCheckOptions = {
  dimensions: WALK_DIMENSIONS.map((d) => d.key),
  depth: 'standard',
  analysis: WALK_ANALYSES.map((a) => a.key),
  style: 'detailed',
  a11y: false,
  componentCheck: false,
  specCheck: true
}

/** 校正本地存储的检查项：过滤已下线的维度 key，补齐缺省字段 */
export function normalizeWalkCheckOptions(raw: Partial<WalkCheckOptions> | undefined): WalkCheckOptions {
  const validDims = new Set(WALK_DIMENSIONS.map((d) => d.key))
  const validAnalyses = new Set(WALK_ANALYSES.map((a) => a.key))
  const dims = (raw?.dimensions ?? []).filter((k) => validDims.has(k))
  const analyses = (raw?.analysis ?? []).filter((k) => validAnalyses.has(k))
  const depth = ['loose', 'standard', 'strict'].includes(String(raw?.depth))
    ? (raw!.depth as WalkCheckOptions['depth'])
    : DEFAULT_WALK_CHECK_OPTIONS.depth
  const style = raw?.style === 'concise' ? 'concise' : 'detailed'
  return {
    dimensions: dims.length ? dims : DEFAULT_WALK_CHECK_OPTIONS.dimensions,
    depth,
    analysis: analyses.length ? analyses : DEFAULT_WALK_CHECK_OPTIONS.analysis,
    style,
    a11y: raw?.a11y === true,
    componentCheck: raw?.componentCheck === true,
    // 历史数据无该字段：undefined 视为开启（与存量「绑定规范即校验」行为一致，仅显式关闭才跳过）
    specCheck: raw?.specCheck !== false
  }
}

/** 问题分级（自动走查）：required=必标问题（默认生成画布标注并进报告）；optional=备选参考问题（默认不生成标注，用户勾选后才标注、随导出开关进报告）。缺省视为 required（兼容历史数据） */
export type IssueLevel = 'required' | 'optional'

/** 缺失类关键词：组件缺失类识别易误判，兜底归入备选 */
export const ISSUE_MISSING_KEYWORDS = ['缺失', '缺少', '未找到', '不存在']
/** 无障碍/对比度类关键词：设计选型占多数，兜底归入备选（匹配时统一转小写） */
export const ISSUE_A11Y_KEYWORDS = ['对比度', 'wcag', '无障碍', 'contrast']

/** AI 判为备选但未给出理由时的默认说明 */
export const DEFAULT_OPTIONAL_REASON = 'AI 判定为参考类问题，默认不生成画布标注，勾选后加入标注清单'
/** 缺失类兜底理由（AI 兜底与程序轨 element-missing 共用，保证分级口径一致） */
export const MISSING_OPTIONAL_REASON =
  '组件缺失类识别易误判：请核对 Figma 设计稿确认该元素是否真实存在，先作为备选参考'
/** 无障碍/对比度类兜底理由（AI 兜底与程序轨 a11y 共用） */
export const A11Y_OPTIONAL_REASON =
  '无障碍/对比度类提示：设计稿与开发图视觉一致时属设计选型，仅作评审参考，不作为强制缺陷'

/** AI 显式返回的 level 白名单归一化：非法/缺省返回 undefined（走兜底判定） */
export function normalizeIssueLevel(raw: unknown): IssueLevel | undefined {
  return raw === 'required' || raw === 'optional' ? raw : undefined
}

/**
 * 问题分级兜底判定（仅自动走查套用，手动 AI 识别不分级）：
 * ① AI 显式 level 优先（模型已按 prompt 要求先核对设计稿再判定）；
 * ② category=missing-component 或描述命中缺失类关键词 → optional（组件缺失识别易误判，需人工核对设计稿）；
 * ③ 描述命中对比度/无障碍关键词 → optional（设计稿与开发图视觉一致时属设计选型，仅参考）；
 * ④ 其余 → required（走正常标注流程）
 */
export function resolveIssueLevel(input: {
  level?: unknown
  levelReason?: unknown
  category?: unknown
  description?: unknown
}): { level: IssueLevel; levelReason?: string } {
  const desc = typeof input.description === 'string' ? input.description : ''
  const reason = typeof input.levelReason === 'string' ? input.levelReason.trim() : ''
  const explicit = normalizeIssueLevel(input.level)
  if (explicit) {
    return {
      level: explicit,
      levelReason: reason || (explicit === 'optional' ? DEFAULT_OPTIONAL_REASON : undefined)
    }
  }
  const isMissing =
    String(input.category) === 'missing-component' || ISSUE_MISSING_KEYWORDS.some((k) => desc.includes(k))
  if (isMissing) {
    return { level: 'optional', levelReason: reason || MISSING_OPTIONAL_REASON }
  }
  const lower = desc.toLowerCase()
  if (ISSUE_A11Y_KEYWORDS.some((k) => lower.includes(k))) {
    return { level: 'optional', levelReason: reason || A11Y_OPTIONAL_REASON }
  }
  return { level: 'required' }
}

/**
 * 走查 visual 轨分级兜底：AI 显式 level 优先保留（含理由）；无显式分级时按缺失/对比度关键词兜底。
 * 仅备选级与 AI 显式分级落库，纯 required 不写字段（缺省视为 required，兼容历史数据）。
 * 仅自动走查调用，手动 AI 识别不分级。
 */
export function applyWalkIssueLevels<T extends { level?: unknown; levelReason?: unknown }>(issues: T[]): T[] {
  return issues.map((it) => {
    const r = resolveIssueLevel(it)
    if (r.level === 'optional' || it.level != null) {
      return { ...it, level: r.level, levelReason: r.levelReason } as T
    }
    return it
  })
}

/**
 * 画布几何谓词：带坐标信息的标注才有可画几何（清单手加的问题无坐标不渲染）。
 * 不判断备选勾选状态——自动走查画布对未勾选备选也渲染（虚线幽灵样式），是否放行由调用侧决定。
 */
export function isDrawableOnCanvas(i: {
  shape?: string
  width?: number
  height?: number
}): boolean {
  return (
    i.shape === 'point' ||
    i.shape === 'text' ||
    i.shape === 'measure' ||
    i.shape === 'picker' ||
    i.width !== 0 ||
    i.height !== 0
  )
}

/**
 * 画布渲染谓词：带坐标信息的标注才渲染（清单手加的问题无坐标不渲染）；
 * 备选（optional）问题未勾选时不渲染，用户勾选后生成画布标注；required 与历史数据（无 level）不受影响。
 */
export function isRenderableOnCanvas(i: {
  shape?: string
  width?: number
  height?: number
  level?: unknown
  optionalChecked?: unknown
}): boolean {
  if (i.level === 'optional' && i.optionalChecked !== true) return false
  return isDrawableOnCanvas(i)
}

/**
 * 报告收录谓词：未审核 AI 候选不计入报告；备选（optional）问题默认不导出，
 * 开启「导出备选参考问题」后仅收录清单中已勾选的备选项；required 与历史数据（无 level）不受影响。
 * HTML 报告与在线文档（飞书 / 腾讯 / 金山）共用此口径。
 */
export function isReportableIssue(
  i: {
    isAISuggested?: unknown
    aiConfirmed?: unknown
    level?: unknown
    optionalChecked?: unknown
  },
  includeOptional: boolean
): boolean {
  if (i.isAISuggested && !i.aiConfirmed) return false
  if (i.level === 'optional' && (!includeOptional || i.optionalChecked !== true)) return false
  return true
}

/** 自动走查比对结果（IPC 返回） */
export interface CompareResult {
  ok: boolean
  message?: string
  /** 匹配对（含低置信度，供人工确认抽屉展示） */
  pairs: MatchPair[]
  /** 属性级差异（仅来自置信度达标的匹配对） */
  diffs: StyleDiff[]
  /** 未匹配上的设计稿节点（数量提示用） */
  unmatchedDesignCount: number
  unmatchedDomCount: number
  /** 分层误差旁路结果（仅 walkLayeredTolerance.enabled=true 时返回，否则缺省） */
  layered?: LayeredRunSummary
  /** 豁免差异（父容器裁剪圆角等，不进主列表、不扣分，详情面板折叠查看） */
  exemptDiffs?: StyleDiff[]
}

/** ───────────── 分层误差模型（v3 旁路：容器/控件两级 × 位置/尺寸两维） ───────────── */

/** 节点分类：容器（布局承载）/ 控件（交互/内容单元）/ 文本 */
export type NodeKind = 'container' | 'control' | 'text'

/** 误差层级：模块级（容器整体）/ 元素级（控件与文本） */
export type ErrorLevel = 'module' | 'element'

/** 误差维度：位置（中心点偏移）/ 尺寸（宽高偏差） */
export type ErrorDim = 'position' | 'size'

/** 分层容差配置（持久化在 walkthrough-config.json 的 walkLayeredTolerance 键） */
export interface LayeredToleranceConfig {
  /** 分层开关：默认关闭，关闭时不参与任何计算（与现状行为一致） */
  enabled: boolean
  /** 模块级位置容差 px，默认 4 */
  modulePosTol: number
  /** 模块级尺寸容差 px，默认 6 */
  moduleSizeTol: number
  /** 元素级位置容差 px，默认 2 */
  elementPosTol: number
  /** 元素级尺寸容差 px，默认 1 */
  elementSizeTol: number
  /** 模块级扣分权重（0~1），默认 0.4 */
  weightModule: number
  /** 元素级扣分权重（0~1），默认 0.6 */
  weightElement: number
  /** 位置维扣分权重（0~1），默认 0.5 */
  weightPosition: number
  /** 尺寸维扣分权重（0~1），默认 0.5 */
  weightSize: number
}

export const DEFAULT_LAYERED_TOLERANCE: LayeredToleranceConfig = {
  enabled: false,
  modulePosTol: 4,
  moduleSizeTol: 6,
  elementPosTol: 2,
  elementSizeTol: 1,
  weightModule: 0.4,
  weightElement: 0.6,
  weightPosition: 0.5,
  weightSize: 0.5
}

/** 配置持久化键名（walkthrough-config.json） */
export const LAYERED_TOLERANCE_KEY = 'walkLayeredTolerance'

/** 校正非法输入并合并默认值：容差 ≥0，权重 clamp 0~1，enabled 必须显式 true */
export function normalizeLayeredTolerance(
  raw: Partial<LayeredToleranceConfig> | undefined
): LayeredToleranceConfig {
  const merged = { ...DEFAULT_LAYERED_TOLERANCE, ...(raw ?? {}) }
  const clampNum = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(v)
    if (!Number.isFinite(n)) return fallback
    return Math.round(Math.max(min, Math.min(max, n)) * 100) / 100
  }
  return {
    enabled: merged.enabled === true,
    modulePosTol: clampNum(merged.modulePosTol, DEFAULT_LAYERED_TOLERANCE.modulePosTol, 0, Infinity),
    moduleSizeTol: clampNum(
      merged.moduleSizeTol,
      DEFAULT_LAYERED_TOLERANCE.moduleSizeTol,
      0,
      Infinity
    ),
    elementPosTol: clampNum(
      merged.elementPosTol,
      DEFAULT_LAYERED_TOLERANCE.elementPosTol,
      0,
      Infinity
    ),
    elementSizeTol: clampNum(
      merged.elementSizeTol,
      DEFAULT_LAYERED_TOLERANCE.elementSizeTol,
      0,
      Infinity
    ),
    weightModule: clampNum(merged.weightModule, DEFAULT_LAYERED_TOLERANCE.weightModule, 0, 1),
    weightElement: clampNum(merged.weightElement, DEFAULT_LAYERED_TOLERANCE.weightElement, 0, 1),
    weightPosition: clampNum(merged.weightPosition, DEFAULT_LAYERED_TOLERANCE.weightPosition, 0, 1),
    weightSize: clampNum(merged.weightSize, DEFAULT_LAYERED_TOLERANCE.weightSize, 0, 1)
  }
}

/** ───────────── 结构化对比增强（圆角 computed 修复 / hug 文本宽度，结构化比对旁路配置） ───────────── */

/** 结构化对比增强配置（持久化在 walkthrough-config.json 的 walkStructuredChecks 键） */
export interface StructuredChecksConfig {
  /** 圆角增强：百分比换算 + 父容器裁剪追溯（默认开启；关闭时回退旧行为） */
  radiusCheck: boolean
  /** hug 文本宽度比对模式：strict = 严格对比容器宽；text-content = hug 场景对比文字内容宽（推荐） */
  hugWidthMode: 'strict' | 'text-content'
}

export const STRUCTURED_CHECKS_KEY = 'walkStructuredChecks'

export const DEFAULT_STRUCTURED_CHECKS: StructuredChecksConfig = {
  radiusCheck: true,
  hugWidthMode: 'text-content'
}

/** 校正非法输入并合并默认值：radiusCheck 非显式 false 即开启；hugWidthMode 仅显式 'strict' 生效 */
export function normalizeStructuredChecks(
  raw: Partial<StructuredChecksConfig> | undefined
): StructuredChecksConfig {
  return {
    radiusCheck: raw?.radiusCheck !== false,
    hugWidthMode: raw?.hugWidthMode === 'strict' ? 'strict' : DEFAULT_STRUCTURED_CHECKS.hugWidthMode
  }
}

/** 单条分层误差（与 StyleDiff 平行的旁路结果，不落现有 Issue 链路） */
export interface LayeredErrorItem {
  /** 误差层级 */
  level: ErrorLevel
  /** 误差维度 */
  dim: ErrorDim
  /** 绝对偏差 px（dx/dy 为中心点偏移分量，dw/dh 为宽高偏差，均取绝对值） */
  deviation: { dx: number; dy: number; dw: number; dh: number }
  /** 归一化偏差量：位置 = hypot(dx,dy)；尺寸 = max(dw,dh) */
  delta: number
  /** delta / 容差（≥1 才生成条目） */
  ratio: number
  /** 严重度（ratio≥3 major / ≥2 minor / 其余 suggestion，与 StyleDiff 三档对齐） */
  severity: 'major' | 'minor' | 'suggestion'
  /** 判定：模块级超容差一律 absorbed（被模块层吸收，不扣分）；元素级超容差 reported */
  verdict: 'absorbed' | 'reported'
  /** 扣分值：absorbed 恒为 0；reported = weightLevel × weightDim × min(ratio,3) × 2 */
  score: number
  /** 自适应容器（宽/高≥240 或名含布局关键词）：跳过尺寸维 */
  adaptable: boolean
  node: {
    nodeKind: NodeKind
    designName: string
    figmaNodeId?: string
    domPath?: string
    /** DOM 节点相对视口的归一化坐标（与 StyleDiff.rect 同口径） */
    rect: { x: number; y: number; width: number; height: number }
  }
  /** 匹配置信度（透传 MatchPair.confidence） */
  confidence: number
  /** 自动生成的差异描述 */
  description: string
}

/** 分层旁路运行摘要（CompareResult.layered 字段类型） */
export interface LayeredRunSummary {
  enabled: boolean
  /** 分层还原度总分 0~100（100 − Σ reported 扣分，clamp 0） */
  score: number
  /** 模块级被吸收的超容差条目数 */
  moduleAbsorbed: number
  /** 元素级 reported 条目数 */
  elementReported: number
  items: LayeredErrorItem[]
}

/** ───────────── 设计规范 Token（解析入库 / 走查校验 / 多格式导出共用） ───────────── */

/** Token 类别（一期 7 类；组件基础属性二期扩展） */
export type TokenKind =
  | 'color'
  | 'spacing'
  | 'fontSize'
  | 'lineHeight'
  | 'radius'
  | 'shadow'
  | 'border'

/** Token 提取来源：Figma 变量 / Figma 样式 / 启发式图层扫描兜底 */
export type TokenSource = 'variable' | 'style' | 'heuristic'

/** 单层阴影（box-shadow 通用结构） */
export interface ShadowLayer {
  x: number
  y: number
  blur: number
  spread?: number
  /** hex 色值 */
  color: string
  inset?: boolean
}

/**
 * Token 值（JSON 序列化后存 specTokens.value）：
 * color 存 hex；尺寸类（间距/字号/行高/圆角）存 px 数值；阴影存多层结构；边框存宽/样式/色。
 * kind 与 SpecToken.kind 一致，用于反序列化后的判别。
 */
export type SpecTokenValue =
  | { kind: 'color'; hex: string }
  | { kind: 'spacing' | 'fontSize' | 'lineHeight' | 'radius'; value: number; unit: 'px' }
  | { kind: 'shadow'; layers: ShadowLayer[] }
  | { kind: 'border'; width: number; style: string; color: string }

/** 解析 specTokens.value 的 JSON 串（损坏数据返回 undefined 不阻塞） */
export function parseTokenValue(raw: string): SpecTokenValue | undefined {
  try {
    return JSON.parse(raw) as SpecTokenValue
  } catch {
    return undefined
  }
}

/** 对外标准 Token 类型（用户口径：color / dimension / radius / shadow / typography） */
export type TokenType = 'color' | 'dimension' | 'radius' | 'shadow' | 'typography'

/** 内部 7 类 kind → 对外 5 类 type（双口径并行：内部走查逻辑不变，对外展示/导出按此映射） */
export const TOKEN_KIND_TO_TYPE: Record<TokenKind, TokenType> = {
  color: 'color',
  spacing: 'dimension',
  fontSize: 'typography',
  lineHeight: 'typography',
  radius: 'radius',
  shadow: 'shadow',
  border: 'dimension'
}

/** 同步降级记录（解析预览面板展示：哪一级失败/为何降级，不再静默） */
export interface SpecDegradation {
  /** 失败的解析级别 */
  level: 'variable' | 'style' | 'heuristic'
  /** 失败原因（原始错误信息） */
  reason: string
  /** 用户可操作的补救建议（如切 JSON 导入） */
  hint?: string
}

/** 主进程 Token 解析产出行（spec:sync IPC 返回；渲染层入 specTokens 表时再序列化 value） */
export interface ParsedToken {
  kind: TokenKind
  /** Figma 原始变量名（variable.name 原样保留，绝不自动改名；标准化仅在开启开关时由调用方另行处理） */
  name: string
  /** 完整分组路径（变量集/文件夹层级，/ 分组，如 颜色/主色/品牌主色 前缀段） */
  path: string
  value: SpecTokenValue
  source: TokenSource
  description?: string
  /** Figma 原生 variable id（映射与回溯依据） */
  tokenId?: string
  /** Figma 完整原始变量名（含文件夹段，与 name 同源保留；扁平数据源时等于 name） */
  figmaName?: string
  /** 所属模式名称（浅色/深色/Light/Dark…），缺省为唯一/默认模式 */
  mode?: string
  /** 三层 Token 体系归属层（Primitive / Semantic / Component，保留 Figma 原始命名），单层体系缺省 */
  tier?: string
  /** 是否集合默认模式（旧数据兼容标记） */
  isDefaultMode?: boolean
  /** codeSyntax.WEB 等自动生成代码别名（独立字段，不覆盖 name） */
  rawCode?: string
  /** 对外标准类型（kind 的用户口径映射） */
  type?: TokenType
  /** 别名引用链原始文本（DTCG 为 {a.b.c} 去花括号原文；REST 为目标变量完整原始名），非引用 Token 缺省 */
  aliasRef?: string
}

/** spec:sync IPC 返回结构 */
export interface SpecSyncResult {
  ok: boolean
  message: string
  /** Figma 文件名（同步成功后回填 designSpecs.figFileName） */
  fileName?: string
  /** 实际命中的解析级别 */
  sourceLevel?: 'variable' | 'style' | 'heuristic'
  tokens?: ParsedToken[]
  /** 降级链路记录（预览面板透明展示，不再静默降级） */
  degraded?: SpecDegradation[]
  /** 变量级 403（PAT 无 file_variables:read，Enterprise 专属）：已中断不降级，待用户选择是否改同步样式 */
  variableDenied?: boolean
}

// ===== 自动走查会话 profile（登录态快照，按域名加密落盘） =====

/** Cookie 快照行（序列化自 Electron CookiesGetDetails，仅保留注入所需字段） */
export interface WalkSessionCookie {
  name: string
  value: string
  /** Cookie 归属域（带前导点表示子域共享），缺省为快照域名 */
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  /** 过期时间（Unix 秒）；会话 Cookie 缺省 */
  expirationDate?: number
  /** lax / strict / no_restriction / unspecified */
  sameSite?: string
}

/** indexedDB 对象仓库快照（best-effort，Blob/File 等不可序列化内容会跳过） */
export interface WalkSessionIdbStore {
  name: string
  /** 主键 keyPath（null = 行外主键，恢复时显式传 key） */
  keyPath: string | string[] | null
  autoIncrement: boolean
  indexes: { name: string; keyPath: string | string[]; unique: boolean }[]
  records: { key?: unknown; value: unknown }[]
}

/** 自动走查会话 profile：登录窗口命中「登录成功标识」后抓取的 webview 上下文 */
export interface WalkSessionProfile {
  /** 站点 origin（存储恢复的作用域） */
  origin: string
  /** 抓取时的目标 URL */
  targetUrl: string
  /** 域名（host[:port]） */
  domain: string
  /** 本域名使用的「登录成功标识」（下次登录窗口预填） */
  marker?: string
  cookies: WalkSessionCookie[]
  localStorage: Record<string, string>
  sessionStorage: Record<string, string>
  indexedDB: { name: string; version?: number; stores: WalkSessionIdbStore[] }[]
  /** 抓取时间（ms） */
  createdAt: number
}
