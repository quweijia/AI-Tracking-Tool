/**
 * Figma 设计变量 / Token JSON 统一解析（纯函数，主进程与渲染层共用）：
 * - expandFigmaVariables：REST Variables 端点数据 → 逐模式展开的 Token 行
 *   （name 取 variable.name 最后一段原始命名，path = 变量集 + 文件夹层级，多模式每模式一行）
 * - parseVariablesJson：JSON 文件导入兜底，兼容 Figma REST 同构 / Tokens Studio / W3C DTCG 嵌套格式
 * - parseVariablesJsonBundle：多文件一次导入（Primitive / Semantic / Component 三层 Token 体系），
 *   别名引用（{a.b}）跨文件/跨层自动解析，全程保留 Figma 原始命名与分组，不做自动改名。
 */
import type { ParsedToken, ShadowLayer, SpecTokenValue, TokenKind } from './types'
import { TOKEN_KIND_TO_TYPE } from './types'

/** Figma REST Variable（仅声明解析所需字段） */
export interface FigmaVariableInput {
  id: string
  /** 用户原始命名，原生含文件夹层级（/ 分隔），如 主色/品牌主色 */
  name: string
  resolvedType: 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN' | string
  description?: string
  variableCollectionId?: string
  /** modeId → 值（COLOR 对象 / FLOAT 数值 / VARIABLE_ALIAS 别名） */
  valuesByMode: Record<string, unknown>
  /** 平台代码别名（自动生成，仅存 rawCode 字段，绝不覆盖 name） */
  codeSyntax?: { WEB?: string; ANDROID?: string; iOS?: string }
}

/** Figma REST VariableCollection（变量集，含模式定义与文件夹上下文） */
export interface FigmaVariableCollectionInput {
  id: string
  name?: string
  defaultModeId?: string
  /** 集合内全部模式（浅色/深色…）；REST 实际字段为 modeId，兼容 id，缺失名时回退展示 modeId */
  modes?: { id?: string; modeId?: string; name?: string }[]
}

/** REST 端点与插件导出中，variables / variableCollections 可能是数组、也可能是以 id 为键的对象 */
export type FigmaVariablesPayload = FigmaVariableInput[] | Record<string, FigmaVariableInput>
export type FigmaCollectionsPayload = FigmaVariableCollectionInput[] | Record<string, FigmaVariableCollectionInput>

/** 数组 / id 键对象 → 统一转数组（Figma REST 返回的是以 id 为键的对象，需归一化后再遍历） */
export function coerceTokenArray<T extends object>(input: FigmaVariablesPayload | FigmaCollectionsPayload | null | undefined): T[] {
  if (!input || typeof input !== 'object') return []
  const list = Array.isArray(input) ? input : Object.values(input as Record<string, T>)
  return list.filter((x): x is T => !!x && typeof x === 'object')
}

/** Figma RGBA → 大写 hex（alpha < 1 时附 2 位透明度） */
export function rgbaToHex(c: { r: number; g: number; b: number; a?: number }): string {
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
  const base = `#${to(c.r)}${to(c.g)}${to(c.b)}`.toUpperCase()
  return c.a !== undefined && c.a < 1 ? `${base}${to(c.a)}`.toUpperCase() : base
}

export const round2 = (n: number) => Math.round(n * 100) / 100

/** ───────────── FLOAT 变量 → 数值 Token kind（按名/集合名关键词） ───────────── */

type FloatKind = 'spacing' | 'radius' | 'fontSize' | 'lineHeight'

const FLOAT_KIND_RULES: [RegExp, FloatKind][] = [
  [/radius|corner|圆角/i, 'radius'],
  [/line[-_ ]?height|行高/i, 'lineHeight'],
  [/font[-_ ]?size|text[-_ ]?size|字号/i, 'fontSize'],
  [/space|spacing|gap|padding|margin|inset|gutter|间距|间隔/i, 'spacing']
]

export function floatKindByName(name: string, collectionName = ''): FloatKind {
  for (const [re, kind] of FLOAT_KIND_RULES) if (re.test(name)) return kind
  for (const [re, kind] of FLOAT_KIND_RULES) if (re.test(collectionName)) return kind
  return 'spacing'
}

