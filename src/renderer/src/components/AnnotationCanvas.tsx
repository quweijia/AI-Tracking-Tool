import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Issue, TargetImage, AnnotationShape } from '../db'
import PixelLoupe from './PixelLoupe'

export interface NormalizedRect {
  x: number
  y: number
  width: number
  height: number
}

interface Props {
  dataUrl: string
  alt: string
  /** 该图上的标注框 */
  issues: Issue[]
  /** 当前标注工具（null = 仅浏览，不可绘制） */
  tool: AnnotationShape | null
  /** 抓手平移模式：标注层不拦截鼠标，拖拽交给外层画布 */
  panMode?: boolean
  /** 全局序号（与问题清单一致）；不传则按当前数组顺序编号 */
  noOf?: (issue: Issue) => number
  onCreate: (rect: NormalizedRect, targetImage: TargetImage) => void
  /** 直接创建（不弹编辑弹窗）：测量/吸色工具点击即生成标注，携带尺寸 px / 取样色 */
  onQuickCreate?: (
    rect: NormalizedRect,
    targetImage: TargetImage,
    data: { measurePx?: number; colorHex?: string }
  ) => void
  /** 拖拽移动已有标注后提交新位置 */
  onMove?: (issue: Issue, rect: NormalizedRect) => void
  onEdit: (issue: Issue) => void
  targetImage: TargetImage
  /** 需要高亮闪烁的标注 id（问题清单点击卡片时定位画布标注） */
  flashId?: string | null
  /** 聚焦模式：只渲染该标注，其余隐藏（问题清单点击卡片时双图同步聚焦） */
  focusId?: string | null
  /** 叠加模式图层：铺满叠加画布，自带图片隐藏（仅保留取色/测距所需像素信息） */
  overlay?: boolean
  /** 按住空格平移中：暂停绘制与标注拖拽，整块画布交给画布平移 */
  spacePan?: boolean
  /** 测量换算用逻辑宽度（图片原始宽 / 该值 = 高清采样倍率），不传按图片原始像素 */
  logicalWidth?: number
}

/** 拖拽过程中把坐标限制在 0~1 */
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** Shift 角度吸附候选角：0/30/45/60/90 及其镜像方向（全圆覆盖） */
const SNAP_ANGLES = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330]

/** rgb → #RRGGBB */
const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase()

/** 估算 SVG 文本像素宽（右侧贴边翻转判断用）：全角字符≈1em，其余≈0.62em */
const estTextWidth = (text: string, fontSize: number) =>
  [...text].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? fontSize : fontSize * 0.62), 0)

const SEVERITIES = ['suggestion', 'minor', 'major'] as const

/** 浅色底（如白色）时点位序号自动切深色字，避免与底色融合；深色底用白字 */
function inkFor(hex: string): string {
  const h = hex.replace('#', '')
  const v = h.length === 3
    ? h.split('').map((c) => c + c).join('')
    : h
  const r = parseInt(v.slice(0, 2), 16) || 0
  const g = parseInt(v.slice(2, 4), 16) || 0
  const b = parseInt(v.slice(4, 6), 16) || 0
  return 0.299 * r + 0.587 * g + 0.114 * b > 186 ? '#334155' : '#fff'
}

