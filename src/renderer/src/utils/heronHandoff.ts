/**
 * Heron Handoff（figmacn Figma 标注插件）导出包解析器（零依赖，纯 renderer 侧）：
 * - 原生 DecompressionStream('deflate-raw') 轻量解压 zip（包内中文文件名为 GBK，需还原）
 * - 从 index.html 头部 <script> 括号配平提取内嵌变量 PAGED_FRAMES / FILE_DATA / SETTINGS
 * - FILE_DATA 为 Figma 原始图层树 → 按 main/figma.ts walkNode 同口径归一化为 StyleNode
 * - 配套画板底图取 data/{frameId}.png（':' → '-'）
 * 不落盘、不改包内容；解析失败抛 HeronParseError（按 code 映射 i18n 文案）。
 */
import type { StyleNode } from '../../../shared/types'
import { figmaColorToHex } from '../../../shared/color'

/* ===== 错误码与异常类型 ===== */

export type HeronErrorCode = 'bad-zip' | 'not-heron' | 'no-frame' | 'png-missing'

export class HeronParseError extends Error {
  readonly code: HeronErrorCode
  constructor(code: HeronErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'HeronParseError'
    this.code = code
  }
}

/* ===== 包结构与画板数据 ===== */

/** 包内可选中的画板（按页面分组展平后的条目） */
export interface HeronFrameOption {
  id: string
  name: string
  pageId: string
  pageName: string
}

/** 解析后的标注包（zip 条目 + 内嵌元数据） */
export interface HeronPackage {
  /** zip 内全部文件条目（key 为包内路径） */
  files: Map<string, Uint8Array>
  /** PAGED_FRAMES 展平出的画板列表（非空） */
  frames: HeronFrameOption[]
  /** SETTINGS（可选，含 resolution 缩放倍率） */
  settings: Record<string, unknown>
  /** FILE_DATA.document：Figma 原始图层树根 */
  document: RawNode
}

/** 单个画板的提取结果：底图 + 归一化图层树 + 1x 逻辑尺寸 */
export interface HeronFrameData {
  /** 画板底图 PNG 字节（data/{frameId}.png） */
  png: ArrayBuffer
  /** 该画板子树归一化 StyleNode（坐标相对画板原点） */
  designRoot: StyleNode
  /** 画板 1x 逻辑尺寸 */
  frameSize: { width: number; height: number }
  /** 超限跳过的节点数 */
  skippedCount: number
}

/* ===== 插件导出 JSON 原始结构（宽松，仅声明用到的字段） ===== */

interface RawPaint {
  type: string
  visible?: boolean
  opacity?: number
  color?: { r: number; g: number; b: number; a?: number }
}

interface RawEffect {
  type: string
  visible?: boolean
  offset?: { x: number; y: number }
  radius?: number
  spread?: number
  color?: { r: number; g: number; b: number; a?: number }
}

interface RawTypeStyle {
  fontFamily?: string
  /** 插件导出为字符串（"medium"），REST API 为数字，两者兼容 */
  fontWeight?: number | string
  fontSize?: number
  /** REST 口径行高 px */
  lineHeightPx?: number
  /** 插件口径：数值 + 单位字段（仅 PIXELS 应用） */
  lineHeight?: number
  lineHeightUnit?: string
  /** 插件口径：数值 + 单位字段（仅 PIXELS 应用） */
  letterSpacing?: number
  letterSpacingUnit?: string
  textAlignHorizontal?: string
}

interface RawNode {
  id: string
  name: string
  type: string
  visible?: boolean
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null
  fills?: RawPaint[]
  strokes?: RawPaint[]
  strokeWeight?: number
  effects?: RawEffect[]
  cornerRadius?: number
  rectangleCornerRadii?: number[]
  itemSpacing?: number
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL'
  /** auto-layout 水平尺寸模式：FIXED / HUG / FILL */
  layoutSizingHorizontal?: string
  /** 文本自适应模式：NONE / HEIGHT / WIDTH_AND_HEIGHT / TRUNCATE */
  textAutoResize?: string
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  opacity?: number
  characters?: string
  style?: RawTypeStyle
  children?: RawNode[]
}

