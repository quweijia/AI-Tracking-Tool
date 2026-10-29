/**
 * 无埋点元素模糊匹配引擎：
 * 设计稿 StyleNode 树与 DOM StyleNode 树做 1:1 匹配，
 * 优先 data-figma-id 精准直通，其余按尺寸/宽高比/主色/文本/相对位置加权打分。
 */
import type { MatchPair, StyleNode } from '../shared/types'
import { colorDeltaE } from '../shared/color'

/** 置信度低于该值的匹配对进入人工确认抽屉 */
export const MATCH_CONFIRM_THRESHOLD = 0.6
/** 模糊匹配底线：低于该分数不成对 */
const MATCH_MIN_SCORE = 0.35

interface MatchContext {
  frameW: number
  frameH: number
  viewW: number
  viewH: number
}

interface FlatNode {
  node: StyleNode
  parent: FlatNode | null
  depth: number
}

/** 树 → 扁平列表（带父指针），并按 root 尺寸构建匹配上下文 */
function flatten(root: StyleNode): { list: FlatNode[]; w: number; h: number } {
  const list: FlatNode[] = []
  const w = root.width || 1
  const h = root.height || 1
  const walk = (node: StyleNode, parent: FlatNode | null, depth: number): void => {
    const item: FlatNode = { node, parent, depth }
    list.push(item)
    for (const child of node.children ?? []) walk(child, item, depth + 1)
  }
  walk(root, null, 0)
  return { list, w, h }
}

/** a 是否为 b 的祖先（含父级链） */
function isAncestor(a: FlatNode, b: FlatNode): boolean {
  let p: FlatNode | null = b.parent
  while (p) {
    if (p === a) return true
    p = p.parent
  }
  return false
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/** 文本相似度 0~1（两侧均无文本返回 null，由调用方剔除该因子） */
function textSimilarity(a: string | undefined, b: string | undefined): number | null {
  const ta = (a ?? '').trim().toLowerCase()
  const tb = (b ?? '').trim().toLowerCase()
  if (!ta && !tb) return null
  if (!ta || !tb) return 0.2
  if (ta === tb) return 1
  if (ta.includes(tb) || tb.includes(ta)) return 0.85
  const dist = levenshtein(ta.slice(0, 80), tb.slice(0, 80))
  return Math.max(0, 1 - dist / Math.max(ta.length, tb.length))
}

function pairScore(d: StyleNode, m: StyleNode, ctx: MatchContext): number {
  // 尺寸相似度（相对偏差均值）
  const sizeScore =
    1 -
    Math.min(
      1,
      (Math.abs(d.width - m.width) / Math.max(d.width, m.width, 1) +
        Math.abs(d.height - m.height) / Math.max(d.height, m.height, 1)) /
        2
    )
  // 宽高比相似度
  const aspectScore =
    d.aspectRatio && m.aspectRatio
      ? 1 - Math.min(1, Math.abs(d.aspectRatio - m.aspectRatio) / 1.5)
      : 0.5
  // 主色相似度（ΔE 45 视为完全不同）
  let colorScore = 0.5
  if (d.dominantColor && m.dominantColor) {
    const de = colorDeltaE(d.dominantColor, m.dominantColor)
    colorScore = de === null ? 0.5 : 1 - Math.min(1, de / 45)
  }
  // 相对位置（中心点归一化距离）
  const dcx = (d.x + d.width / 2) / ctx.frameW
  const dcy = (d.y + d.height / 2) / ctx.frameH
  const mcx = (m.x + m.width / 2) / ctx.viewW
  const mcy = (m.y + m.height / 2) / ctx.viewH
  const dist = Math.sqrt((dcx - mcx) ** 2 + (dcy - mcy) ** 2)
  const posScore = 1 - Math.min(1, dist / 0.4)
  // 文本相似度
  const textScore = textSimilarity(d.text, m.text)

  // 文本节点：文本权重最高；非文本节点：尺寸/颜色为主
  if (textScore !== null) {
    return sizeScore * 0.25 + textScore * 0.35 + colorScore * 0.15 + posScore * 0.15 + aspectScore * 0.1
  }
  return sizeScore * 0.4 + colorScore * 0.25 + posScore * 0.25 + aspectScore * 0.1
}

/** 设计稿/DOM 匹配：文本节点只与含文本 DOM 节点配对，其余与非文本配对 */
export function matchNodes(
  designRoot: StyleNode,
  domRoot: StyleNode
): { pairs: MatchPair[]; unmatchedDesignCount: number; unmatchedDomCount: number } {
  const design = flatten(designRoot)
  const dom = flatten(domRoot)
  const ctx: MatchContext = { frameW: design.w, frameH: design.h, viewW: dom.w, viewH: dom.h }

  const usedDesign = new Set<string>()
  const usedDom = new Set<string>()
  const pairs: MatchPair[] = []
  const domList = dom.list
  const designList = design.list

  // 1. data-figma-id 精准直通
  const designById = new Map(designList.map((it) => [it.node.figmaNodeId ?? it.node.id, it]))
  for (const mItem of domList) {
    const fid = mItem.node.dataFigmaId
    if (!fid || usedDom.has(mItem.node.id)) continue
    const dItem = designById.get(fid)
    if (!dItem || usedDesign.has(dItem.node.id)) continue
    pairs.push({ design: dItem.node, dom: mItem.node, confidence: 1, method: 'figma-id' })
    usedDesign.add(dItem.node.id)
    usedDom.add(mItem.node.id)
  }

  // 2. 模糊打分：收集全部候选对，按分数贪心 1:1 分配（两侧根节点不参与模糊匹配）
  const isText = (n: StyleNode): boolean => n.type === 'text' || !!(n.text && n.text.trim())
  interface Candidate {
    d: FlatNode
    m: FlatNode
    score: number
  }
  const candidates: Candidate[] = []
  for (const dItem of designList) {
    if (dItem.node.id === designRoot.id) continue
    const dText = isText(dItem.node)
    for (const mItem of domList) {
      if (mItem.node.id === domRoot.id || isText(mItem.node) !== dText) continue
      const score = pairScore(dItem.node, mItem.node, ctx)
      if (score >= MATCH_MIN_SCORE) candidates.push({ d: dItem, m: mItem, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  const fuzzyPairs: Candidate[] = []
  for (const c of candidates) {
    if (usedDesign.has(c.d.node.id) || usedDom.has(c.m.node.id)) continue
    // 层级交叉校验：设计稿侧的父子方向与 DOM 侧相反 → 冲突剔除
    let crossed = false
    for (const p of fuzzyPairs) {
      if (
        (isAncestor(c.d, p.d) && isAncestor(p.m, c.m)) ||
        (isAncestor(p.d, c.d) && isAncestor(c.m, p.m))
      ) {
        crossed = true
        break
      }
    }
    if (crossed) continue
    fuzzyPairs.push(c)
    usedDesign.add(c.d.node.id)
    usedDom.add(c.m.node.id)
  }
  for (const c of fuzzyPairs) {
    pairs.push({ design: c.d.node, dom: c.m.node, confidence: Math.round(c.score * 1000) / 1000, method: 'fuzzy' })
  }

  const matchedDesign = new Set(pairs.map((p) => p.design.id))
  const matchedDom = new Set(pairs.map((p) => p.dom.id))
  return {
    pairs,
    unmatchedDesignCount: designList.filter((it) => !matchedDesign.has(it.node.id)).length,
    unmatchedDomCount: domList.filter((it) => !matchedDom.has(it.node.id)).length
  }
}
