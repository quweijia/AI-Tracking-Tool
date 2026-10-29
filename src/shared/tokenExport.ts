/**
 * 设计规范 Token 多格式导出（纯函数，渲染层/主进程通用）：
 * - JSON：W3C DTCG 风格（$value/$type，path 按 / 嵌套）
 * - CSS：:root 变量（-- + path kebab 拼接）
 * - Tailwind v3：theme.extend 分组对象（path 段 camelCase 嵌套）
 * heuristic 启发式来源不参与导出（调用方过滤）。
 */
import type { SpecTokenValue, TokenKind } from './types'

/** 参与导出的 Token（specTokens 行 value 反序列化后的形状） */
export interface ExportToken {
  kind: TokenKind
  /** Figma 原名（JSON 产物中以 $name 保留） */
  name: string
  /** 层级路径（/ 分组，命名依据） */
  path: string
  value: SpecTokenValue
}

export type ExportFormat = 'json' | 'css' | 'tailwind'

/** 各格式的默认文件名后缀 */
export const EXPORT_SUFFIX: Record<ExportFormat, string> = {
  json: 'tokens.json',
  css: 'tokens.css',
  tailwind: 'tailwind.tokens.js'
}

/** 数值类 Token 公共形状守卫 */
function isFloat(v: SpecTokenValue): v is { kind: 'spacing' | 'fontSize' | 'lineHeight' | 'radius'; value: number; unit: 'px' } {
  return v.kind === 'spacing' || v.kind === 'fontSize' || v.kind === 'lineHeight' || v.kind === 'radius'
}

/** 值文本（CSS 变量/注释用）：颜色 hex / 数值 px / 阴影逗号串 / 边框简写 */
function valueText(v: SpecTokenValue): string {
  if (v.kind === 'color') return v.hex
  if (v.kind === 'shadow')
    return v.layers
      .map((l) => `${l.inset ? 'inset ' : ''}${l.x}px ${l.y}px ${l.blur}px ${l.spread ?? 0}px ${l.color}`)
      .join(', ')
  if (v.kind === 'border') return `${v.width}px ${v.style} ${v.color}`
  return `${v.value}px`
}

/** 单段 → kebab-case：驼峰拆词、下划线/空格/点转连字符 */
function toKebab(seg: string): string {
  return seg
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_.]+/g, '-')
    .toLowerCase()
}

/** 单段 → camelCase 标识符：按非字母数字切词，首词小写、后续词首字母大写 */
function toCamel(seg: string): string {
  const words = seg.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (!words.length) return 'x'
  return (
    words[0].toLowerCase() +
    words
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('')
  )
}

/**
 * Token 名称标准化（仅「自动标准化」开关开启时调用；默认关闭以保留 Figma 原始命名）：
 * 按 -_./空格 与驼峰边界切词转 camelCase，CJK 词块原样保留，清理其余特殊字符。
 */
export function normalizeTokenName(seg: string): string {
  const words =
    seg.match(/[A-Za-z]+[0-9]*|[0-9]+|[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u3400-\u4dbf]+/g) ?? []
  if (!words.length) return seg.trim()
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  return words
    .map((w, i) => {
      // CJK 词块不参与驼峰，原样保留
      if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u3400-\u4dbf]/.test(w)) return w
      // 首词与纯数字词保持小写，后续词首字母大写
      if (i === 0 || /^[0-9]/.test(w)) return w.toLowerCase()
      return cap(w)
    })
    .join('')
}

// ---------------- JSON（W3C DTCG 风格） ----------------

/** Token → DTCG 叶子节点 */
function dtcgLeaf(t: ExportToken): Record<string, unknown> {
  const v = t.value
  if (v.kind === 'color') return { $value: v.hex, $type: 'color', $name: t.name }
  if (v.kind === 'shadow') {
    const layer = (l: (typeof v.layers)[number]) => ({
      color: l.color,
      offsetX: `${l.x}px`,
      offsetY: `${l.y}px`,
      blur: `${l.blur}px`,
      spread: `${l.spread ?? 0}px`,
      inset: Boolean(l.inset)
    })
    return {
      $value: v.layers.length === 1 ? layer(v.layers[0]) : v.layers.map(layer),
      $type: 'shadow',
      $name: t.name
    }
  }
  if (v.kind === 'border')
    return { $value: { color: v.color, width: `${v.width}px`, style: v.style }, $type: 'border', $name: t.name }
  return { $value: `${v.value}px`, $type: 'dimension', $name: t.name }
}