/** PAGED_FRAMES：页面 → 画板列表 */
interface PagedFrames {
  [pageId: string]: { name?: string; frames?: { id: string; name?: string }[] }
}

/* ===== 基础辅助 ===== */

const round2 = (v: number): number => Math.round(v * 100) / 100

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}

/** GBK 解码器懒加载（插件导出包的中文文件名为 GBK 编码）；环境不支持时退回 UTF-8 */
let gbkDecoder: TextDecoder | null | undefined
function decodeGbk(bytes: Uint8Array): string {
  if (gbkDecoder === undefined) {
    try {
      gbkDecoder = new TextDecoder('gbk')
    } catch {
      gbkDecoder = null
    }
  }
  return (gbkDecoder ?? new TextDecoder()).decode(bytes)
}

/** deflate-raw 解压（浏览器原生流式 API，零依赖） */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(toArrayBuffer(bytes)).body
  if (!stream) throw new HeronParseError('bad-zip')
  const out = await new Response(stream.pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()
  return new Uint8Array(out)
}

/* ===== 轻量 zip 读取器（EOCD 尾部扫描 + 中央目录遍历） ===== */

async function unzipEntries(data: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const view = new DataView(data)
  const len = data.byteLength
  if (len < 22) throw new HeronParseError('bad-zip')

  // 1. 从尾部扫描 EOCD（0x06054b50），兼容最长 65535 字节的 zip 注释区
  let eocd = -1
  const scanStart = Math.max(0, len - 22 - 65535)
  for (let i = len - 22; i >= scanStart; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new HeronParseError('bad-zip')

  const entryCount = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)

  // 2. 遍历中央目录（每条固定头 46 字节 + 可变三段）
  const files = new Map<string, Uint8Array>()
  let cd = cdOffset
  for (let n = 0; n < entryCount; n++) {
    if (cd + 46 > len || view.getUint32(cd, true) !== 0x02014b50) break
    const flags = view.getUint16(cd + 8, true)
    const method = view.getUint16(cd + 10, true)
    const compSize = view.getUint32(cd + 20, true)
    const nameLen = view.getUint16(cd + 28, true)
    const extraLen = view.getUint16(cd + 30, true)
    const cmtLen = view.getUint16(cd + 32, true)
    const localOffset = view.getUint32(cd + 42, true)
    const nameBytes = new Uint8Array(data, cd + 46, nameLen)
    // UTF-8 标志位 0x800 决定文件名编码：置位 UTF-8，否则按插件包实际情况还原 GBK
    const name = flags & 0x800 ? new TextDecoder().decode(nameBytes) : decodeGbk(nameBytes)
    cd += 46 + nameLen + extraLen + cmtLen
    if (name.endsWith('/')) continue // 目录条目跳过

    // 3. 本地文件头校验：数据起点 = localOffset + 30 + 本地名长 + 本地 extra 长
    if (localOffset + 30 > len || view.getUint32(localOffset, true) !== 0x04034b50) continue
    const lNameLen = view.getUint16(localOffset + 26, true)
    const lExtraLen = view.getUint16(localOffset + 28, true)
    const start = localOffset + 30 + lNameLen + lExtraLen
    const end = start + compSize
    if (end > len) continue
    const comp = new Uint8Array(data, start, compSize)
    let bytes: Uint8Array
    if (method === 8) bytes = await inflateRaw(comp)
    else if (method === 0) bytes = comp.slice() // stored：直接切片拷贝
    else continue // 其他压缩方法不支持，跳过
    files.set(name, bytes)
  }
  if (!files.size) throw new HeronParseError('bad-zip')
  return files
}

