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
  a11y: false
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
    a11y: raw?.a11y === true
  }
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
