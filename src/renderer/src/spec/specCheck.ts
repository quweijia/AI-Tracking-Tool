/**
 * 程序轨规范校验：项目绑定规范的最新版本 Token × webview 采集的 DOM 样式树 → 不合规项。
 * 颜色走 ΔE CIEDE2000（复用 shared/color），数值类走绝对偏差，阴影/描边走结构比对。
 * 输出为语言无关的结构化违规项，最终 Issue 描述由调用方（AutoWalkPanel）按当前语言拼装。
 */
import type {
  SpecTokenValue,
  StyleNode,
  ToleranceConfig,
  TokenKind
} from '../../../shared/types'
import { deltaE2000, parseColor, rgbToLab } from '../../../shared/color'
import { db, latestSpecVersion, type Category, type DesignSpec, type Platform, type Severity } from '../db'

/** 参与校验的 Token（specTokens 行 value 反序列化后的形状） */
export interface SpecCheckToken {
  kind: TokenKind
  /** Figma 原名（描述与建议值展示用） */
  name: string
  value: SpecTokenValue
}

/** 单条规范违规（语言无关，落库前转 Issue） */
export interface SpecViolation {
  /** 命中节点（domPath 等回溯字段来源，坐标保持原始 px） */
  node: StyleNode
  /** 归一化标注框（0~1，Issue 落库直接可用） */
  rect: { x: number; y: number; width: number; height: number }
  /** 对齐问题清单分类 */
  category: Category
  /** 属性标识（background / text-color / gap / padding-top / font-size / line-height / border-radius / box-shadow / border） */
  property: string
  /** 属性名 i18n key（specProp_*，autoWalkPanel ns） */
  propKey: string
  /** 实测值文本 */
  actualText: string
  /** 建议规范 Token 名 */
  tokenName: string
  /** 建议规范值文本 */
  expectedText: string
  /** 偏差类型：色差 ΔE / 尺寸偏差 px；阴影/描边结构不匹配时缺省（调用方给通用文案） */
  deltaKind?: 'deltaE' | 'px'
  /** 偏差量（deltaKind 对应单位的数值） */
  deltaValue?: number
  severity: Severity
}

/** 同 key（property+实测+建议 Token）最多保留的代表节点数：列表项重复样式防刷屏 */
const MAX_PER_KEY = 3
/** 单次走查违规总量上限 */
const MAX_VIOLATIONS = 400

/** 两个颜色串的 ΔE；任一近透明（alpha<0.05）或解析失败返回 null（不比对、不误报） */
function colorDiffE(a: string | undefined, b: string): number | null {
  const ca = parseColor(a)
  const cb = parseColor(b)
  if (!ca || !cb || ca.a < 0.05 || cb.a < 0.05) return null
  return deltaE2000(rgbToLab(ca), rgbToLab(cb))
}

/** 从颜色类 Token 里找与实测色最接近的一条 */
function nearestColor(tokens: SpecCheckToken[], actual: string): { token: SpecCheckToken; dE: number } | null {
  let best: { token: SpecCheckToken; dE: number } | null = null
  for (const t of tokens) {
    if (t.value.kind !== 'color') continue
    const dE = colorDiffE(actual, t.value.hex)
    if (dE === null) continue
    if (!best || dE < best.dE) best = { token: t, dE }
  }
  return best
}

/** FLOAT 可落库的 kind 子集（与 specSync 的 FloatKind 口径一致） */
type FloatKind = 'spacing' | 'fontSize' | 'lineHeight' | 'radius'

/** 从数值类 Token 里找与实测值最接近的一条 */
function nearestFloat(
  tokens: SpecCheckToken[],
  kind: FloatKind,
  actual: number
): { token: SpecCheckToken; delta: number } | null {
  let best: { token: SpecCheckToken; delta: number } | null = null
  for (const t of tokens) {
    if (t.kind !== kind || t.value.kind !== kind) continue
    const delta = Math.abs(t.value.value - actual)
    if (!best || delta < best.delta) best = { token: t, delta }
  }
  return best
}

/** 解析后的单层 DOM 阴影 */
interface DomShadow {
  x: number
  y: number
  blur: number
  spread: number
  color: string
  inset: boolean
}