/** ───────────── 第一级：Figma Variables 展开（多模式逐行） ───────────── */

/**
 * Variables REST 数据 → Token 行：
 * - name：variable.name 最后一段（用户原始命名，不自动改名）
 * - path：变量集名 + 文件夹段（variable.name 的前缀段），如 颜色/主色
 * - 每个模式一行（mode=模式名，浅色/深色全量入库）；VARIABLE_ALIAS 别名跳过
 * - tokenId=原生 variable id；rawCode=codeSyntax 别名独立字段
 */
export function expandFigmaVariables(
  variables: FigmaVariablesPayload | null | undefined,
  collections: FigmaCollectionsPayload | null | undefined
): ParsedToken[] {
  const varList = coerceTokenArray<FigmaVariableInput>(variables)
  const varById = new Map(varList.map((v) => [v.id, v]))
  const colById = new Map(coerceTokenArray<FigmaVariableCollectionInput>(collections).map((c) => [c.id, c]))
  const out: ParsedToken[] = []
  /** 别名行（指向本文件其他变量），主循环结束后统一解引用；指向库变量（不在本文件）的保持跳过 */
  const pendingAliases: { v: FigmaVariableInput; modeId: string; aliasId: string }[] = []
  for (const v of varList) {
    const col = v.variableCollectionId ? colById.get(v.variableCollectionId) : undefined
    const rawSegs = v.name
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!rawSegs.length) continue
    const colName = col?.name?.trim() || 'variables'
    const rawNameSeg = rawSegs[rawSegs.length - 1]
    // 集合名命中三层体系层级（Primitives/Semantic/Components…）→ 作为 tier 并从 path 剥离，其余集合名仍作为 path 首段
    const tier = TIER_RE.test(colName) ? colName : undefined
    const rawPathSegs = [...(tier ? [] : [colName]), ...rawSegs.slice(0, -1)]
    const name = rawNameSeg
    const path = rawPathSegs.length ? rawPathSegs.join('/') : colName
    const modeNameOf = (modeId: string) =>
      col?.modes?.find((m) => (m.id ?? m.modeId) === modeId)?.name ?? modeId
    for (const [modeId, raw] of Object.entries(v.valuesByMode)) {
      if (raw === undefined || raw === null) continue
      // 别名引用（指向其他变量）：记录待解引用，不再直接跳过（Semantic 层引用 Primitive 层的典型三层结构）
      if (typeof raw === 'object' && (raw as { type?: string }).type === 'VARIABLE_ALIAS') {
        const aliasId = (raw as { id?: string }).id
        if (aliasId) pendingAliases.push({ v, modeId, aliasId })
        continue
      }
      const cell = concreteCell(v, raw, colName)
      if (!cell) continue // STRING/BOOLEAN（开关、文案类）暂不入库
      out.push({
        kind: cell.kind,
        name,
        path,
        value: cell.value,
        source: 'variable',
        description: v.description || undefined,
        tokenId: v.id,
        figmaName: v.name,
        mode: modeNameOf(modeId),
        tier,
        isDefaultMode: col?.defaultModeId ? modeId === col.defaultModeId : undefined,
        rawCode: v.codeSyntax?.WEB || v.codeSyntax?.iOS || v.codeSyntax?.ANDROID || undefined,
        type: TOKEN_KIND_TO_TYPE[cell.kind]
      })
    }
  }
  resolveRestAliases(pendingAliases, varById, colById, out)
  return out
}

/** 具体值 → Token 单元格；STRING/BOOLEAN 等不支持类型返回 null */
function concreteCell(
  v: FigmaVariableInput,
  raw: unknown,
  colName: string
): { kind: TokenKind; value: SpecTokenValue } | null {
  if (v.resolvedType === 'COLOR' && typeof raw === 'object') {
    const c = raw as { r: number; g: number; b: number; a?: number }
    if (c.r === undefined || c.g === undefined || c.b === undefined) return null
    return { kind: 'color', value: { kind: 'color', hex: rgbaToHex(c) } }
  }
  if (v.resolvedType === 'FLOAT' && typeof raw === 'number') {
    const kind = floatKindByName(v.name, colName)
    return { kind, value: { kind, value: round2(raw), unit: 'px' } }
  }
  return null
}

