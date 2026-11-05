/**
 * 结构化样式差异比对（v2：整体一致即可，降噪）：
 * - 只保留肉眼可辨的属性：宽高、字号、字重、文字/背景颜色、内边距与间距、圆角
 * - 跳过行高、字间距、字体族、描边、阴影、透明度等细节项与过小元素
 * - 每个匹配对只输出一条合并标注（N 项细节并入描述），避免同元素多框重叠
 * - 颜色类差异附带开发侧色值（colorHex），渲染为色值标注
 */
import type { MatchPair, StyleDiff, StructuredChecksConfig, ToleranceConfig } from '../shared/types'
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
  note?: string
}

/** 单个匹配对的属性级比对（宽松规则）；includeSizeSpacing=false 时跳过宽高与内边距/间距（仅严格模式比对）；
 *  exemptOut 收集豁免差异（父容器裁剪圆角等），不进主列表；checks 缺省 = 旧行为 */
function diffPair(
  pair: MatchPair,
  tol: ToleranceConfig,
  includeSizeSpacing: boolean,
  exemptOut: RawDiff[] = [],
  checks?: StructuredChecksConfig
): RawDiff[] {
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
  // 宽度比对（hug 分流）：checks 缺省 = 旧调用方 = 完全旧行为；text-content 模式下
  // 设计侧宽度自适应（Hug 文本）改比 DOM 侧文字渲染宽，固定宽度包裹文本不再误报容器宽
  const checkWidth = (): void => {
    const textContentMode = checks !== undefined && checks.hugWidthMode !== 'strict'
    if (textContentMode && d.hugWidth && m.textContentWidth !== undefined) {
      const diff = Math.abs(d.width - m.textContentWidth)
      if (diff <= tol.size) return
      push({
        category: 'style',
        severity: severityByRatio(diff / Math.max(d.width, 1), 0.25, 0.12),
        property: 'width',
        label: '文字内容宽',
        designValue: px(d.width),
        devValue: px(m.textContentWidth),
        note: '设计侧为宽度自适应（Hug）文本，已按文字渲染宽度比对，不比较容器宽度'
      })
      return
    }
    checkSize('width', '宽度', d.width, m.width)
  }
  if (includeSizeSpacing) {
    checkWidth()
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

  // ===== 圆角（增强：百分比换算 + 父容器裁剪追溯；豁免项不进主列表、不扣分）=====
  if (d.borderRadius?.length) {
    const dr = d.borderRadius
    const mrRaw = m.borderRadius
    const mr = mrRaw ?? [0, 0, 0, 0]
    const maxDiff = Math.max(...dr.map((v, i) => Math.abs(v - (mr[i] ?? 0))))
    // 缺省（旧调用方未传 checks）= 完全旧行为；仅显式 radiusCheck: true 走增强
    const enhanced = checks?.radiusCheck === true
    // 旧行为阈值保留 Math.max(tol.radius, 2) 二次放宽；增强模式复用容差配置不再叠加
    if (maxDiff > (enhanced ? tol.radius : Math.max(tol.radius, 2))) {
      const fmtR = (arr: number[]): string => {
        const all = arr.every((v) => Math.abs(v - arr[0]) < 0.01)
        return all ? px(arr[0]) : arr.map(px).join(' ')
      }
      // 来源判定：采集侧显式标注优先；旧数据兜底（有 borderRadius 即视为自身设置）
      const source = m.radiusSource ?? (mrRaw ? 'self' : 'none')
      if (enhanced && source === 'parent-clip') {
        exemptOut.push({
          category: 'style',
          severity: 'suggestion',
          property: 'border-radius',
          label: '圆角（父容器裁剪）',
          designValue: fmtR(dr),
          devValue: fmtR(mr),
          note: `该圆角由父容器 ${m.radiusParentPath ?? ''} 的 overflow 裁剪形成，非元素自身设置；父容器层级已单独比对`
        })
      } else {
        const notes: string[] = []
        if (enhanced && source === 'none') notes.push('开发侧元素及其父级均未设置圆角')
        if (enhanced && m.radiusPercent) notes.push('开发侧为百分比圆角，已按元素短边换算为 px 比对')
        push({
          category: 'style',
          severity: maxDiff >= 6 ? 'major' : 'minor',
          property: 'border-radius',
          label: '圆角',
          designValue: fmtR(dr),
          devValue: mrRaw ? fmtR(mr) : '未设置',
          ...(notes.length ? { note: notes.join('；') } : {})
        })
      }
    }
  }

  return out
}

/**
 * 全部匹配对 → 差异列表：
 * 每个匹配对合并为一条标注（避免同元素多框重叠），
 * 颜色差异存在时优先归类为颜色规范并附带色值。
 * 豁免项（父容器裁剪圆角等）不进主列表、不扣分，经 exemptDiffs 独立通道返回（详情面板折叠查看）。
 */
export function computeDiffs(
  pairs: MatchPair[],
  tolerance: ToleranceConfig,
  viewport: { width: number; height: number },
  includeSizeSpacing = true,
  checks?: StructuredChecksConfig
): { diffs: StyleDiff[]; exemptDiffs: StyleDiff[] } {
  const order: Record<Severity, number> = { major: 0, minor: 1, suggestion: 2 }

  const toStyleDiff = (pair: MatchPair, raw: RawDiff, description: string): StyleDiff => {
    const dom = pair.dom
    return {
      category: raw.category,
      severity: raw.severity,
      property: raw.property,
      label: raw.label,
      designValue: raw.designValue,
      devValue: raw.devValue,
      colorHex: raw.colorHex,
      note: raw.note,
      description,
      figmaNodeId: pair.design.figmaNodeId,
      domPath: dom.domPath,
      matchConfidence: pair.confidence,
      rect: {
        x: clamp01(dom.x / viewport.width),
        y: clamp01(dom.y / viewport.height),
        width: Math.max(0.004, Math.min(1, dom.width / viewport.width)),
        height: Math.max(0.004, Math.min(1, dom.height / viewport.height))
      }
    }
  }

  const out: StyleDiff[] = []
  const exempt: StyleDiff[] = []
  for (const pair of pairs) {
    const pairExempt: RawDiff[] = []
    const raws = diffPair(pair, tolerance, includeSizeSpacing, pairExempt, checks)
    const name = pair.design.name || pair.dom.name || '元素'
    for (const raw of pairExempt) {
      exempt.push(
        toStyleDiff(
          pair,
          raw,
          `「${name}」${raw.label}：设计 ${raw.designValue}，开发侧 ${raw.devValue}。${raw.note ?? ''}`
        )
      )
    }
    if (raws.length === 0) continue
    const sorted = [...raws].sort((a, b) => order[a.severity] - order[b.severity])
    const top = sorted[0]
    const colorItem = raws.find((r) => r.category === 'color')
    const details = raws.map((r) => `${r.label} ${r.designValue} → ${r.devValue}`).join('；')
    const noteRaw = raws.find((r) => r.note)?.note
    const merged = toStyleDiff(
      pair,
      top,
      `「${name}」整体样式不一致（${raws.length} 项）：${details}${noteRaw ? `（${noteRaw}）` : ''}`
    )
    merged.property = raws.map((r) => r.property).join(',')
    merged.label = `${raws.length} 项样式`
    if (colorItem?.colorHex) merged.colorHex = colorItem.colorHex
    out.push(merged)
  }
  out.sort((a, b) => order[a.severity] - order[b.severity] || b.matchConfidence - a.matchConfidence)
  exempt.sort((a, b) => order[a.severity] - order[b.severity] || b.matchConfidence - a.matchConfidence)
  return { diffs: out.slice(0, MAX_DIFFS), exemptDiffs: exempt.slice(0, MAX_DIFFS) }
}