/**
 * 解析 getComputedStyle 的 box-shadow 串（多层逗号分隔，颜色可能是 rgba()/hex/关键字）。
 * 任何一层解析失败返回 null（跳过该节点，不做不完整比对）。
 */
function parseBoxShadow(raw: string): DomShadow[] | null {
  if (!raw || raw === 'none') return null
  const re =
    /(inset\s+)?((?:rgba?\([^)]*\))|(?:#[0-9a-fA-F]{3,8})|(?:[a-z]+))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?\s*(inset)?/g
  const layers: DomShadow[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    if (!parseColor(m[2])) return null
    layers.push({
      x: parseFloat(m[3]),
      y: parseFloat(m[4]),
      blur: parseFloat(m[5]),
      spread: m[6] !== undefined ? parseFloat(m[6]) : 0,
      color: m[2],
      inset: Boolean(m[1] || m[7])
    })
  }
  return layers.length ? layers : null
}

/** 数值类 Token 格式化文本 */
function floatLabel(t: SpecCheckToken): string {
  return t.value.kind === 'spacing' || t.value.kind === 'fontSize' || t.value.kind === 'lineHeight' || t.value.kind === 'radius'
    ? `${t.value.value}px`
    : ''
}

/** 阴影 Token 格式化文本（描述展示用） */
function shadowLabel(t: SpecCheckToken): string {
  if (t.value.kind !== 'shadow') return ''
  return t.value.layers
    .map((l) => `${l.inset ? 'inset ' : ''}${l.x}px ${l.y}px ${l.blur}px ${l.spread ?? 0}px ${l.color}`)
    .join(', ')
}

/** 数值类偏差的严重度：≤2×容差 minor，否则 major */
const severityOf = (delta: number, tol: number): Severity => (delta <= tol * 2 ? 'minor' : 'major')

/**
 * 程序轨校验主入口：遍历 DOM 样式树，逐属性与绑定规范 Token 比对。
 * tokens 建议由调用方过滤掉 heuristic 来源（启发式采样值不作为规范基准）。
 */
export function checkSpec(
  root: StyleNode,
  tokens: SpecCheckToken[],
  viewport: { width: number; height: number },
  tol: ToleranceConfig
): SpecViolation[] {
  const out: SpecViolation[] = []
  const keyCount = new Map<string, number>()
  const vw = viewport.width || 1
  const vh = viewport.height || 1
  const has = (kind: TokenKind) => tokens.some((t) => t.kind === kind)

  /** 记录一条违规（归一化框 + key 限流 + 总量截断） */
  const push = (v: Omit<SpecViolation, 'rect'>, key: string) => {
    const n = keyCount.get(key) ?? 0
    if (n >= MAX_PER_KEY) return
    if (out.length >= MAX_VIOLATIONS) return
    keyCount.set(key, n + 1)
    out.push({
      ...v,
      rect: { x: v.node.x / vw, y: v.node.y / vh, width: v.node.width / vw, height: v.node.height / vh }
    })
  }

  /** 颜色类属性：fill / textColor → color Token */
  const colorCheck = (node: StyleNode, actual: string | undefined, property: string, propKey: string) => {
    if (!actual || !has('color')) return
    const near = nearestColor(tokens, actual)
    if (!near || near.dE <= tol.color) return
    push(
      {
        node,
        category: 'color',
        property,
        propKey,
        actualText: actual,
        tokenName: near.token.name,
        expectedText: near.token.value.kind === 'color' ? near.token.value.hex : '',
        deltaKind: 'deltaE',
        deltaValue: near.dE,
        severity: severityOf(near.dE, tol.color)
      },
      `${property}|${actual}|${near.token.name}`
    )
  }

  /** 数值类属性：间距/字号/行高 → 对应 FloatKind Token */
  const floatCheck = (
    node: StyleNode,
    actual: number | undefined,
    property: string,
    propKey: string,
    kind: FloatKind,
    tolPx: number,
    category: Category
  ) => {
    if (actual === undefined || actual <= 0 || !has(kind)) return
    const near = nearestFloat(tokens, kind, actual)
    if (!near || near.delta <= tolPx) return
    push(
      {
        node,
        category,
        property,
        propKey,
        actualText: `${actual}px`,
        tokenName: near.token.name,
        expectedText: floatLabel(near.token),
        deltaKind: 'px',
        deltaValue: near.delta,
        severity: severityOf(near.delta, tolPx)
      },
      `${property}|${actual}|${near.token.name}`
    )
  }

  const visit = (node: StyleNode): void => {
    if (node.width > 0 && node.height > 0) {
      colorCheck(node, node.fill, 'background', 'bgColor')
      colorCheck(node, node.textColor, 'text-color', 'textColor')

      floatCheck(node, node.gap, 'gap', 'gap', 'spacing', tol.spacing, 'spacing')
      floatCheck(node, node.paddingTop, 'padding-top', 'padding', 'spacing', tol.spacing, 'spacing')
      floatCheck(node, node.paddingRight, 'padding-right', 'padding', 'spacing', tol.spacing, 'spacing')
      floatCheck(node, node.paddingBottom, 'padding-bottom', 'padding', 'spacing', tol.spacing, 'spacing')
      floatCheck(node, node.paddingLeft, 'padding-left', 'padding', 'spacing', tol.spacing, 'spacing')

      floatCheck(node, node.fontSize, 'font-size', 'fontSize', 'fontSize', tol.typography, 'typography')
      floatCheck(node, node.lineHeight, 'line-height', 'lineHeight', 'lineHeight', tol.typography, 'typography')

      // 圆角：四角非零值各自找最近 Token，取偏差最大的角代表整组
      const radii = [...new Set((node.borderRadius ?? []).filter((r) => r > 0))]
      if (radii.length && has('radius')) {
        let worst: { token: SpecCheckToken; delta: number } | null = null
        for (const r of radii) {
          const near = nearestFloat(tokens, 'radius', r)
          if (near && (!worst || near.delta > worst.delta)) worst = near
        }
        if (worst && worst.delta > tol.radius) {
          push(
            {
              node,
              category: 'style',
              property: 'border-radius',
              propKey: 'radius',
              actualText: radii.map((r) => `${r}px`).join(', '),
              tokenName: worst.token.name,
              expectedText: floatLabel(worst.token),
              deltaKind: 'px',
              deltaValue: worst.delta,
              severity: severityOf(worst.delta, tol.radius)
            },
            `border-radius|${radii.join(',')}|${worst.token.name}`
          )
        }
      }

      // 阴影：结构比对（层数一致 + 每层尺寸差与色差均在容差内），解析失败跳过不误报
      if (node.boxShadow && has('shadow')) {
        const dom = parseBoxShadow(node.boxShadow)
        const shadowToks = tokens.filter((t) => t.kind === 'shadow' && t.value.kind === 'shadow')
        if (dom && shadowToks.length) {
          const tolD = Math.max(2, tol.border)
          const matched = shadowToks.find((t) => {
            if (t.value.kind !== 'shadow') return false
            if (t.value.layers.length !== dom.length) return false
            return t.value.layers.every((l) =>
              dom.some(
                (d) =>
                  d.inset === Boolean(l.inset) &&
                  Math.abs(d.x - l.x) <= tolD &&
                  Math.abs(d.y - l.y) <= tolD &&
                  Math.abs(d.blur - l.blur) <= tolD &&
                  Math.abs(d.spread - (l.spread ?? 0)) <= tolD &&
                  (colorDiffE(d.color, l.color) ?? Infinity) <= tol.color * 2
              )
            )
          })
          if (!matched) {
            const rep = shadowToks[0]
            push(
              {
                node,
                category: 'style',
                property: 'box-shadow',
                propKey: 'shadow',
                actualText: node.boxShadow,
                tokenName: rep.name,
                expectedText: shadowLabel(rep),
                severity: 'minor'
              },
              `box-shadow|${node.boxShadow}`
            )
          }
        }
      }

      // 描边：宽度 + 颜色同时落在某条 border Token 容差内视为合规
      if ((node.borderWidth ?? 0) > 0 && has('border')) {
        const borderToks = tokens.filter((t) => t.kind === 'border' && t.value.kind === 'border')
        const matched = borderToks.find((t) => {
          if (t.value.kind !== 'border') return false
          if (Math.abs(t.value.width - (node.borderWidth ?? 0)) > tol.border) return false
          return (colorDiffE(node.borderColor, t.value.color) ?? Infinity) <= tol.color
        })
        if (!matched && borderToks.length) {
          // 展示用代表 Token：宽度与实测最接近的一条
          const rep = borderToks.reduce((a, b) =>
            Math.abs((b.value as { width: number }).width - (node.borderWidth ?? 0)) <
            Math.abs((a.value as { width: number }).width - (node.borderWidth ?? 0))
              ? b
              : a
          )
          const bv = rep.value as { width: number; style: string; color: string }
          push(
            {
              node,
              category: 'style',
              property: 'border',
              propKey: 'border',
              actualText: `${node.borderWidth}px ${node.borderColor ?? ''}`.trim(),
              tokenName: rep.name,
              expectedText: `${bv.width}px ${bv.style} ${bv.color}`,
              severity: 'minor'
            },
            `border|${node.borderWidth}|${node.borderColor ?? ''}`
          )
        }
      }
    }
    for (const c of node.children ?? []) visit(c)
  }

  visit(root)
  return out
}

/**
 * 项目绑定规范 → 参与校验的 Token 列表：
 * 绑定关系 → 规范套 → 端分类 platformKey 与页面端匹配 → 最新版本 Token（排除启发式来源）。
 */
export async function loadProjectSpecTokens(projectId: string, platform: Platform): Promise<SpecCheckToken[]> {
  const bindings = await db.projectSpecBindings.where('projectId').equals(projectId).toArray()
  if (!bindings.length) return []
  const [specs, categories] = await Promise.all([db.designSpecs.toArray(), db.specCategories.toArray()])
  const catById = new Map(categories.map((c) => [c.id, c]))
  const matched: DesignSpec[] = specs.filter(
    (s) => bindings.some((b) => b.specId === s.id) && catById.get(s.categoryId)?.platformKey === platform
  )
  const tokens: SpecCheckToken[] = []
  for (const spec of matched) {
    const latest = await latestSpecVersion(spec.id)
    if (!latest) continue
    const rows = await db.specTokens.where('versionId').equals(latest.id).toArray()
    for (const r of rows) {
      if (r.source === 'heuristic') continue
      const value = parseTokenValueSafe(r.value)
      if (value) tokens.push({ kind: r.kind, name: r.name, value })
    }
  }
  return tokens
}

/** parseTokenValue 薄封装（避免循环依赖 shared/types 的函数版） */
function parseTokenValueSafe(raw: string): SpecTokenValue | undefined {
  try {
    return JSON.parse(raw) as SpecTokenValue
  } catch {
    return undefined
  }
}

/** 单条 Token 的值文本（AI 摘要展示用；颜色 hex / 数值 px / 阴影描边结构文本） */
function tokenValueLabel(t: SpecCheckToken): string {
  const v = t.value
  if (v.kind === 'color') return v.hex
  if (v.kind === 'shadow') return shadowLabel(t)
  if (v.kind === 'border') return `${v.width}px ${v.style} ${v.color}`
  return floatLabel(t)
}

/** 每类 Token 在 AI prompt 摘要中的最大条数（防 prompt 超限） */
export const SPEC_SUMMARY_LIMIT = 30

/**
 * AI 轨 prompt 注入用 Token 摘要：7 类固定顺序分组，每类只列前 SPEC_SUMMARY_LIMIT 条，
 * 超限在组尾注明总数。仅列名与值文本，供模型按语义（搭配/层级/一致性）判断合规。
 */
export function formatSpecSummary(tokens: SpecCheckToken[]): string {
  const groups: { kind: TokenKind; label: string }[] = [
    { kind: 'color', label: '颜色' },
    { kind: 'spacing', label: '间距' },
    { kind: 'fontSize', label: '字号' },
    { kind: 'lineHeight', label: '行高' },
    { kind: 'radius', label: '圆角' },
    { kind: 'shadow', label: '阴影' },
    { kind: 'border', label: '边框' }
  ]
  const lines: string[] = []
  for (const g of groups) {
    const items = tokens.filter((t) => t.kind === g.kind)
    if (!items.length) continue
    const texts = items.slice(0, SPEC_SUMMARY_LIMIT).map((t) => `${t.name} ${tokenValueLabel(t)}`)
    const note = items.length > SPEC_SUMMARY_LIMIT ? `（共 ${items.length} 项，仅列前 ${SPEC_SUMMARY_LIMIT}）` : ''
    lines.push(`【${g.label}】${texts.join('、')}${note}`)
  }
  return lines.join('\n')
}