/**
 * REST VARIABLE_ALIAS 解引用（同文件内）：
 * - 别名行输出为「别名变量自身的命名/分组/tier + 目标变量解析出的值」（保留 Figma 原始命名）
 * - 模式对齐按模式名：目标集合找同名模式取值，无同名模式回退默认模式
 * - 链式引用逐层追踪（≤10 层防环）；目标不在本文件（库变量）跳过
 */
function resolveRestAliases(
  pending: { v: FigmaVariableInput; modeId: string; aliasId: string }[],
  varById: Map<string, FigmaVariableInput>,
  colById: Map<string, FigmaVariableCollectionInput>,
  out: ParsedToken[]
): void {
  for (const { v, modeId, aliasId } of pending) {
    const col = v.variableCollectionId ? colById.get(v.variableCollectionId) : undefined
    const modeName = col?.modes?.find((m) => (m.id ?? m.modeId) === modeId)?.name ?? modeId
    // 沿引用链追踪到具体值
    let cur = varById.get(aliasId)
    let cell: { kind: TokenKind; value: SpecTokenValue } | null = null
    for (let hop = 0; cur && hop < 10; hop++) {
      const curCol = cur.variableCollectionId ? colById.get(cur.variableCollectionId) : undefined
      const curColName = curCol?.name?.trim() || 'variables'
      // 目标变量取值模式：先按模式名对齐（跨集合模式 id 不同），无同名模式回退默认模式
      const curModeId =
        curCol?.modes?.find((m) => m.name === modeName && (m.id ?? m.modeId))?.id ??
        curCol?.modes?.find((m) => m.name === modeName && (m.id ?? m.modeId))?.modeId ??
        curCol?.defaultModeId ??
        Object.keys(cur.valuesByMode)[0]
      const raw = cur.valuesByMode?.[curModeId]
      if (raw === undefined || raw === null) break
      if (typeof raw === 'object' && (raw as { type?: string }).type === 'VARIABLE_ALIAS') {
        const nextId = (raw as { id?: string }).id
        if (!nextId) break
        cur = varById.get(nextId)
        continue
      }
      cell = concreteCell(cur, raw, curColName)
      break
    }
    if (!cell || !cur) continue // 指向库变量（不在本文件）或值类型不支持
    const rawSegs = v.name
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!rawSegs.length) continue
    const colName2 = col?.name?.trim() || 'variables'
    const tier = TIER_RE.test(colName2) ? colName2 : undefined
    const rawPathSegs = [...(tier ? [] : [colName2]), ...rawSegs.slice(0, -1)]
    out.push({
      kind: cell.kind,
      name: rawSegs[rawSegs.length - 1],
      path: rawPathSegs.length ? rawPathSegs.join('/') : colName2,
      value: cell.value,
      aliasRef: cur.name,
      source: 'variable',
      description: v.description || undefined,
      tokenId: v.id,
      figmaName: v.name,
      mode: modeName,
      tier,
      isDefaultMode: col?.defaultModeId ? modeId === col.defaultModeId : undefined,
      rawCode: v.codeSyntax?.WEB || v.codeSyntax?.iOS || v.codeSyntax?.ANDROID || undefined,
      type: TOKEN_KIND_TO_TYPE[cell.kind]
    })
  }
}

/** ───────────── JSON 文件导入（Tokens Studio / W3C DTCG / REST 同构） ───────────── */

/** 顶层 light/dark/浅色/深色 分段识别为模式 */
const MODE_TOP_RE = /^(light|dark|light-mode|dark-mode|lightmode|darkmode|浅色|深色|亮色|暗色)$/i

/**
 * 三层 Token 体系层级键识别（Primitive → Semantic → Component）：
 * 匹配集合名 / JSON 顶层键 / 导入文件名（宽容单复数与中英文），命中即作为 token 的 tier，
 * 并从分组 path 中剥离该段，避免与层级重复展示。
 */
const TIER_RE = /^(primitives?|semantics?|components?|globals?|基础|语义|组件)$/i

