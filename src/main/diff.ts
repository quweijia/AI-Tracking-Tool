/**
 * 结构化样式差异比对（v2：整体一致即可，降噪）：
 * - 只保留肉眼可辨的属性：宽高、字号、字重、文字/背景颜色、内边距与间距、圆角
 * - 跳过行高、字间距、字体族、描边、阴影、透明度等细节项与过小元素
 * - 每个匹配对只输出一条合并标注（N 项细节并入描述），避免同元素多框重叠
 * - 颜色类差异附带开发侧色值（colorHex），渲染为色值标注
 */
import type { MatchPair, StyleDiff, ToleranceConfig } from '../shared/types'
import { colorDeltaE, parseColor, rgbaLabel, rgbToHex } from '../shared/color'

/** 单页差异上限，防止异常页面刷屏 */
const MAX_DIFFS = 200

/** 小于该尺寸的元素不参与比对（噪生源） */
const MIN_ELEM_SIZE = 8

type Severity = StyleDiff['severity']
type Category = StyleDiff['category']

const px = (v: number): string => `${Math.round(v * 100) / 100}px`

function severityByRatio(ratio: number, major: number, minor: number): Severity {
  return ratio >= major ? 'major' : ratio >= minor ? 'minor' : 'suggestion'
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

/** 颜色差异值描述 */
function colorLabel(raw: string): string {
  const c = parseColor(raw)
  return c ? rgbaLabel(c) : raw
}

/** 颜色差异的开发侧 hex（渲染色值标注用），解析失败返回 undefined */
function devColorHex(raw: string): string | undefined {
  const c = parseColor(raw)
  return c ? rgbToHex(c) : undefined
}

interface RawDiff {
  category: Category
  severity: Severity
  property: string
  label: string
  designValue: string
  devValue: string
  colorHex?: string
}

/** 单个匹配对的属性级比对（宽松规则）；includeSizeSpacing=false 时跳过宽高与内边距/间距（仅严格模式比对） */
function diffPair(pair: MatchPair, tol: ToleranceConfig, includeSizeSpacing: boolean): RawDiff[] {
  const out: RawDiff[] = []
  const d = pair.design
  const m = pair.dom
  if (m.width < MIN_ELEM_SIZE || m.height < MIN_ELEM_SIZE) return out

  const push = (item: RawDiff): void => {
    out.push(item)
  }

  // ===== 尺寸（宽度/高度，仅严格模式比对）=====
  const checkSize = (prop: 'width' | 'height', label: string, dv: number, mv: number): void => {
    const diff = Math.abs(dv - mv)
    if (diff <= tol.size) return
    push({
      category: 'style',
      severity: severityByRatio(diff / Math.max(dv, 1), 0.25, 0.12),
      property: prop,
      label,
      designValue: px(dv),
      devValue: px(mv)
    })
  }
  if (includeSizeSpacing) {
    checkSize('width', '宽度', d.width, m.width)
    checkSize('height', '高度', d.height, m.height)
  }

  // ===== 颜色 =====
  const checkColor = (property: string, label: string, designColor: string, devColor: string): void => {
    const de = colorDeltaE(designColor, devColor)
    if (de === null || de <= tol.color) return
    push({
      category: 'color',
      severity: severityByRatio(de, 15, 6),
      property,
      label,
      designValue: colorLabel(designColor),
      devValue: colorLabel(devColor),
      colorHex: devColorHex(devColor)
    })
  }
  if (d.type === 'text' || (d.text && d.text.trim())) {
    if (d.textColor && m.textColor) checkColor('color', '文字颜色', d.textColor, m.textColor)
  }
  if (d.fill && m.fill) checkColor('background', '背景色', d.fill, m.fill)

  // ===== 文字排版 =====
  if (d.type === 'text' || (d.text && d.text.trim())) {
    if (d.fontSize !== undefined) {
      const mv = m.fontSize ?? 0
      const diff = Math.abs(d.fontSize - mv)
      if (diff > tol.typography) {
        push({
          category: 'typography',
          severity: diff >= 4 ? 'major' : diff >= 2 ? 'minor' : 'suggestion',
          property: 'font-size',
          label: '字号',
          designValue: px(d.fontSize),
          devValue: m.fontSize === undefined ? '未设置' : px(mv)
        })
      }
    }
    if (d.fontWeight !== undefined && m.fontWeight !== undefined && d.fontWeight !== m.fontWeight) {
      const diff = Math.abs(d.fontWeight - m.fontWeight)
      push({
        category: 'typography',
        severity: diff >= 300 ? 'major' : 'minor',
        property: 'font-weight',
        label: '字重',
        designValue: String(d.fontWeight),
        devValue: String(m.fontWeight)
      })
    }
  }

  // ===== 间距（设计稿有定义才比对；仅严格模式比对）=====
  const checkSpacing = (prop: string, label: string, dv: number | undefined, mv: number | undefined): void => {
    if (dv === undefined) return
    const mVal = mv ?? 0
    const diff = Math.abs(dv - mVal)
    if (diff <= tol.spacing) return
    push({
      category: 'spacing',
      severity: diff >= 8 ? 'major' : diff >= 4 ? 'minor' : 'suggestion',
      property: prop,
      label,
      designValue: px(dv),
      devValue: px(mVal)
    })
  }
  if (includeSizeSpacing) {
    checkSpacing('padding-top', '上内边距', d.paddingTop, m.paddingTop)
    checkSpacing('padding-right', '右内边距', d.paddingRight, m.paddingRight)
    checkSpacing('padding-bottom', '下内边距', d.paddingBottom, m.paddingBottom)
    checkSpacing('padding-left', '左内边距', d.paddingLeft, m.paddingLeft)
    checkSpacing('gap', '元素间距', d.gap, m.gap)
  }

  // ===== 圆角（阈值放宽：≥2px 才比对）=====
  if (d.borderRadius?.length) {
    const dr = d.borderRadius
    const mr = m.borderRadius ?? [0, 0, 0, 0]
    const maxDiff = Math.max(...dr.map((v, i) => Math.abs(v - (mr[i] ?? 0))))
    if (maxDiff > Math.max(tol.radius, 2)) {
      const fmtR = (arr: number[]): string => {
        const all = arr.every((v) => Math.abs(v - arr[0]) < 0.01)
        return all ? px(arr[0]) : arr.map(px).join(' ')
      }
      push({
        category: 'style',
        severity: maxDiff >= 6 ? 'major' : 'minor',
        property: 'border-radius',
        label: '圆角',
        designValue: fmtR(dr),
        devValue: m.borderRadius ? fmtR(mr) : '未设置'
      })
    }
  }

  return out
}

/**
 * 全部匹配对 → 差异列表：
 * 每个匹配对合并为一条标注（避免同元素多框重叠），
 * 颜色差异存在时优先归类为颜色规范并附带色值。
 */
export function computeDiffs(
  pairs: MatchPair[],
  tolerance: ToleranceConfig,
  viewport: { width: number; height: number },
  includeSizeSpacing = true
): StyleDiff[] {
  const order: Record<Severity, number> = { major: 0, minor: 1, suggestion: 2 }
  const out: StyleDiff[] = []
  for (const pair of pairs) {
    const raws = diffPair(pair, tolerance, includeSizeSpacing)
    if (raws.length === 0) continue
    const sorted = [...raws].sort((a, b) => order[a.severity] - order[b.severity])
    const top = sorted[0]
    const colorItem = raws.find((r) => r.category === 'color')
    const name = pair.design.name || pair.dom.name || '元素'
    const details = raws.map((r) => `${r.label} ${r.designValue} → ${r.devValue}`).join('；')
    const dom = pair.dom
    out.push({
      category: top.category,
      severity: top.severity,
      property: raws.map((r) => r.property).join(','),
      label: `${raws.length} 项样式`,
      designValue: top.designValue,
      devValue: top.devValue,
      colorHex: colorItem?.colorHex,
      description: `「${name}」整体样式不一致（${raws.length} 项）：${details}`,
      figmaNodeId: pair.design.figmaNodeId,
      domPath: dom.domPath,
      matchConfidence: pair.confidence,
      rect: {
        x: clamp01(dom.x / viewport.width),
        y: clamp01(dom.y / viewport.height),
        width: Math.max(0.004, Math.min(1, dom.width / viewport.width)),
        height: Math.max(0.004, Math.min(1, dom.height / viewport.height))
      }
    })
  }
  out.sort((a, b) => order[a.severity] - order[b.severity] || b.matchConfidence - a.matchConfidence)
  return out.slice(0, MAX_DIFFS)
}
