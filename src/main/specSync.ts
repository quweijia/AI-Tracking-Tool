import { extractFigmaFileKey } from '../shared/figmaUrl'
import type {
  ParsedToken,
  ShadowLayer,
  SpecDegradation,
  SpecSyncResult,
  SpecTokenValue,
  TokenKind
} from '../shared/types'
import { expandFigmaVariables, rgbaToHex, round2 } from '../shared/variablesImport'
import type { FigmaCollectionsPayload, FigmaVariablesPayload } from '../shared/variablesImport'
import { figmaApi } from './figma'

/**
 * 设计规范 Token 三级解析（Variables → Styles → 启发式）：
 * 上一级不可用或结果为空时自动降级，全链路只读 Figma REST。
 * 同步编排（版本追加/入库）由渲染层完成，本模块只负责「链接 → Token 列表」。
 */

/** ───────────── 第一级：Figma Variables（颜色 + 数值变量，多模式全量展开） ───────────── */

/**
 * 解析 Variables 端点；无权限/无数据返回空数组（交由调用方降级并记录原因）。
 * local（文件本地变量）优先；失败或为空（如变量来自已发布组件库）时再试 published。
 * 命名/分组/模式展开统一交给共享模块 expandFigmaVariables：
 * - name 取 variable.name 最后一段原始命名（不自动改名/转驼峰）
 * - path = 变量集 + 文件夹层级（完整 namespace）
 * - 每模式一行（浅色/深色全量），tokenId/rawCode 独立字段
 */
async function parseVariables(fileKey: string, pat: string): Promise<ParsedToken[]> {
  let lastErr: unknown
  for (const endpoint of ['local', 'published'] as const) {
    try {
      const res = await figmaApi<{
        meta?: { variables?: FigmaVariablesPayload; variableCollections?: FigmaCollectionsPayload }
      }>(`/files/${fileKey}/variables/${endpoint}`, pat)
      const tokens = expandFigmaVariables(res.meta?.variables, res.meta?.variableCollections)
      if (tokens.length) return tokens
    } catch (err) {
      lastErr = err
    }
  }
  if (lastErr) throw lastErr
  return []
}

/** ───────────── 第二级：Paint/Text/Effect Styles ───────────── */

interface FigmaStyleMeta {
  key: string
  name: string
  description?: string
  styleType: 'FILL' | 'TEXT' | 'EFFECT' | 'GRID' | string
}

interface FigmaStyleDoc {
  fills?: { type: string; visible?: boolean; color?: { r: number; g: number; b: number; a?: number } }[]
  style?: { fontSize?: number; lineHeightPx?: number }
  effects?: {
    type: string
    visible?: boolean
    offset?: { x: number; y: number }
    radius?: number
    spread?: number
    color?: { r: number; g: number; b: number; a?: number }
  }[]
}

/** 限并发拉取样式详情（Figma 限流保护） */
async function fetchAllStyleDocs(keys: string[], pat: string): Promise<(FigmaStyleDoc | null)[]> {
  const out: (FigmaStyleDoc | null)[] = new Array(keys.length).fill(null)
  const BATCH = 6
  for (let i = 0; i < keys.length; i += BATCH) {
    const slice = keys.slice(i, i + BATCH)
    const docs = await Promise.all(
      slice.map(async (k) => {
        try {
          const res = await figmaApi<{ meta?: { document?: FigmaStyleDoc } }>(`/styles/${k}`, pat)
          return res.meta?.document ?? null
        } catch {
          return null // 单个样式拉取失败不影响整体
        }
      })
    )
    docs.forEach((d, j) => (out[i + j] = d))
  }
  return out
}

/** 解析 Styles 端点；无权限/无数据返回空数组（交由调用方降级） */
async function parseStyles(fileKey: string, pat: string): Promise<ParsedToken[]> {
  const res = await figmaApi<{ meta?: { styles?: FigmaStyleMeta[] } }>(`/files/${fileKey}/styles`, pat)
  const metas = (res.meta?.styles ?? []).filter((s) => s.styleType !== 'GRID')
  if (!metas.length) return []
  const docs = await fetchAllStyleDocs(
    metas.map((s) => s.key),
    pat
  )
  const out: ParsedToken[] = []
  metas.forEach((meta, i) => {
    const doc = docs[i]
    if (!doc) return
    // 颜色样式：取首个可见纯色填充
    const solid = doc.fills?.find((f) => f.visible !== false && f.type === 'SOLID' && f.color)
    if (solid?.color) {
      out.push({
        kind: 'color',
        name: meta.name,
        path: meta.name,
        value: { kind: 'color', hex: rgbaToHex(solid.color) },
        source: 'style',
        description: meta.description || undefined
      })
    }
    // 文字样式：拆出字号与行高两个 Token
    const ts = doc.style
    if (ts?.fontSize && ts.fontSize > 0) {
      out.push({
        kind: 'fontSize',
        name: `${meta.name}/fontSize`,
        path: `${meta.name}/fontSize`,
        value: { kind: 'fontSize', value: round2(ts.fontSize), unit: 'px' },
        source: 'style',
        description: meta.description || undefined
      })
    }
    if (ts?.lineHeightPx && ts.lineHeightPx > 0) {
      out.push({
        kind: 'lineHeight',
        name: `${meta.name}/lineHeight`,
        path: `${meta.name}/lineHeight`,
        value: { kind: 'lineHeight', value: round2(ts.lineHeightPx), unit: 'px' },
        source: 'style'
      })
    }
    // 效果样式：可见投影/内阴影 → 阴影 Token（多层叠加）
    const layers: ShadowLayer[] = (doc.effects ?? [])
      .filter((e) => e.visible !== false && e.type !== 'LAYER_BLUR' && e.color)
      .map((e) => ({
        x: round2(e.offset?.x ?? 0),
        y: round2(e.offset?.y ?? 0),
        blur: round2(e.radius ?? 0),
        spread: e.spread !== undefined ? round2(e.spread) : undefined,
        color: rgbaToHex(e.color!),
        inset: e.type === 'INNER_SHADOW' || undefined
      }))
    if (layers.length) {
      out.push({
        kind: 'shadow',
        name: meta.name,
        path: meta.name,
        value: { kind: 'shadow', layers },
        source: 'style',
        description: meta.description || undefined
      })
    }
  })
  return out
}