/** 待解析的 DTCG 别名引用（{a.b.c} 指向其他 token，常见于 Semantic / Component 层指向 Primitive 层） */
interface PendingAlias {
  /** 去掉花括号后的引用路径（. 分隔） */
  ref: string
  /** 自身原始命名 */
  key: string
  /** 自身分组路径段 */
  segs: string[]
  mode: string | undefined
  /** 自身所属三层体系层级（Primitive / Semantic / Component） */
  tier: string | undefined
  leaf: DtcgLeaf
}

/**
 * 解析单份 Token JSON 文本：
 * 格式一：Figma REST Variables 同构（meta.variables / 平铺 variables）
 * 格式二：Tokens Studio / W3C DTCG 嵌套树（value/$value + type/$type；别名引用收集到 pending 待跨文件解析）
 */
function parseOne(text: string): { tokens: ParsedToken[]; pending: PendingAlias[] } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('JSON 解析失败：文件不是合法的 JSON')
  }
  if (typeof data !== 'object' || data === null) throw new Error('JSON 内容为空或格式不正确')

  const rest = data as {
    meta?: { variables?: FigmaVariablesPayload; variableCollections?: FigmaCollectionsPayload }
    variables?: FigmaVariablesPayload
    variableCollections?: FigmaCollectionsPayload
  }
  const rawVars = rest.meta?.variables ?? rest.variables
  if (rawVars && typeof rawVars === 'object') {
    const varCount = (Array.isArray(rawVars) ? rawVars : Object.keys(rawVars)).length
    if (varCount > 0) {
      const tokens = expandFigmaVariables(rawVars, rest.meta?.variableCollections ?? rest.variableCollections)
      if (tokens.length) return { tokens, pending: [] }
      throw new Error(
        `识别到 ${varCount} 个 Figma 变量，但未解析出可用 Token：可能全部为别名引用（VARIABLE_ALIAS）或字符串/布尔类型变量`
      )
    }
  }
  const pending: PendingAlias[] = []
  return { tokens: parseDtcgTree(data as Record<string, unknown>, pending), pending }
}

/** 别名解析收尾：空结果统一报错（文案不变） */
function finishParsed(tokens: ParsedToken[], pending: PendingAlias[]): ParsedToken[] {
  resolveAliasTokens(tokens, pending)
  if (!tokens.length) {
    throw new Error(
      '未识别到任何 Token：支持 Figma Variables 导出格式（meta.variables / variables 键）与 Tokens Studio / W3C DTCG 嵌套格式（value/$value + type/$type），请确认导出的 JSON 文件内容'
    )
  }
  return tokens
}

/** 单文件导入 */
export function parseVariablesJson(text: string): ParsedToken[] {
  const { tokens, pending } = parseOne(text)
  return finishParsed(tokens, pending)
}

/**
 * 多文件一次导入（Primitive / Semantic / Component 三层 Token 体系）：
 * 逐文件解析后合并，别名引用（{a.b.c}）跨文件/跨层迭代解析，全程保留原始命名与分组。
 * 文件名命中层级键（如 Primitives.tokens.json → Primitives）且文件内未识别出层级时，作为该文件 tier 兜底。
 */
export function parseVariablesJsonBundle(entries: { text: string; name?: string }[]): ParsedToken[] {
  const tokens: ParsedToken[] = []
  const pending: PendingAlias[] = []
  for (const entry of entries) {
    const one = parseOne(entry.text)
    const fileName = (entry.name ?? '').replace(/\.json$/i, '').replace(/\.tokens$/i, '').trim()
    if (TIER_RE.test(fileName)) {
      const tier = fileName
      for (const t of one.tokens) if (!t.tier) t.tier = tier
      for (const p of one.pending) if (!p.tier) p.tier = tier
    }
    tokens.push(...one.tokens)
    pending.push(...one.pending)
  }
  return finishParsed(tokens, pending)
}

interface DtcgLeaf {
  value: unknown
  type?: string
  description?: string
  /** Figma 官方导出在 $extensions.com.figma.variableId 中带原生变量 id */
  tokenId?: string
}

