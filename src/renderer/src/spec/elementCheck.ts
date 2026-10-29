/**
 * 元素清单一致性校验：设计稿图层树（TEXT/结构）× webview 采集 DOM 树 → 清单级差异。
 * 与结构化尺寸比对不同，这里只回答三个设计师关心的问题：
 *  1. 页面上的图片是否加载失败（imgBroken）
 *  2. 设计稿里的文案元素页面上是否缺失（文本 multiset 精确匹配 + 位置邻近兜底）
 *  3. 同一位置的文案是否与设计稿不一致（动态数据场景降级为 suggestion，可忽略）
 * 输出为语言无关的结构化发现项，最终 Issue 描述由调用方（AutoWalkPanel）按当前语言拼装。
 */
import type { StyleNode } from '../../../shared/types'
import type { Category, Severity } from '../db'

/** 单条清单一致性发现（语言无关，落库前转 Issue） */
export interface ElementFinding {
  /** 问题类型 */
  kind: 'img-broken' | 'element-missing' | 'text-mismatch'
  /** 对齐问题清单分类 */
  category: Category
  severity: Severity
  /** 标注画在哪张图上：缺失类在设计稿上框选，其余在开发截图上 */
  targetImage: 'design' | 'screenshot'
  /** 归一化标注框（0~1，相对 targetImage 对应图片） */
  rect: { x: number; y: number; width: number; height: number }
  /** DOM 侧命中节点（img-broken / text-mismatch 时存在，回溯用） */
  node?: StyleNode
  /** 设计稿侧节点（element-missing / text-mismatch 时存在） */
  designNode?: StyleNode
  /** 设计稿文案 */
  designText?: string
  /** 页面实际文案（text-mismatch 时存在） */
  domText?: string
  /** DOM 选择器路径（回溯用） */
  domPath?: string
}

/** 单次走查发现总量上限：清单类问题重复度高，防刷屏 */
const MAX_FINDINGS = 30

/** 文本归一化 key：去所有空白 + 转小写，弱化排版差异 */
const textKey = (t: string): string => t.replace(/\s+/g, '').toLowerCase()

/** 文案不一致的近似判定：一方包含另一方（截断/省略号场景）或长度相近且字符重合过半 */
function textSimilar(a: string, b: string): boolean {
  const ka = textKey(a)
  const kb = textKey(b)
  if (!ka || !kb) return false
  if (ka === kb) return true
  if (ka.includes(kb) || kb.includes(ka)) return true
  const short = ka.length <= kb.length ? ka : kb
  const long = ka.length <= kb.length ? kb : ka
  if (short.length < 2) return false
  let hit = 0
  for (const ch of short) if (long.includes(ch)) hit++
  return hit / short.length >= 0.5 && Math.abs(ka.length - kb.length) <= Math.max(4, short.length)
}

/** 遍历树收集节点（含根） */
function flatten(root: StyleNode): StyleNode[] {
  const out: StyleNode[] = []
  const visit = (n: StyleNode): void => {
    out.push(n)
    for (const c of n.children ?? []) visit(c)
  }
  visit(root)
  return out
}

/**
 * 元素清单一致性校验主入口。
 * @param designRoot 设计稿 Frame 根节点（坐标相对 Frame）
 * @param domRoot DOM 采集根节点（坐标相对视口/文档）
 * @param frameSize 设计稿 Frame 尺寸（设计稿坐标 → 归一化框的分母）
 * @param viewport 页面视口尺寸（DOM 坐标 → 归一化框的分母）
 */
export function checkElements(
  designRoot: StyleNode,
  domRoot: StyleNode,
  frameSize: { width: number; height: number },
  viewport: { width: number; height: number }
): ElementFinding[] {
  const out: ElementFinding[] = []
  const fw = frameSize.width || 1
  const fh = frameSize.height || 1
  const vw = viewport.width || 1
  const vh = viewport.height || 1

  /** 设计稿坐标 → 页面视口近似坐标（等比映射，位置邻近判定用） */
  const toViewport = (n: StyleNode): { cx: number; cy: number } => ({
    cx: ((n.x + n.width / 2) / fw) * vw,
    cy: ((n.y + n.height / 2) / fh) * vh
  })

  // ── 1. 图片加载失败 ──────────────────────────────────────────
  const domNodes = flatten(domRoot)
  for (const node of domNodes) {
    if (node.imgBroken !== true) continue
    if (out.length >= MAX_FINDINGS) break
    out.push({
      kind: 'img-broken',
      category: 'missing-component',
      severity: 'major',
      targetImage: 'screenshot',
      rect: { x: node.x / vw, y: node.y / vh, width: node.width / vw, height: node.height / vh },
      node,
      domPath: node.domPath
    })
  }

  // ── 2/3. 文本清单比对 ────────────────────────────────────────
  // DOM 文本节点 multiset：key → 节点列表（同文案多处出现逐一消耗）
  const domTextNodes = domNodes.filter((n) => n.type === 'text' && n.text)
  const domTextMap = new Map<string, StyleNode[]>()
  for (const n of domTextNodes) {
    const key = textKey(n.text!)
    const list = domTextMap.get(key)
    if (list) list.push(n)
    else domTextMap.set(key, [n])
  }

  // 位置邻近查找：设计稿中心点映射到视口后，找中心距最近的 DOM 文本节点
  const nearestDomText = (dn: StyleNode): { node: StyleNode; dist: number } | null => {
    const { cx, cy } = toViewport(dn)
    let best: { node: StyleNode; dist: number } | null = null
    for (const n of domTextNodes) {
      const dx = n.x + n.width / 2 - cx
      const dy = n.y + n.height / 2 - cy
      const dist = Math.hypot(dx, dy)
      // 邻近阈值：设计稿节点高度的视口映射值与 40px 取大者，容忍响应式错位
      const tol = Math.max(40, (dn.height / fh) * vh)
      if (dist > tol) continue
      if (!best || dist < best.dist) best = { node: n, dist }
    }
    return best
  }

  const visitDesign = (n: StyleNode): void => {
    if (out.length < MAX_FINDINGS && n.type === 'text' && n.text && n.text.trim()) {
      const key = textKey(n.text)
      const exact = domTextMap.get(key)
      if (exact?.length) {
        // 精确命中：消耗一个同文案节点
        exact.shift()
      } else {
        const near = nearestDomText(n)
        if (!near) {
          // 页面上找不到该文案，位置附近也没有任何文本 → 元素缺失
          out.push({
            kind: 'element-missing',
            category: 'missing-component',
            severity: 'major',
            targetImage: 'design',
            rect: { x: n.x / fw, y: n.y / fh, width: n.width / fw, height: n.height / fh },
            designNode: n,
            designText: n.text
          })
        } else if (!textSimilar(n.text, near.node.text!)) {
          // 同位置有文本但内容对不上 → 文案不一致（动态数据场景常见，降级 suggestion）
          out.push({
            kind: 'text-mismatch',
            category: 'typography',
            severity: 'suggestion',
            targetImage: 'screenshot',
            rect: {
              x: near.node.x / vw,
              y: near.node.y / vh,
              width: near.node.width / vw,
              height: near.node.height / vh
            },
            node: near.node,
            designNode: n,
            designText: n.text,
            domText: near.node.text,
            domPath: near.node.domPath
          })
        }
      }
    }
    for (const c of n.children ?? []) visitDesign(c)
  }
  visitDesign(designRoot)

  return out
}