export default function AnnotationCanvas({
  dataUrl,
  alt,
  issues,
  tool,
  panMode,
  noOf,
  onCreate,
  onQuickCreate,
  onMove,
  onEdit,
  targetImage,
  flashId,
  focusId,
  overlay,
  spacePan,
  logicalWidth
}: Props) {
  const { t } = useTranslation('annotationCanvas')
  const svgRef = useRef<SVGSVGElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  /** 取样用的离屏画布缓存（按 img.src 失效） */
  const sampleCanvasRef = useRef<{ src: string; canvas: HTMLCanvasElement } | null>(null)
  const [draft, setDraft] = useState<NormalizedRect | null>(null)
  const [draftArrow, setDraftArrow] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  /** 测量工具：已点下的第一点 + 预览终点（第二次点击完成测量） */
  const [draftMeasure, setDraftMeasure] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  /** 拖拽移动中的标注（渲染时用临时坐标覆盖原位置） */
  const [dragPos, setDragPos] = useState<{ id: string; rect: NormalizedRect } | null>(null)

  /** 画布可视尺寸（测量⊥短线法向量换算用）：渲染期读 getBoundingClientRect 在 tab 隐藏/过渡态会拿到 0， */
  /** 改由 ResizeObserver 同步——隐藏→显示尺寸从 0 变化时自动触发重渲染，恢复正确短线长度 */
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (!r) return
      setCanvasSize((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }))
    })
    ro.observe(svg)
    return () => ro.disconnect()
  }, [])

  /** 放大镜：鼠标视口坐标 + 画布视口矩形（null = 不显示） */
  const [loupe, setLoupe] = useState<{
    cx: number
    cy: number
    rect: { left: number; top: number; width: number; height: number }
  } | null>(null)
  const loupeRafRef = useRef(0)
  const loupePendingRef = useRef<{
    cx: number
    cy: number
    rect: { left: number; top: number; width: number; height: number }
  } | null>(null)
  /** 测量/吸色工具且非平移态时启用放大镜 */
  const loupeActive = (tool === 'measure' || tool === 'picker') && !panMode && !spacePan

  // 切换工具/卸载时清理测量半成品
  useEffect(() => {
    setDraftMeasure(null)
  }, [tool])
  useEffect(() => () => setDraftMeasure(null), [])

  /** 读取图上指定归一化坐标的像素颜色（hex），失败返回 null */
  const sampleColor = (nx: number, ny: number): string | null => {
    const img = imgRef.current
    if (!img || !img.naturalWidth || !img.naturalHeight) return null
    let entry = sampleCanvasRef.current
    if (!entry || entry.src !== img.src) {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return null
      try {
        ctx.drawImage(img, 0, 0)
      } catch {
        return null
      }
      entry = { src: img.src, canvas }
      sampleCanvasRef.current = entry
    }
    const ctx = entry.canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    const px = Math.min(img.naturalWidth - 1, Math.max(0, Math.round(nx * img.naturalWidth)))
    const py = Math.min(img.naturalHeight - 1, Math.max(0, Math.round(ny * img.naturalHeight)))
    try {
      const d = ctx.getImageData(px, py, 1, 1).data
      return rgbToHex(d[0], d[1], d[2])
    } catch {
      return null
    }
  }

  /** 归一化矢量 → 实际像素距离（按图片原始尺寸；传 logicalWidth 时换算为逻辑尺寸，抵消高清采样倍率） */
  const measurePx = (dx: number, dy: number): number => {
    const img = imgRef.current
    if (!img || !img.naturalWidth || !img.naturalHeight) return 0
    const scale = logicalWidth ? img.naturalWidth / logicalWidth : 1
    return Math.hypot(dx * img.naturalWidth, dy * img.naturalHeight) / scale
  }

  /** Shift 角度吸附：在视觉像素空间把 start→end 矢量吸附到最近候选角（0/30/45/60/90° 及镜像），保持原长度 */
  const snapMeasure = (start: { x: number; y: number }, end: { x: number; y: number }) => {
    const rect = svgRef.current?.getBoundingClientRect()
    const W = rect?.width || 1
    const H = rect?.height || 1
    const vx = (end.x - start.x) * W
    const vy = (end.y - start.y) * H
    const len = Math.hypot(vx, vy)
    if (!len) return end
    const norm = ((((Math.atan2(vy, vx) * 180) / Math.PI) % 360) + 360) % 360
    let best = 0
    let bestDiff = 360
    for (const a of SNAP_ANGLES) {
      const diff = Math.abs(norm - a)
      const d = Math.min(diff, 360 - diff)
      if (d < bestDiff) {
        bestDiff = d
        best = a
      }
    }
    const rad = (best * Math.PI) / 180
    return {
      x: clamp01(start.x + (Math.cos(rad) * len) / W),
      y: clamp01(start.y + (Math.sin(rad) * len) / H)
    }
  }

  /** 测量端点⊥短线：视觉像素空间求垂直于测量方向的两端短线坐标（工程测量标注样式） */
  const measureTicks = (x1: number, y1: number, x2: number, y2: number) => {
    const W = canvasSize.w
    const H = canvasSize.h
    // 画布隐藏/过渡期尺寸为 0：|| 1 兜底会把 6px 偏移放大成数倍画布长的超长线，直接不渲染（显示后由 ResizeObserver 触发重渲染恢复）
    if (!W || !H) return []
    const len = Math.hypot((x2 - x1) * W, (y2 - y1) * H) || 1
    // 测量方向的单位法向量（视觉空间）
    const nx = (-(y2 - y1) * H) / len
    const ny = ((x2 - x1) * W) / len
    const tick = (px: number, py: number) => ({
      x1: px - (nx * 6) / W,
      y1: py - (ny * 6) / H,
      x2: px + (nx * 6) / W,
      y2: py + (ny * 6) / H
    })
    return [tick(x1, y1), tick(x2, y2)]
  }

  const toNormalized = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current!.getBoundingClientRect()
    return {
      x: clamp01((clientX - rect.left) / rect.width),
      y: clamp01((clientY - rect.top) / rect.height)
    }
  }

  /** 放大镜跟随：rAF 节流，mousemove 只记位置，每帧最多更新一次 */
  const handleLoupeMove = (e: React.MouseEvent) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    loupePendingRef.current = {
      cx: e.clientX,
      cy: e.clientY,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    }
    if (loupeRafRef.current) return
    loupeRafRef.current = requestAnimationFrame(() => {
      loupeRafRef.current = 0
      if (loupePendingRef.current) setLoupe(loupePendingRef.current)
    })
  }

  /** 移出画布：放大镜隐藏 */
  const handleLoupeLeave = () => {
    if (loupeRafRef.current) {
      cancelAnimationFrame(loupeRafRef.current)
      loupeRafRef.current = 0
    }
    loupePendingRef.current = null
    setLoupe(null)
  }

  // 卸载时清理未执行的 rAF
  useEffect(
    () => () => {
      if (loupeRafRef.current) cancelAnimationFrame(loupeRafRef.current)
    },
    []
  )

  // ESC / 右键：隐藏放大镜（右键在画布内时拦截默认菜单）
  const loupeShown = loupe !== null
  useEffect(() => {
    if (!loupeShown) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLoupe(null)
    }
    const onCtx = (e: MouseEvent) => {
      if (svgRef.current && e.target instanceof Node && svgRef.current.contains(e.target)) e.preventDefault()
      setLoupe(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('contextmenu', onCtx)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('contextmenu', onCtx)
    }
  }, [loupeShown])

  const handleMouseDown = (e: React.MouseEvent) => {
    // 点击已有标注（各形状的命中元素会 stopPropagation，不会走到这里）
    if (!tool || draft || draftArrow) return
    e.preventDefault()
    const start = toNormalized(e.clientX, e.clientY)

    if (tool === 'measure') {
      // 两点测量：第一点按下开始，移动预览，第二点按下完成
      if (!draftMeasure) {
        setDraftMeasure({ x1: start.x, y1: start.y, x2: start.x, y2: start.y })
        const move = (ev: MouseEvent) => {
          const cur = toNormalized(ev.clientX, ev.clientY)
          // 按住 Shift 吸附到 0/30/45/60/90°（含镜像方向）
          const end = ev.shiftKey ? snapMeasure(start, cur) : cur
          setDraftMeasure({ x1: start.x, y1: start.y, x2: end.x, y2: end.y })
        }
        const down = (ev: MouseEvent) => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mousedown', down, true)
          const cur = toNormalized(ev.clientX, ev.clientY)
          const end = ev.shiftKey ? snapMeasure(start, cur) : cur
          if (Math.hypot(end.x - start.x, end.y - start.y) > 0.005) {
            onQuickCreate?.(
              { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y },
              targetImage,
              { measurePx: measurePx(end.x - start.x, end.y - start.y) }
            )
          }
          setDraftMeasure(null)
        }
        window.addEventListener('mousemove', move)
        // 捕获阶段监听第二次按下，避免被标注层后续逻辑干扰
        window.addEventListener('mousedown', down, true)
      }
      return
    }

    if (tool === 'picker') {
      // 吸色：点击取像素色，直接标注色值
      let moved = false
      const move = (ev: MouseEvent) => {
        const cur = toNormalized(ev.clientX, ev.clientY)
        if (Math.hypot(cur.x - start.x, cur.y - start.y) > 0.005) moved = true
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        if (moved) return
        const hex = sampleColor(start.x, start.y)
        if (hex) onQuickCreate?.({ x: start.x, y: start.y, width: 0, height: 0 }, targetImage, { colorHex: hex })
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      return
    }

    if (tool === 'point' || tool === 'text') {
      // 点击放置：位移超过阈值视为误拖，不创建
      let moved = false
      const move = (ev: MouseEvent) => {
        const cur = toNormalized(ev.clientX, ev.clientY)
        if (Math.hypot(cur.x - start.x, cur.y - start.y) > 0.005) moved = true
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        if (!moved) onCreate({ x: start.x, y: start.y, width: 0, height: 0 }, targetImage)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      return
    }

    if (tool === 'arrow') {
      const move = (ev: MouseEvent) => {
        const cur = toNormalized(ev.clientX, ev.clientY)
        setDraftArrow({ x1: start.x, y1: start.y, x2: cur.x, y2: cur.y })
      }
      const up = (ev: MouseEvent) => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        setDraftArrow(null)
        const cur = toNormalized(ev.clientX, ev.clientY)
        // 箭头记录起点 + 矢量（宽高可为负表示方向）
        if (Math.hypot(cur.x - start.x, cur.y - start.y) > 0.02) {
          onCreate({ x: start.x, y: start.y, width: cur.x - start.x, height: cur.y - start.y }, targetImage)
        }
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      return
    }

    // rect 框选
    const move = (ev: MouseEvent) => {
      const cur = toNormalized(ev.clientX, ev.clientY)
      setDraft({
        x: Math.min(start.x, cur.x),
        y: Math.min(start.y, cur.y),
        width: Math.abs(cur.x - start.x),
        height: Math.abs(cur.y - start.y)
      })
    }
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      const cur = toNormalized(ev.clientX, ev.clientY)
      const rect: NormalizedRect = {
        x: Math.min(start.x, cur.x),
        y: Math.min(start.y, cur.y),
        width: Math.abs(cur.x - start.x),
        height: Math.abs(cur.y - start.y)
      }
      setDraft(null)
      // 过滤误触（点击而非拖框）
      if (rect.width > 0.01 && rect.height > 0.01) {
        onCreate(rect, targetImage)
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const pct = (n: number) => `${n * 100}%`
  const editHandler = (issue: Issue) => (e: React.MouseEvent) => {
    if (draft || draftArrow || dragPos) return
    if (panMode || spacePan) {
      // 抓手模式 / 空格平移：不拦截冒泡（拖拽继续平移画布），抬起时位移小于阈值视为点击 → 打开标注详情
      const sx = e.clientX
      const sy = e.clientY
      const up = (ev: MouseEvent) => {
        window.removeEventListener('mouseup', up)
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) onEdit(issue)
      }
      window.addEventListener('mouseup', up)
      return
    }
    e.stopPropagation()
    // 按住标注拖动可移动位置（位移超过 3px 视为拖拽）；松开后：拖拽仅更新位置，单击弹出详情弹窗
    const svgRect = svgRef.current?.getBoundingClientRect()
    if (!svgRect) return
    const sx = e.clientX
    const sy = e.clientY
    const start: NormalizedRect = { x: issue.x, y: issue.y, width: issue.width, height: issue.height }
    let cur = start
    let moved = false
    const move = (ev: MouseEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return
      moved = true
      cur = {
        x: clamp01(start.x + (ev.clientX - sx) / svgRect.width),
        y: clamp01(start.y + (ev.clientY - sy) / svgRect.height),
        width: start.width,
        height: start.height
      }
      setDragPos({ id: issue.id, rect: cur })
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setDragPos(null)
      if (moved && onMove) {
        // 拖拽移动：只更新位置，不再弹出详情
        onMove(issue, cur)
      } else {
        onEdit(issue)
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className={`img-wrap${overlay ? ' img-wrap-overlay' : ''}`}>
      <img ref={imgRef} src={dataUrl} alt={alt} draggable={false} />
      <svg
        ref={svgRef}
        className={`anno-svg ${tool && !spacePan ? 'annotating' : ''} ${panMode || spacePan ? 'pan-mode' : ''}`}
        onMouseDown={panMode || spacePan ? undefined : handleMouseDown}
        onMouseMove={loupeActive ? handleLoupeMove : undefined}
        onMouseLeave={loupeActive ? handleLoupeLeave : undefined}
      >
        <defs>
          {SEVERITIES.map((s) => (
            <marker
              key={s}
              id={`ah-${targetImage}-${s}`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="4.5"
              markerHeight="4.5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className={`arrow-head arrow-${s}`} />
            </marker>
          ))}
          <marker
            id={`ah-${targetImage}-draft`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="4.5"
            markerHeight="4.5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="arrow-head arrow-draft" />
          </marker>
          {/* 自定义颜色的箭头 marker（每种颜色一个） */}
          {[...new Set(issues.filter((i) => i.color && i.status !== 'fixed').map((i) => i.color!))].map(
            (c) => (
              <marker
                key={c}
                id={`ah-c-${targetImage}-${c.slice(1)}`}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="4.5"
                markerHeight="4.5"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: c }} />
              </marker>
            )
          )}
        </defs>

        {issues.map((issue, idx) => {
          // 聚焦模式：只显示当前聚焦的标注，其余隐藏
          if (focusId && issue.id !== focusId) return null
          const shape = issue.shape ?? 'rect'
          const num = noOf ? noOf(issue) : idx + 1
          const statusCls = issue.status === 'fixed' ? 'status-fixed' : ''
          const sevCls = `severity-${issue.severity}`
          const flashCls = issue.id === flashId ? ' issue-flash' : ''
          const focusCls = issue.id === focusId ? ' issue-focus' : ''
          // 自定义颜色：仅未修复状态生效（已修复保持绿色状态色）
          const useCustom = !!issue.color && issue.status !== 'fixed'
          // 拖拽移动中：用临时坐标覆盖原位置
          const R = dragPos && dragPos.id === issue.id ? dragPos.rect : issue
          // 画布当前显示宽度：右侧贴边翻转判断用（首帧读不到按 0 处理，即不翻转）
          const canvasW = svgRef.current?.getBoundingClientRect().width ?? 0

          if (shape === 'point') {
            return (
              <g key={issue.id}>
                <circle className="anno-point-hit" cx={pct(R.x)} cy={pct(R.y)} r={16} onMouseDown={editHandler(issue)} />
                <circle
                  className={`anno-point ${sevCls} ${statusCls}${flashCls}${focusCls}`}
                  cx={pct(R.x)}
                  cy={pct(R.y)}
                  r={9}
                  pointerEvents="none"
                  style={useCustom ? { fill: issue.color! } : undefined}
                />
                <text
                  className="anno-num point-num"
                  x={pct(R.x)}
                  y={pct(R.y)}
                  textAnchor="middle"
                  dominantBaseline="central"
                  pointerEvents="none"
                  style={useCustom ? { fill: inkFor(issue.color!) } : undefined}
                >
                  {num}
                </text>
              </g>
            )
          }

          if (shape === 'arrow') {
            const ex = R.x + R.width
            const ey = R.y + R.height
            const mx = (R.x + ex) / 2
            const my = (R.y + ey) / 2
            return (
              <g key={issue.id}>
                <line
                  className={`anno-arrow-line ${sevCls} ${statusCls}${flashCls}${focusCls}`}
                  x1={pct(R.x)}
                  y1={pct(R.y)}
                  x2={pct(ex)}
                  y2={pct(ey)}
                  markerEnd={
                    useCustom
                      ? `url(#ah-c-${targetImage}-${issue.color!.slice(1)})`
                      : `url(#ah-${targetImage}-${issue.severity})`
                  }
                  pointerEvents="none"
                  style={useCustom ? { stroke: issue.color! } : undefined}
                />
                <text
                  className={`anno-num ${sevCls}`}
                  x={pct(mx)}
                  y={pct(my)}
                  textAnchor="middle"
                  dominantBaseline="central"
                  pointerEvents="none"
                >
                  {num}
                </text>
                <line
                  className="anno-arrow-hit"
                  x1={pct(R.x)}
                  y1={pct(R.y)}
                  x2={pct(ex)}
                  y2={pct(ey)}
                  onMouseDown={editHandler(issue)}
                />
              </g>
            )
          }

          if (shape === 'text') {
            // 贴右边缘时文字改向左侧延伸，避免超出画板
            const flip = R.x * canvasW + estTextWidth(issue.description, 14) + 4 > canvasW
            return (
              <text
                key={issue.id}
                className={`anno-text ${sevCls} ${statusCls}${flashCls}${focusCls}`}
                x={pct(R.x)}
                y={pct(R.y)}
                textAnchor={flip ? 'end' : 'start'}
                onMouseDown={editHandler(issue)}
                style={useCustom ? { fill: issue.color! } : undefined}
              >
                {issue.description}
              </text>
            )
          }

          if (shape === 'measure') {
            const ex = R.x + R.width
            const ey = R.y + R.height
            const mx = (R.x + ex) / 2
            const my = (R.y + ey) / 2
            // 标签偏移方向：竖直线放右侧，水平/斜线放上方
            const vertical = Math.abs(R.width) < Math.abs(R.height)
            return (
              <g key={issue.id}>
                <line
                  className={`anno-measure-line ${sevCls} ${statusCls}${flashCls}${focusCls}`}
                  x1={pct(R.x)}
                  y1={pct(R.y)}
                  x2={pct(ex)}
                  y2={pct(ey)}
                  pointerEvents="none"
                  style={useCustom ? { stroke: issue.color! } : undefined}
                />
                {measureTicks(R.x, R.y, ex, ey).map((t, i) => (
                  <line
                    key={i}
                    className={`anno-measure-line ${statusCls}${flashCls}${focusCls}`}
                    x1={pct(t.x1)}
                    y1={pct(t.y1)}
                    x2={pct(t.x2)}
                    y2={pct(t.y2)}
                    pointerEvents="none"
                    style={useCustom ? { stroke: issue.color! } : undefined}
                  />
                ))}
                <text
                  className="anno-num"
                  x={pct(R.x)}
                  y={pct(R.y)}
                  dx={vertical ? 10 : -10}
                  textAnchor={vertical ? 'start' : 'end'}
                  dominantBaseline="central"
                  pointerEvents="none"
                >
                  {num}
                </text>
                {/* 测量值文字标签：同样支持点击打开详情 / 拖拽移动（文字不跟随自定义色：白色文字会与白描边融合） */}
                <text
                  className={`anno-measure-label ${statusCls}${flashCls}${focusCls}`}
                  x={pct(mx)}
                  y={pct(my)}
                  dx={vertical ? 8 : 0}
                  dy={vertical ? 0 : -9}
                  textAnchor={vertical ? 'start' : 'middle'}
                  dominantBaseline="central"
                  pointerEvents="auto"
                  onMouseDown={editHandler(issue)}
                >
                  {issue.measureValue || `${Math.round(Math.hypot(R.width, R.height) * 1000)}px`}
                </text>
                <line
                  className="anno-arrow-hit"
                  x1={pct(R.x)}
                  y1={pct(R.y)}
                  x2={pct(ex)}
                  y2={pct(ey)}
                  onMouseDown={editHandler(issue)}
                />
              </g>
            )
          }

          if (shape === 'picker') {
            // 按画布类型只显示对应色值：设计稿显示 sampleA，开发截图显示 sampleB
            const hexValue = targetImage === 'design' ? issue.sampleA : issue.sampleB
            const hexLabel = targetImage === 'design' ? t('pickerLabelDesign', { hex: hexValue }) : t('pickerLabelShot', { hex: hexValue })
            const displayText = hexValue ? hexLabel : (issue.description.length > 40 ? `${issue.description.slice(0, 40)}…` : issue.description)
            // 贴右边缘时色值翻转到点位左侧，避免超出画板
            const flip = R.x * canvasW + 11 + estTextWidth(displayText, 12) + 4 > canvasW
            return (
              <g key={issue.id}>
                {/* 大热区：点击打开编辑弹窗 */}
                <circle
                  className={`anno-point-hit`}
                  cx={pct(R.x)}
                  cy={pct(R.y)}
                  r={18}
                  onMouseDown={editHandler(issue)}
                />
                {/* 取样点色块 */}
                <circle
                  className={`anno-pick-chip ${statusCls}${flashCls}${focusCls}`}
                  cx={pct(R.x)}
                  cy={pct(R.y)}
                  r={7}
                  pointerEvents="none"
                  stroke="#ffffff"
                  strokeWidth={1.5}
                  style={{ fill: hexValue || issue.color || (targetImage === 'design' ? '#3b82f6' : '#ef4444') }}
                />
                {/* 颜色文字标签：可点击打开详情 */}
                <text
                  className={`anno-pick-label ${statusCls}${flashCls}${focusCls}`}
                  x={pct(R.x)}
                  y={pct(R.y)}
                  dx={flip ? -11 : 11}
                  dy={0}
                  textAnchor={flip ? 'end' : 'start'}
                  dominantBaseline="central"
                  style={{ cursor: 'pointer' }}
                  pointerEvents="auto"
                  onMouseDown={editHandler(issue)}
                >
                  {displayText}
                </text>
              </g>
            )
          }

          // rect（默认，兼容旧数据）：仅边框可点击/拖动，框内点击穿透以便其他工具继续标注
          return (
            <g key={issue.id}>
              <rect
                className={`anno-box ${sevCls} ${issue.isAISuggested && !issue.aiConfirmed ? 'ai-candidate' : ''} ${statusCls}${flashCls}${focusCls}`}
                x={pct(R.x)}
                y={pct(R.y)}
                width={pct(R.width)}
                height={pct(R.height)}
                pointerEvents="none"
                style={useCustom ? { stroke: issue.color! } : undefined}
              />
              {/* 边框命中区：宽透明 stroke 仅边框响应（pointerEvents="stroke"），框内事件穿透 */}
              <rect
                x={pct(R.x)}
                y={pct(R.y)}
                width={pct(R.width)}
                height={pct(R.height)}
                fill="none"
                stroke="transparent"
                strokeWidth={10}
                pointerEvents="stroke"
                style={{ cursor: 'pointer' }}
                onMouseDown={editHandler(issue)}
              />
              <text
                className={`anno-num ${sevCls}`}
                x={pct(R.x)}
                y={pct(R.y)}
                dominantBaseline="hanging"
                pointerEvents="none"
              >
                {num}
              </text>
            </g>
          )
        })}

        {draft && (
          <rect className="anno-draft" x={pct(draft.x)} y={pct(draft.y)} width={pct(draft.width)} height={pct(draft.height)} />
        )}
        {draftArrow && (
          <line
            className="anno-arrow-draft"
            x1={pct(draftArrow.x1)}
            y1={pct(draftArrow.y1)}
            x2={pct(draftArrow.x2)}
            y2={pct(draftArrow.y2)}
            markerEnd={`url(#ah-${targetImage}-draft)`}
          />
        )}
        {draftMeasure && (
          <>
            <line
              className="anno-measure-line anno-draft"
              x1={pct(draftMeasure.x1)}
              y1={pct(draftMeasure.y1)}
              x2={pct(draftMeasure.x2)}
              y2={pct(draftMeasure.y2)}
            />
            {measureTicks(
              draftMeasure.x1,
              draftMeasure.y1,
              draftMeasure.x2,
              draftMeasure.y2
            ).map((t, i) => (
              <line
                key={i}
                className="anno-measure-line anno-draft"
                x1={pct(t.x1)}
                y1={pct(t.y1)}
                x2={pct(t.x2)}
                y2={pct(t.y2)}
              />
            ))}
            <text
              className="anno-measure-label"
              x={pct((draftMeasure.x1 + draftMeasure.x2) / 2)}
              y={pct((draftMeasure.y1 + draftMeasure.y2) / 2)}
              dy={Math.abs(draftMeasure.x2 - draftMeasure.x1) >= Math.abs(draftMeasure.y2 - draftMeasure.y1) ? -9 : 0}
              dx={Math.abs(draftMeasure.x2 - draftMeasure.x1) >= Math.abs(draftMeasure.y2 - draftMeasure.y1) ? 0 : 8}
              textAnchor={
                Math.abs(draftMeasure.x2 - draftMeasure.x1) >= Math.abs(draftMeasure.y2 - draftMeasure.y1)
                  ? 'middle'
                  : 'start'
              }
              dominantBaseline="central"
            >
              {`${Math.round(
                measurePx(draftMeasure.x2 - draftMeasure.x1, draftMeasure.y2 - draftMeasure.y1)
              )}px`}
            </text>
          </>
        )}
      </svg>
      {loupeActive && loupe && <PixelLoupe dataUrl={dataUrl} clientX={loupe.cx} clientY={loupe.cy} rect={loupe.rect} />}
    </div>
  )
}