/** 叶子节点识别：含 value/$value 键的对象；否则视为分组节点继续下钻 */
function readDtcgLeaf(rec: Record<string, unknown>): DtcgLeaf | null {
  if (!('value' in rec || '$value' in rec)) return null
  const desc = rec.$description ?? rec.description
  const ext = rec.$extensions as Record<string, unknown> | undefined
  return {
    value: rec.$value ?? rec.value,
    type: (rec.$type ?? rec.type) as string | undefined,
    description: typeof desc === 'string' ? desc : undefined,
    tokenId: typeof ext?.['com.figma.variableId'] === 'string' ? (ext['com.figma.variableId'] as string) : undefined
  }
}

/**
 * Figma 官方「导出变量 JSON」的结构化颜色对象：
 * { colorSpace: "srgb", components: [r,g,b 0..1], alpha: 0..1, hex: "#RRGGBB" }
 * 优先 hex + alpha 拼 8 位；无 hex 时用 components 换算。
 */
function parseFigmaColorObject(v: Record<string, unknown>): string | null {
  const alpha = typeof v.alpha === 'number' ? v.alpha : 1
  if (typeof v.hex === 'string') {
    const base = parseColorStr(v.hex)
    if (!base) return null
    if (alpha < 1) {
      const alphaHex = Math.round(alpha * 255)
        .toString(16)
        .padStart(2, '0')
        .toUpperCase()
      return `#${base.slice(1, 7)}${alphaHex}`
    }
    return base
  }
  const comps = v.components
  if (Array.isArray(comps) && comps.length >= 3 && comps.slice(0, 3).every((n) => typeof n === 'number')) {
    return rgbaToHex({ r: comps[0], g: comps[1], b: comps[2], a: alpha })
  }
  return null
}

function parseDtcgTree(root: Record<string, unknown>, pending: PendingAlias[]): ParsedToken[] {
  const out: ParsedToken[] = []
  // 模式分段识别：root 顶层（Light/Dark）或层级子层（{Primitive: {Light: …}}）均可
  const hasModeSplit =
    Object.keys(root).some((k) => MODE_TOP_RE.test(k.trim())) ||
    Object.entries(root).some(
      ([k, v]) =>
        !k.startsWith('$') &&
        TIER_RE.test(k.trim()) &&
        typeof v === 'object' &&
        v !== null &&
        Object.keys(v as Record<string, unknown>).some((kk) => MODE_TOP_RE.test(kk.trim()))
    )
  const walk = (node: Record<string, unknown>, segs: string[], mode: string | undefined, tier: string | undefined) => {
    for (const [key, val] of Object.entries(node)) {
      if (key.startsWith('$')) continue // $value/$type/$name 等元数据
      if (typeof val !== 'object' || val === null) continue
      const leaf = readDtcgLeaf(val as Record<string, unknown>)
      if (leaf) {
        emitDtcgLeaf(key, segs, mode, tier, leaf, out, pending)
      } else {
        const k = key.trim()
        // 仅顶层 light/dark/浅色/深色 分段视为模式（不进入分组路径），其余键作为分组层级
        const isModeTop = !mode && !tier && segs.length === 0 && hasModeSplit && MODE_TOP_RE.test(k)
        if (isModeTop) {
          walk(val as Record<string, unknown>, segs, k, tier)
          continue
        }
        // 顶层键命中三层体系层级（Primitive/Semantic/Component…）→ 作为 tier，不进入分组路径
        if (!tier && segs.length === 0 && TIER_RE.test(k)) {
          walk(val as Record<string, unknown>, segs, mode, k)
          continue
        }
        walk(val as Record<string, unknown>, [...segs, key], mode, tier)
      }
    }
  }
  walk(root, [], undefined, undefined)
  return out
}

/** "16px" / 16 / "16" → 数值（其余返回 undefined） */
function parsePxNum(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string') {
    const m = v.trim().match(/^(-?\d*\.?\d+)\s*px$/i) ?? v.trim().match(/^(-?\d*\.?\d+)$/)
    return m ? parseFloat(m[1]) : undefined
  }
  return undefined
}

function isColorLike(v: string): boolean {
  return /^#([0-9a-f]{3,8})$/i.test(v.trim()) || /^rgba?\(/i.test(v.trim())
}