/** 按包内路径取文件：先精确匹配 key，未命中则兼容「顶层文件夹包」匹配路径后缀 */
function findEntry(files: Map<string, Uint8Array>, path: string): Uint8Array | undefined {
  const hit = files.get(path)
  if (hit) return hit
  const suffix = '/' + path
  for (const [key, bytes] of files) {
    if (key.endsWith(suffix)) return bytes
  }
  return undefined
}

/* ===== index.html 内嵌变量提取（定位赋值 + 括号配平 + JSON.parse） ===== */

/** 定位 `NAME =` 赋值位置，返回值起点；前字符属标识符成分则跳过（防更长标识符子串误命中） */
function locateAssignment(html: string, name: string): number {
  const re = new RegExp(`${name}\\s*=`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const prev = m.index > 0 ? html[m.index - 1] : ''
    if (/[\w$.]/.test(prev)) continue
    return m.index + m[0].length
  }
  return -1
}

/** 从 start 起（跳过空白）用双引号字符串转义感知的花括号配平，截出完整 JSON 对象文本 */
function balanceObject(html: string, start: number): string | null {
  let i = start
  while (i < html.length && /\s/.test(html[i])) i++
  if (html[i] !== '{') return null
  const begin = i
  let depth = 0
  let inStr = false
  for (; i < html.length; i++) {
    const ch = html[i]
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return html.slice(begin, i + 1)
    }
  }
  return null
}

function extractVar<T>(html: string, name: string): T {
  const pos = locateAssignment(html, name)
  if (pos < 0) throw new HeronParseError('not-heron')
  const raw = balanceObject(html, pos)
  if (!raw) throw new HeronParseError('not-heron')
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new HeronParseError('not-heron')
  }
}

/* ===== FILE_DATA → StyleNode 归一化（与 main/figma.ts walkNode 同口径） ===== */

const MAX_NODES = 1500
const MAX_DEPTH = 12

const normType = (t: string): StyleNode['type'] => {
  switch (t) {
    case 'TEXT':
      return 'text'
    case 'GROUP':
      return 'group'
    case 'RECTANGLE':
      return 'rect'
    case 'ELLIPSE':
      return 'ellipse'
    case 'COMPONENT':
    case 'COMPONENT_SET':
    case 'INSTANCE':
      return 'component'
    default:
      return 'frame'
  }
}

/** 跳过无视觉意义的节点类型（矢量路径、切片、辅助线等），与 walkNode 一致 */
const SKIPPED_TYPES = new Set(['VECTOR', 'LINE', 'SLICE', 'GUIDE', 'BOOLEAN_OPERATION', 'STAR', 'REGULAR_POLYGON'])

function firstSolidHex(paints: RawPaint[] | undefined): string | null {
  const paint = paints?.find((p) => p.type === 'SOLID' && p.visible !== false && p.color)
  return paint ? figmaColorToHex(paint.color, paint.opacity ?? 1) : null
}

function effectsToCss(effects: RawEffect[] | undefined): string | undefined {
  const shadows = (effects ?? []).filter((e) => e.type === 'DROP_SHADOW' && e.visible !== false && e.color)
  if (!shadows.length) return undefined
  return shadows
    .map((e) => {
      const { r, g, b } = e.color!
      const a = Math.round(((e.color as { a?: number }).a ?? 1) * 100) / 100
      return `${Math.round(e.offset?.x ?? 0)}px ${Math.round(e.offset?.y ?? 0)}px ${Math.round(e.radius ?? 0)}px ${Math.round(e.spread ?? 0)}px rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`
    })
    .join(', ')
}

/** 字重归一化：插件导出为命名字符串（"medium"），REST 为数字；两者兼容 */
const FONT_WEIGHT_MAP: Record<string, number> = {
  thin: 100,
  extralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
  heavy: 900
}