/** 按 path / 分组嵌套构建 DTCG 树 */
function buildDtcgTree(tokens: ExportToken[]): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  for (const t of tokens) {
    const segs = t.path.split('/').filter(Boolean)
    if (!segs.length) continue
    let node = root
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i]
      if (typeof node[k] !== 'object' || node[k] === null) node[k] = {}
      node = node[k] as Record<string, unknown>
    }
    node[segs[segs.length - 1]] = dtcgLeaf(t)
  }
  return root
}

// ---------------- CSS（:root 变量） ----------------

export function exportCss(tokens: ExportToken[]): string {
  const seen = new Map<string, string>()
  for (const t of tokens) {
    const varName = `--${t.path
      .split('/')
      .filter(Boolean)
      .map(toKebab)
      .join('-')}`
    seen.set(varName, valueText(t.value))
  }
  const lines = [...seen.entries()].map(([k, v]) => `  ${k}: ${v};`)
  return `:root {\n${lines.join('\n')}\n}\n`
}

// ---------------- Tailwind v3（theme.extend） ----------------

/** kind → Tailwind theme.extend 分组 */
const TW_GROUP: Record<TokenKind, string> = {
  color: 'colors',
  spacing: 'spacing',
  fontSize: 'fontSize',
  lineHeight: 'lineHeight',
  radius: 'borderRadius',
  shadow: 'boxShadow',
  border: 'borderWidth'
}

/** Token → Tailwind 值（shadow 多层输出数组，border 只取宽度） */
function twValue(t: ExportToken): string | string[] {
  const v = t.value
  if (v.kind === 'color') return v.hex
  if (v.kind === 'shadow')
    return v.layers.map(
      (l) => `${l.inset ? 'inset ' : ''}${l.x}px ${l.y}px ${l.blur}px ${l.spread ?? 0}px ${l.color}`
    )
  if (v.kind === 'border') return `${v.width}px`
  return `${v.value}px`
}

/** 按 path 嵌套构建各分组对象 */
function buildTwTree(tokens: ExportToken[]): Record<string, Record<string, unknown>> {
  const groups: Record<string, Record<string, unknown>> = {}
  for (const t of tokens) {
    const segs = t.path.split('/').filter(Boolean)
    if (!segs.length) continue
    const group = (groups[TW_GROUP[t.kind]] ??= {})
    let node = group
    for (let i = 0; i < segs.length - 1; i++) {
      const k = toCamel(segs[i])
      if (typeof node[k] !== 'object' || node[k] === null) node[k] = {}
      node = node[k] as Record<string, unknown>
    }
    node[toCamel(segs[segs.length - 1])] = twValue(t)
  }
  return groups
}

/** 缩进序列化 Tailwind 配置对象（单引号字符串、嵌套对象递归） */
function serTw(obj: Record<string, unknown>, depth: number): string {
  const padIn = '  '.repeat(depth + 1)
  return Object.entries(obj)
    .map(([k, v]) => {
      if (typeof v === 'string') return `${padIn}'${k}': '${v}'`
      if (Array.isArray(v)) return `${padIn}'${k}': [${v.map((s) => `'${s}'`).join(', ')}]`
      return `${padIn}'${k}': {\n${serTw(v as Record<string, unknown>, depth + 1)}\n${padIn}}`
    })
    .join(',\n')
}

export function exportTailwind(tokens: ExportToken[]): string {
  const extend = buildTwTree(tokens)
  return `/** Generated by UI 走查工具（设计规范导出），可合并进 tailwind.config.js */\nmodule.exports = {\n  theme: {\n    extend: {\n${serTw(extend, 2)}\n    }\n  }\n}\n`
}

// ---------------- JSON 输出 ----------------

export function exportJson(tokens: ExportToken[]): string {
  return `${JSON.stringify(buildDtcgTree(tokens), null, 2)}\n`
}

/** 统一导出入口：按格式生成产物文本 */
export function exportTokens(tokens: ExportToken[], fmt: ExportFormat): string {
  if (fmt === 'css') return exportCss(tokens)
  if (fmt === 'tailwind') return exportTailwind(tokens)
  return exportJson(tokens)
}