/** hex / rgb() / rgba() → 统一大写 hex（8 位含透明度） */
function parseColorStr(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  const hex = s.match(/^#([0-9a-f]{3,8})$/i)
  if (hex) {
    let h = hex[1]
    if (h.length === 3) h = [...h].map((c) => c + c).join('')
    if (h.length !== 6 && h.length !== 8) return null
    return `#${h.toUpperCase()}`
  }
  const rgb = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i)
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4])
    return rgbaToHex({ r: parseFloat(rgb[1]) / 255, g: parseFloat(rgb[2]) / 255, b: parseFloat(rgb[3]) / 255, a })
  }
  return null
}

/** DTCG 阴影（单层对象或数组）→ ShadowLayer[] */
function parseShadowLayers(v: unknown): ShadowLayer[] | null {
  const arr = Array.isArray(v) ? v : [v]
  const layers: ShadowLayer[] = []
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) return null
    const o = item as Record<string, unknown>
    const x = parsePxNum(o.offsetX ?? o.x)
    const y = parsePxNum(o.offsetY ?? o.y)
    const blur = parsePxNum(o.blur ?? o.radius)
    const spread = parsePxNum(o.spread)
    const color = parseColorStr(o.color)
    if (x === undefined || y === undefined || blur === undefined || !color) return null
    layers.push({ x: round2(x), y: round2(y), blur: round2(blur), spread: spread !== undefined ? round2(spread) : undefined, color, inset: o.inset === true || undefined })
  }
  return layers.length ? layers : null
}

/** DTCG 边框复合值 {width, style, color} */
function parseBorderValue(v: unknown): { width: number; style: string; color: string } | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const width = parsePxNum(o.width)
  const color = parseColorStr(o.color)
  if (width === undefined || !color) return null
  return { width: round2(width), style: typeof o.style === 'string' ? o.style : 'solid', color }
}

/** 叶子 → Token 行（typography 复合展开为 name.fontSize / name.lineHeight 两条） */
function emitDtcgLeaf(
  key: string,
  segs: string[],
  mode: string | undefined,
  tier: string | undefined,
  leaf: DtcgLeaf,
  out: ParsedToken[],
  pending: PendingAlias[]
): void {
  // 别名引用（{a.b.c} 指向其他 token）收集待解析：Semantic / Component 层指向 Primitive 层，跨文件迭代求值
  const trimmed = typeof leaf.value === 'string' ? leaf.value.trim() : ''
  if (/^\{.+\}$/.test(trimmed)) {
    pending.push({ ref: trimmed.slice(1, -1), key, segs, mode, tier, leaf })
    return
  }
  const v = leaf.value
  const tn = leaf.type?.toLowerCase()
  const rawName = segs.length ? `${segs.join('/')}/${key}` : key
  const name = key
  const path = segs.join('/')
  const push = (suffix: string | null, kind: TokenKind, value: SpecTokenValue) => {
    out.push({
      kind,
      name: suffix ? `${name}.${suffix}` : name,
      path,
      value,
      source: 'variable',
      description: leaf.description,
      tokenId: leaf.tokenId,
      figmaName: rawName,
      mode,
      tier,
      type: TOKEN_KIND_TO_TYPE[kind]
    })
  }

  // typography 复合：{fontSize, lineHeight, …} → 拆两条数值 Token（无单位小数行高视为比例，跳过）
  if (tn === 'typography' && typeof v === 'object' && v !== null) {
    const tv = v as Record<string, unknown>
    const fs = parsePxNum(tv.fontSize)
    if (fs !== undefined) push('fontSize', 'fontSize', { kind: 'fontSize', value: round2(fs), unit: 'px' })
    const lh = parsePxNum(tv.lineHeight)
    if (lh !== undefined && (typeof tv.lineHeight === 'string' || lh >= 8))
      push('lineHeight', 'lineHeight', { kind: 'lineHeight', value: round2(lh), unit: 'px' })
    return
  }
  // boxShadow 复合：单层或数组
  if (tn === 'boxshadow' || tn === 'othershadow' || tn === 'shadow') {
    const layers = parseShadowLayers(v)
    if (layers) push(null, 'shadow', { kind: 'shadow', layers })
    return
  }
  // border 复合：{width, style, color}
  if (tn === 'border') {
    const b = parseBorderValue(v)
    if (b) push(null, 'border', { kind: 'border', ...b })
    return
  }
  // 颜色：显式 type 或无 type 的颜色样式字符串；Figma 官方导出的结构化颜色对象（{components, alpha, hex}）
  if (tn === 'color' || (!tn && typeof v === 'string' && isColorLike(v))) {
    const hex =
      typeof v === 'string'
        ? parseColorStr(v)
        : typeof v === 'object' && v !== null
          ? parseFigmaColorObject(v as Record<string, unknown>)
          : null
    if (hex) push(null, 'color', { kind: 'color', hex })
    return
  }
  // 数值类：显式类型优先，其余 dimension/sizing/number 按命名关键词推断
  const n = parsePxNum(v)
  if (n === undefined || n < 0) return
  let kind: TokenKind
  if (tn === 'borderradius' || tn === 'radius') kind = 'radius'
  else if (tn === 'fontsize' || tn === 'fontsizes') kind = 'fontSize'
  else if (tn === 'lineheight' || tn === 'lineheights') kind = 'lineHeight'
  else kind = floatKindByName(key, segs[segs.length - 1] ?? '')
  push(null, kind, { kind, value: round2(n), unit: 'px' })
}