function normFontWeight(w: unknown): number | undefined {
  if (typeof w === 'number' && Number.isFinite(w)) {
    return Math.min(1000, Math.max(100, Math.round(w)))
  }
  if (typeof w === 'string') {
    const key = w.trim().toLowerCase().replace(/[\s-]/g, '')
    if (/^\d+$/.test(key)) {
      const n = Number(key)
      return Number.isFinite(n) ? Math.min(1000, Math.max(100, Math.round(n))) : undefined
    }
    return FONT_WEIGHT_MAP[key]
  }
  return undefined
}

/** 插件口径的长度字段（lineHeight / letterSpacing）：仅 unit 缺省或 PIXELS 时应用 */
function normLengthPx(value: unknown, unit: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (unit !== undefined && unit !== null && String(unit).toUpperCase() !== 'PIXELS') return undefined
  return round2(value)
}

/** Figma 原始图层树 → 归一化 StyleNode 树（坐标转为相对根画板），口径与 main/figma.ts walkNode 一致 */
function toStyleNode(
  node: RawNode,
  origin: { x: number; y: number },
  depth: number,
  out: StyleNode[],
  counter: { skipped: number }
): StyleNode | null {
  if (node.visible === false || SKIPPED_TYPES.has(node.type)) return null
  const bbox = node.absoluteBoundingBox
  if (!bbox) return null

  const style: StyleNode = {
    id: node.id,
    name: node.name,
    type: normType(node.type),
    x: round2(bbox.x - origin.x),
    y: round2(bbox.y - origin.y),
    width: round2(bbox.width),
    height: round2(bbox.height),
    figmaNodeId: node.id
  }

  const fill = firstSolidHex(node.fills)
  if (fill) style.fill = fill
  if (node.type === 'TEXT') {
    style.textColor = fill ?? undefined
    if (style.textColor) delete style.fill
    style.text = (node.characters ?? '').slice(0, 200)
    const st = node.style
    if (st?.fontSize) style.fontSize = st.fontSize
    const weight = normFontWeight(st?.fontWeight)
    if (weight) style.fontWeight = weight
    if (st?.fontFamily) style.fontFamily = st.fontFamily
    // 行高：REST 口径 lineHeightPx 优先；插件口径 lineHeight + lineHeightUnit 兜底
    const lineHeight = st?.lineHeightPx ?? normLengthPx(st?.lineHeight, st?.lineHeightUnit)
    if (lineHeight) style.lineHeight = lineHeight
    const letterSpacing = normLengthPx(st?.letterSpacing, st?.letterSpacingUnit)
    if (letterSpacing) style.letterSpacing = letterSpacing
    if (st?.textAlignHorizontal && st.textAlignHorizontal !== 'LEFT') style.textAlign = st.textAlignHorizontal.toLowerCase()
  }
  // 圆角：单值或 4 角
  if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
    style.borderRadius = [node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius]
  } else if (node.rectangleCornerRadii?.some((r) => r > 0)) {
    style.borderRadius = node.rectangleCornerRadii
  }
  const stroke = firstSolidHex(node.strokes)
  if (stroke && (node.strokeWeight ?? 0) > 0) {
    style.borderWidth = round2(node.strokeWeight!)
    style.borderColor = stroke
  }
  const shadow = effectsToCss(node.effects)
  if (shadow) style.boxShadow = shadow
  if (node.layoutMode && node.layoutMode !== 'NONE') {
    if (typeof node.itemSpacing === 'number' && node.itemSpacing > 0) style.gap = node.itemSpacing
    const pad = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft]
    if (pad.some((v) => typeof v === 'number' && v > 0)) {
      style.paddingTop = node.paddingTop || 0
      style.paddingRight = node.paddingRight || 0
      style.paddingBottom = node.paddingBottom || 0
      style.paddingLeft = node.paddingLeft || 0
    }
  }
  // 宽度自适应（Hug）：auto-layout 容器 HUG 或文本 WIDTH_AND_HEIGHT（hug 文本宽度比对用）
  if (
    node.layoutSizingHorizontal === 'HUG' ||
    (node.type === 'TEXT' && node.textAutoResize === 'WIDTH_AND_HEIGHT')
  ) {
    style.hugWidth = true
  }
  if (typeof node.opacity === 'number' && node.opacity < 1) style.opacity = round2(node.opacity)
  // 匹配主色：文本取文字色，其余取背景填充
  style.dominantColor = style.fill ?? style.textColor
  if (style.width > 0 && style.height > 0) {
    style.aspectRatio = Math.round((style.width / style.height) * 1000) / 1000
  }

  out.push(style)
  if (out.length > MAX_NODES || depth >= MAX_DEPTH) {
    counter.skipped++
    return style
  }
  if (node.children?.length) {
    const children: StyleNode[] = []
    for (const child of node.children) {
      const c = toStyleNode(child, origin, depth + 1, out, counter)
      if (c) children.push(c)
    }
    if (children.length) style.children = children
  }
  return style
}