/** ───────────── 第三级：文件树启发式统计 ───────────── */

interface HNode {
  type?: string
  visible?: boolean
  fills?: { type: string; visible?: boolean; color?: { r: number; g: number; b: number; a?: number } }[]
  effects?: {
    type: string
    visible?: boolean
    offset?: { x: number; y: number }
    radius?: number
    spread?: number
    color?: { r: number; g: number; b: number; a?: number }
  }[]
  cornerRadius?: number
  rectangleCornerRadii?: number[]
  itemSpacing?: number
  style?: { fontSize?: number; lineHeightPx?: number }
  children?: HNode[]
}

/** 遍历文件树按值统计出现频次 */
function collectHeuristics(root: HNode): Map<string, { count: number; kind: TokenKind; value: SpecTokenValue }> {
  const stats = new Map<string, { count: number; kind: TokenKind; value: SpecTokenValue }>()
  const bump = (key: string, kind: TokenKind, value: SpecTokenValue) => {
    const hit = stats.get(key)
    if (hit) hit.count += 1
    else stats.set(key, { count: 1, kind, value })
  }
  const visit = (node: HNode) => {
    if (node.visible === false) return
    const solid = node.fills?.find((f) => f.visible !== false && f.type === 'SOLID' && f.color)
    if (solid?.color) bump(`color:${rgbaToHex(solid.color)}`, 'color', { kind: 'color', hex: rgbaToHex(solid.color) })
    const radii = node.rectangleCornerRadii ?? (node.cornerRadius !== undefined ? [node.cornerRadius] : [])
    const uniq = [...new Set(radii.filter((r) => r > 0))]
    if (uniq.length === 1)
      bump(`radius:${uniq[0]}`, 'radius', { kind: 'radius', value: round2(uniq[0]), unit: 'px' })
    if (node.itemSpacing && node.itemSpacing > 0)
      bump(`spacing:${node.itemSpacing}`, 'spacing', {
        kind: 'spacing',
        value: round2(node.itemSpacing),
        unit: 'px'
      })
    if (node.style?.fontSize && node.style.fontSize > 0)
      bump(`fontSize:${node.style.fontSize}`, 'fontSize', {
        kind: 'fontSize',
        value: round2(node.style.fontSize),
        unit: 'px'
      })
    if (node.style?.lineHeightPx && node.style.lineHeightPx > 0)
      bump(`lineHeight:${node.style.lineHeightPx}`, 'lineHeight', {
        kind: 'lineHeight',
        value: round2(node.style.lineHeightPx),
        unit: 'px'
      })
    const layers = (node.effects ?? []).filter((e) => e.visible !== false && e.color)
    if (layers.length)
      bump(
        `shadow:${layers
          .map((e) => `${e.offset?.x ?? 0},${e.offset?.y ?? 0},${e.radius ?? 0},${rgbaToHex(e.color!)}`)
          .join('|')}`,
        'shadow',
        {
          kind: 'shadow',
          layers: layers.map((e) => ({
            x: round2(e.offset?.x ?? 0),
            y: round2(e.offset?.y ?? 0),
            blur: round2(e.radius ?? 0),
            spread: e.spread !== undefined ? round2(e.spread) : undefined,
            color: rgbaToHex(e.color!),
            inset: e.type === 'INNER_SHADOW' || undefined
          }))
        }
      )
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return stats
}

/** 每类取频次 Top N，按值排序输出（启发式命名：类型/值） */
const HEURISTIC_TOP_N = 40

function parseHeuristic(fileKey: string, pat: string): Promise<{ fileName: string; tokens: ParsedToken[] }> {
  return figmaApi<{ name?: string; document?: HNode }>(`/files/${fileKey}?depth=4`, pat).then((res) => {
    const tokens: ParsedToken[] = []
    if (!res.document) return { fileName: res.name ?? '', tokens }
    const byKind = new Map<TokenKind, { count: number; value: SpecTokenValue }[]>()
    for (const entry of collectHeuristics(res.document).values()) {
      const list = byKind.get(entry.kind) ?? []
      list.push(entry)
      byKind.set(entry.kind, list)
    }
    for (const [kind, list] of byKind) {
      list.sort((a, b) => b.count - a.count)
      for (const { value } of list.slice(0, HEURISTIC_TOP_N)) {
        const label =
          value.kind === 'color'
            ? value.hex
            : value.kind === 'shadow'
              ? `shadow-${tokens.filter((t) => t.kind === 'shadow').length + 1}`
              : value.kind === 'border'
                ? `${value.width}px ${value.style}`
                : `${value.value}px`
        tokens.push({
          kind,
          name: `${kind}/${label}`,
          path: `heuristic/${kind}`,
          value,
          source: 'heuristic'
        })
      }
    }
    return { fileName: res.name ?? '', tokens }
  })
}

/** 拉取文件名（轻量 depth=1；独立端点不含文件名，统一补一次） */
async function fetchFileName(fileKey: string, pat: string): Promise<string> {
  try {
    const res = await figmaApi<{ name?: string }>(`/files/${fileKey}?depth=1`, pat)
    return res.name ?? ''
  } catch {
    return '' // 文件名拿不到不阻塞解析
  }
}

/**
 * 同步入口：链接 → Token 列表（三级降级，降级链路透明记录在 degraded）。
 * 任一级解析成功且产出 ≥1 条即返回；全部失败抛最后一个错误。
 * startLevel：起始解析级别（用户确认变量无权限后跳过 variable 从 style 起）。
 * variable 级 403（无变量读取权限）时中断不降级，返回 variableDenied 待用户选择。
 */
export async function syncSpecTokens(input: {
  pat: string
  figmaUrl: string
  startLevel?: 'variable' | 'style' | 'heuristic'
}): Promise<SpecSyncResult> {
  const pat = (input.pat ?? '').trim()
  if (!pat) throw new Error('未配置 Figma Personal Access Token，请先在「设置 → MCP 管理」中填写')
  const fileKey = extractFigmaFileKey(input.figmaUrl ?? '')
  if (!fileKey) throw new Error('Figma 规范链接格式不正确')

  const allLevels: { level: 'variable' | 'style' | 'heuristic'; run: () => Promise<ParsedToken[]> }[] = [
    { level: 'variable', run: () => parseVariables(fileKey, pat) },
    { level: 'style', run: () => parseStyles(fileKey, pat) },
    {
      level: 'heuristic',
      run: async () => (await parseHeuristic(fileKey, pat)).tokens
    }
  ]
  const order = allLevels.map((l) => l.level)
  const startIdx = order.indexOf(input.startLevel ?? 'variable')
  const levels = allLevels.slice(Math.max(0, startIdx))
  const degraded: SpecDegradation[] = []
  let lastErr: unknown
  for (const { level, run } of levels) {
    try {
      const tokens = await run()
      if (tokens.length) {
        return {
          ok: true,
          message: '',
          fileName: await fetchFileName(fileKey, pat),
          sourceLevel: level,
          tokens,
          degraded
        }
      }
      lastErr = new Error(`该级别无可用数据：${level}`)
    } catch (err) {
      lastErr = err
      // 变量级 403 = PAT 缺 file_variables:read（Enterprise 专属），重新生成令牌也无法勾选：
      // 中断不静默降级，交由用户选择「改同步样式」或「JSON 导入自建 Token」
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
      if (level === 'variable' && /403|file_variables/i.test(msg)) {
        return {
          ok: false,
          message: msg,
          variableDenied: true,
          degraded: [
            {
              level,
              reason: msg,
              hint: 'Figma 变量 API 仅对 Enterprise 套餐开放（file_variables:read 为 Enterprise 专属权限），无法导入自建 Token（变量）'
            }
          ]
        }
      }
    }
    degraded.push({
      level,
      reason: lastErr instanceof Error ? lastErr.message : String(lastErr),
      // 变量级 403 = PAT 缺 file_variables:read；该 scope 为 Figma Enterprise 套餐专属，普通套餐生成令牌时无此选项，重新生成也无法勾选
      hint:
        level === 'variable'
          ? /403|file_variables/i.test(lastErr instanceof Error ? lastErr.message : String(lastErr))
            ? 'Figma 变量 API 仅对 Enterprise 套餐开放（file_variables:read 为 Enterprise 专属权限）。建议改用变量导出插件生成 JSON 后在「导入 JSON」中导入（支持三层 Token 体系与别名解析）；如为 Enterprise 套餐，请确认令牌已勾选「读取变量」权限后重试'
            : '当前文件未读取到 Figma 变量（可能变量都来自组件库或未定义本地变量），已降级为样式解析；建议在变量库文件上同步，或用 Figma Variables 插件导出 JSON 后导入'
          : undefined
    })
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