/**
 * 跨文件/跨层解析别名引用（迭代 ≤10 轮，支持 Semantic→Primitive 链式引用）：
 * 命中目标后沿用其 kind/value/type，但保留自身的原始命名/分组/模式/描述。
 * 匹配顺序：完整路径（'.'→'/'，对应 path/name）→ 引用首段为模式名（Light/Dark）时去段重试 → 末段名匹配；同模式优先。
 */
function resolveAliasTokens(out: ParsedToken[], pending: PendingAlias[]): void {
  for (let round = 0; round < 10 && pending.length; round++) {
    const byFull = new Map<string, ParsedToken[]>()
    const byName = new Map<string, ParsedToken[]>()
    const addTo = (m: Map<string, ParsedToken[]>, k: string, t: ParsedToken) => {
      const list = m.get(k)
      if (list) list.push(t)
      else m.set(k, [t])
    }
    for (const t of out) {
      addTo(byFull, `${t.path}/${t.name}`, t)
      if (t.tier) addTo(byFull, `${t.tier}/${t.path}/${t.name}`, t) // 引用带层级前缀（{Primitives.color.blue}）时精确命中
      addTo(byName, t.name, t)
    }
    const rest: PendingAlias[] = []
    let progressed = false
    for (const p of pending) {
      const refSegs = p.ref
        .split('.')
        .map((s) => s.trim())
        .filter(Boolean)
      const pick = (list: ParsedToken[] | undefined): ParsedToken | undefined =>
        list && list.length ? (list.find((t) => t.mode === p.mode) ?? list[0]) : undefined
      // 候选完整路径：{Light.Primitives.color.blue} → 去首段模式名重试 Primitives/color/blue
      const fullKeys: string[] = []
      if (refSegs.length > 1 && MODE_TOP_RE.test(refSegs[0])) fullKeys.push(refSegs.slice(1).join('/'))
      fullKeys.push(refSegs.join('/'))
      let target: ParsedToken | undefined
      for (const k of fullKeys) {
        target = pick(byFull.get(k))
        if (target) break
      }
      if (!target && refSegs.length) target = pick(byName.get(refSegs[refSegs.length - 1]))
      if (!target) {
        rest.push(p) // 目标尚未解析（可能是链式别名），留待下一轮
        continue
      }
      out.push({
        kind: target.kind,
        name: p.key,
        path: p.segs.join('/'),
        value: target.value,
        aliasRef: p.ref,
        source: 'variable',
        description: p.leaf.description,
        tokenId: p.leaf.tokenId,
        figmaName: p.segs.length ? `${p.segs.join('/')}/${p.key}` : p.key,
        mode: p.mode,
        tier: p.tier,
        type: target.type ?? TOKEN_KIND_TO_TYPE[target.kind]
      })
      progressed = true
    }
    pending.length = 0
    pending.push(...rest)
    if (!progressed) break // 剩余引用无新增命中（目标缺失），停止迭代
  }
}