/* ===== 对外主入口 ===== */

/** 解析 Heron Handoff 导出包：解压 → 读 index.html → 提取三变量 → 展平画板列表 */
export async function parseHeronZip(data: ArrayBuffer): Promise<HeronPackage> {
  const files = await unzipEntries(data)

  const htmlBytes = findEntry(files, 'index.html')
  if (!htmlBytes) throw new HeronParseError('not-heron')
  const html = new TextDecoder().decode(htmlBytes)

  const pagedFrames = extractVar<PagedFrames>(html, 'PAGED_FRAMES')
  const fileData = extractVar<{ document?: RawNode }>(html, 'FILE_DATA')
  if (!fileData?.document) throw new HeronParseError('not-heron')
  let settings: Record<string, unknown> = {}
  try {
    settings = extractVar<Record<string, unknown>>(html, 'SETTINGS')
  } catch {
    // SETTINGS 可选，缺省不阻断
  }

  // PAGED_FRAMES 展平为「页面 → 画板」列表
  const frames: HeronFrameOption[] = []
  for (const [pageId, page] of Object.entries(pagedFrames)) {
    for (const f of page?.frames ?? []) {
      if (!f?.id) continue
      frames.push({ id: f.id, name: f.name ?? f.id, pageId, pageName: page?.name ?? pageId })
    }
  }
  if (!frames.length) throw new HeronParseError('not-heron')

  return { files, frames, settings, document: fileData.document }
}

/** 提取指定画板：data/{frameId}.png 底图 + 该画板子树归一化 StyleNode */
export function extractHeronFrame(pkg: HeronPackage, frameId: string): HeronFrameData {
  // DFS 在图层树中定位该画板节点
  const raw = (() => {
    const stack: RawNode[] = [pkg.document]
    while (stack.length) {
      const cur = stack.pop()!
      if (cur.id === frameId) return cur
      if (cur.children?.length) stack.push(...cur.children)
    }
    return null
  })()
  if (!raw?.absoluteBoundingBox) throw new HeronParseError('no-frame')

  // 底图：插件导出把 ':' 转为 '-' 作为文件名
  const pngBytes = findEntry(pkg.files, `data/${frameId.replace(/:/g, '-')}.png`)
  if (!pngBytes) throw new HeronParseError('png-missing')

  const origin = { x: raw.absoluteBoundingBox.x, y: raw.absoluteBoundingBox.y }
  const nodes: StyleNode[] = []
  const counter = { skipped: 0 }
  const designRoot = toStyleNode(raw, origin, 0, nodes, counter)
  if (!designRoot) throw new HeronParseError('no-frame')

  return {
    png: toArrayBuffer(pngBytes),
    designRoot,
    frameSize: { width: round2(raw.absoluteBoundingBox.width), height: round2(raw.absoluteBoundingBox.height) },
    skippedCount: counter.skipped
  }
}
