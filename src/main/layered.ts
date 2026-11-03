/**
 * 分层误差计算（v3 旁路：容器/控件两级 × 位置/尺寸两维）：
 * - 容器 → 模块级（modulePosTol / moduleSizeTol），超容差一律 absorbed（吸收，不扣分）
 * - 控件/文本 → 元素级（elementPosTol / elementSizeTol），超容差 reported（计扣分）
 * - text 节点与 adaptable 容器跳过尺寸维
 * - reported 扣分 = weightLevel × weightDim × min(ratio,3) × 2；总分 = clamp(100 − Σ, 0, 100)
 * 纯旁路：不改现有 computeDiffs 输出，仅在 CompareResult.layered 追加返回。
 */
import type {
  ErrorDim,
  ErrorLevel,
  LayeredErrorItem,
  LayeredRunSummary,
  LayeredToleranceConfig,
  MatchPair
} from '../shared/types'
import { classifyPair } from './classify'

/** 小于该尺寸的元素不参与计算（与 diff.ts MIN_ELEM_SIZE 同口径） */
const MIN_ELEM_SIZE = 8

/** 条目上限（与 diff.ts MAX_DIFFS 同口径） */
const MAX_ITEMS = 200

const round2 = (v: number): number => Math.round(v * 100) / 100
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

const DIM_LABEL: Record<ErrorDim, string> = { position: '位置', size: '尺寸' }
const LEVEL_LABEL: Record<ErrorLevel, string> = { module: '模块级', element: '元素级' }
const KIND_LABEL: Record<string, string> = { container: '容器', control: '控件', text: '文本' }

function severityByRatio(ratio: number): LayeredErrorItem['severity'] {
  return ratio >= 3 ? 'major' : ratio >= 2 ? 'minor' : 'suggestion'
}

function normRect(
  dom: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number }
): LayeredErrorItem['node']['rect'] {
  return {
    x: clamp01(dom.x / viewport.width),
    y: clamp01(dom.y / viewport.height),
    width: Math.max(0.004, Math.min(1, dom.width / viewport.width)),
    height: Math.max(0.004, Math.min(1, dom.height / viewport.height))
  }
}

/** 计算全部匹配对的分层误差旁路结果 */
export function computeLayered(
  pairs: MatchPair[],
  cfg: LayeredToleranceConfig,
  viewport: { width: number; height: number }
): LayeredRunSummary {
  const items: LayeredErrorItem[] = []
  let moduleAbsorbed = 0
  let elementReported = 0

  for (const pair of pairs) {
    const d = pair.design
    const m = pair.dom
    if (m.width < MIN_ELEM_SIZE || m.height < MIN_ELEM_SIZE) continue

    const { nodeKind, adaptable } = classifyPair(d, m)
    const level: ErrorLevel = nodeKind === 'container' ? 'module' : 'element'
    const posTol = level === 'module' ? cfg.modulePosTol : cfg.elementPosTol
    const sizeTol = level === 'module' ? cfg.moduleSizeTol : cfg.elementSizeTol

    // 位置维：中心点偏移
    const dcx = (d.x + d.width / 2) - (m.x + m.width / 2)
    const dcy = (d.y + d.height / 2) - (m.y + m.height / 2)
    const posDelta = Math.hypot(dcx, dcy)
    // 尺寸维：最大边偏差
    const dw = Math.abs(d.width - m.width)
    const dh = Math.abs(d.height - m.height)
    const sizeDelta = Math.max(dw, dh)

    // 文本节点与自适应容器跳过尺寸维（字号随内容/流式布局，尺寸常不精确）
    const dims: ErrorDim[] =
      nodeKind === 'text' || adaptable ? ['position'] : ['position', 'size']

    for (const dim of dims) {
      const tol = dim === 'position' ? posTol : sizeTol
      const delta = dim === 'position' ? posDelta : sizeDelta
      if (delta <= tol) continue

      const ratio = tol > 0 ? delta / tol : Infinity
      const weightLevel = level === 'module' ? cfg.weightModule : cfg.weightElement
      const weightDim = dim === 'position' ? cfg.weightPosition : cfg.weightSize
      // 模块级超容差：吸收不扣分；元素级：计扣分
      const verdict: LayeredErrorItem['verdict'] = level === 'module' ? 'absorbed' : 'reported'
      const score = verdict === 'reported' ? round2(weightLevel * weightDim * Math.min(ratio, 3) * 2) : 0

      if (verdict === 'absorbed') moduleAbsorbed += 1
      else elementReported += 1

      const dev =
        dim === 'position'
          ? { dx: round2(Math.abs(dcx)), dy: round2(Math.abs(dcy)), dw: 0, dh: 0 }
          : { dx: 0, dy: 0, dw: round2(dw), dh: round2(dh) }
      const name = d.name || m.name || '元素'
      items.push({
        level,
        dim,
        deviation: dev,
        delta: round2(delta),
        ratio: Number.isFinite(ratio) ? round2(ratio) : 999,
        severity: severityByRatio(ratio),
        verdict,
        score,
        adaptable,
        node: {
          nodeKind,
          designName: name,
          figmaNodeId: d.figmaNodeId,
          domPath: m.domPath,
          rect: normRect(m, viewport)
        },
        confidence: pair.confidence,
        description: `「${name}」${KIND_LABEL[nodeKind]}${LEVEL_LABEL[level]}${DIM_LABEL[dim]}偏差 ${round2(delta)}px（容差 ${tol}px，ratio ${round2(Math.min(ratio, 999))}），判定 ${verdict === 'absorbed' ? '模块吸收' : '计入扣分'}`
      })
    }
  }

  const totalScore = items.reduce((sum, it) => sum + it.score, 0)
  const severityOrder: Record<LayeredErrorItem['severity'], number> = {
    major: 0,
    minor: 1,
    suggestion: 2
  }
  items.sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      b.score - a.score ||
      b.confidence - a.confidence
  )

  return {
    enabled: true,
    score: Math.max(0, round2(100 - totalScore)),
    moduleAbsorbed,
    elementReported,
    items: items.slice(0, MAX_ITEMS)
  }
}
