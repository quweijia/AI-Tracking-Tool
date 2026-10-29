/**
 * AI 视觉标注框吸附校正：
 * AI 模型返回的归一化坐标是视觉估算值，与真实元素矩形存在偏移。
 * 这里用走查时已采集的 DOM 树（截图轨）与 Figma 图层树（设计稿轨）中的
 * 精确元素矩形对 AI 框做吸附：找 IoU 最高的真实节点替换估算框，
 * 点/文本标注则吸附到所在最小节点的中心，measure/picker 保持不动。
 */
import type { Issue } from '../db'
import type { StyleNode } from '../../../shared/types'

/** rect 吸附阈值：IoU 低于该值视为 AI 框没有明确对应元素，保留原框 */
const SNAP_IOU = 0.18

/** 全页容器判定比例：宽高同时 ≥ 95% 画布的节点是页面画布本身，不参与吸附 */
const PAGE_RATIO = 0.95

/** 吸附数据源：截图轨用 DOM 树 + 视口尺寸，设计稿轨用 Figma 树 + Frame 尺寸 */
export interface AiRectRefineInput {
  domRoot?: StyleNode | null
  viewport?: { width: number; height: number }
  designRoot?: StyleNode | null
  frameSize?: { width: number; height: number }
}

interface PxRect {
  x: number
  y: number
  w: number
  h: number
}

const iou = (a: PxRect, b: PxRect): number => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  if (inter <= 0) return 0
  return inter / (a.w * a.h + b.w * b.h - inter)
}

/** 展平树为候选矩形列表：过滤无效/过小/全页画布节点 */
const collectRects = (root: StyleNode | null | undefined, W: number, H: number): { node: StyleNode; rect: PxRect }[] => {
  const out: { node: StyleNode; rect: PxRect }[] = []
  const walk = (n: StyleNode): void => {
    if (Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.width) && Number.isFinite(n.height)) {
      if (n.width >= 2 && n.height >= 2 && !(n.width >= W * PAGE_RATIO && n.height >= H * PAGE_RATIO)) {
        out.push({ node: n, rect: { x: n.x, y: n.y, w: n.width, h: n.height } })
      }
    }
    for (const c of n.children ?? []) walk(c)
  }
  if (root) walk(root)
  return out
}

/**
 * 就地校正 AI 视觉 Issue 的归一化标注坐标（仅 walk 链路调用，手动双图无比对树）。
 * 吸附在程序轨去重之前执行：AI 框与程序轨矩形精确重叠后，rectIoU 去重也更准。
 */
export function refineAiRects(rows: Issue[], input: AiRectRefineInput): void {
  // 按目标图准备两套坐标系：px 树矩形 → 归一化时除以画布宽高
  const sources = [
    { tree: input.domRoot, size: input.viewport, img: 'screenshot' as const },
    { tree: input.designRoot, size: input.frameSize, img: 'design' as const }
  ]
  const prepared = sources
    .filter((s) => s.tree && s.size && s.size.width > 4 && s.size.height > 4)
    .map((s) => ({ img: s.img, W: s.size!.width, H: s.size!.height, rects: collectRects(s.tree, s.size!.width, s.size!.height) }))
    .filter((s) => s.rects.length > 0)
  if (!prepared.length) return

  for (const row of rows) {
    if (row.shape === 'measure' || row.shape === 'picker') continue
    const src = prepared.find((s) => s.img === (row.targetImage === 'design' ? 'design' : 'screenshot'))
    if (!src) continue
    const { W, H } = src
    if (row.shape === 'rect') {
      const box: PxRect = { x: row.x * W, y: row.y * H, w: row.width * W, h: row.height * H }
      if (!(box.w > 1 && box.h > 1)) continue
      let best: { node: StyleNode; rect: PxRect } | null = null
      let bestIou = 0
      for (const cand of src.rects) {
        const v = iou(box, cand.rect)
        if (v > bestIou) {
          bestIou = v
          best = cand
        }
      }
      // 吸附到 IoU 最高的真实元素矩形（归一化回写）
      if (best && bestIou >= SNAP_IOU) {
        row.x = best.rect.x / W
        row.y = best.rect.y / H
        row.width = best.rect.w / W
        row.height = best.rect.h / H
      }
    } else {
      // point/text：找包含标注点的最小面积节点，吸附到其中心
      const px = (row.x + row.width / 2) * W
      const py = (row.y + row.height / 2) * H
      let best: { node: StyleNode; rect: PxRect } | null = null
      for (const cand of src.rects) {
        const r = cand.rect
        if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
          if (!best || r.w * r.h < best.rect.w * best.rect.h) best = cand
        }
      }
      if (best) {
        row.x = (best.rect.x + best.rect.w / 2) / W
        row.y = (best.rect.y + best.rect.h / 2) / H
        row.width = 0
        row.height = 0
      }
    }
  }
}
