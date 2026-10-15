import { useEffect, useRef, useState } from 'react'
import type { Issue, TargetImage, AnnotationShape } from '../db'

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
  /** 叠加模式图层：铺满叠加画布，自带图片隐藏（仅保留取色/测距所需像素信息） */
  overlay?: boolean
  /** 按住空格平移中：暂停绘制与标注拖拽，整块画布交给画布平移 */
  spacePan?: boolean
}

/** 拖拽过程中把坐标限制在 0~1 */
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** rgb → #RRGGBB */
const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase()

const SEVERITIES = ['suggestion', 'minor', 'major'] as const

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
  overlay,
  spacePan
}: Props) {
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

  /** 归一化矢量 → 实际像素距离（按图片原始尺寸） */
  const measurePx = (dx: number, dy: number): number => {
    const img = imgRef.current
    if (!img || !img.naturalWidth || !img.naturalHeight) return 0
    return Math.hypot(dx * img.naturalWidth, dy * img.naturalHeight)
  }

  const toNormalized = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current!.getBoundingClientRect()
    return {
      x: clamp01((clientX - rect.left) / rect.width),
      y: clamp01((clientY - rect.top) / rect.height)
    }
  }

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
          setDraftMeasure({ x1: start.x, y1: start.y, x2: cur.x, y2: cur.y })
        }
        const down = (ev: MouseEvent) => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mousedown', down, true)
          const cur = toNormalized(ev.clientX, ev.clientY)
          if (Math.hypot(cur.x - start.x, cur.y - start.y) > 0.005) {
            onQuickCreate?.(
              { x: start.x, y: start.y, width: cur.x - start.x, height: cur.y - start.y },
              targetImage,
              { measurePx: measurePx(cur.x - start.x, cur.y - start.y) }
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
          const shape = issue.shape ?? 'rect'
          const num = noOf ? noOf(issue) : idx + 1
          const statusCls = issue.status === 'fixed' ? 'status-fixed' : ''
          const sevCls = `severity-${issue.severity}`
          const flashCls = issue.id === flashId ? ' issue-flash' : ''
          // 自定义颜色：仅未修复状态生效（已修复保持绿色状态色）
          const useCustom = !!issue.color && issue.status !== 'fixed'
          // 拖拽移动中：用临时坐标覆盖原位置
          const R = dragPos && dragPos.id === issue.id ? dragPos.rect : issue

          if (shape === 'point') {
            return (
              <g key={issue.id}>
                <circle className="anno-point-hit" cx={pct(R.x)} cy={pct(R.y)} r={16} onMouseDown={editHandler(issue)} />
                <circle
                  className={`anno-point ${sevCls} ${statusCls}${flashCls}`}
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
                  className={`anno-arrow-line ${sevCls} ${statusCls}${flashCls}`}
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
            return (
              <text
                key={issue.id}
                className={`anno-text ${sevCls} ${statusCls}${flashCls}`}
                x={pct(R.x)}
                y={pct(R.y)}
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
                  className={`anno-measure-line ${sevCls} ${statusCls}${flashCls}`}
                  x1={pct(R.x)}
                  y1={pct(R.y)}
                  x2={pct(ex)}
                  y2={pct(ey)}
                  pointerEvents="none"
                  style={useCustom ? { stroke: issue.color! } : undefined}
                />
                <circle
                  className={`anno-measure-dot ${statusCls}${flashCls}`}
                  cx={pct(R.x)}
                  cy={pct(R.y)}
                  r={3.5}
                  pointerEvents="none"
                  style={useCustom ? { fill: issue.color! } : undefined}
                />
                <circle
                  className={`anno-measure-dot ${statusCls}${flashCls}`}
                  cx={pct(ex)}
                  cy={pct(ey)}
                  r={3.5}
                  pointerEvents="none"
                  style={useCustom ? { fill: issue.color! } : undefined}
                />
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
                <text
                  className={`anno-measure-label ${statusCls}${flashCls}`}
                  x={pct(mx)}
                  y={pct(my)}
                  dx={vertical ? 8 : 0}
                  dy={vertical ? 0 : -9}
                  textAnchor={vertical ? 'start' : 'middle'}
                  dominantBaseline="central"
                  pointerEvents="none"
                  style={useCustom ? { fill: issue.color! } : undefined}
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
            const hasPair = !!(issue.sampleA && issue.sampleB)
            return (
              <g key={issue.id}>
                <circle
                  className={`anno-point-hit`}
                  cx={pct(R.x)}
                  cy={pct(R.y)}
                  r={18}
                  onMouseDown={editHandler(issue)}
                />
                {/* 取样点色块：双取样时为设计稿色，旁边标注两个色值 */}
                <circle
                  className={`anno-pick-chip ${statusCls}${flashCls}`}
                  cx={pct(R.x)}
                  cy={pct(R.y)}
                  r={7}
                  pointerEvents="none"
                  stroke="#ffffff"
                  strokeWidth={1.5}
                  style={{ fill: issue.sampleA || issue.sampleB || issue.color || '#3b82f6' }}
                />
                <text
                  className={`anno-pick-label ${statusCls}${flashCls}`}
                  x={pct(R.x)}
                  y={pct(R.y)}
                  dx={11}
                  dy={hasPair ? -9 : 0}
                  dominantBaseline="central"
                  pointerEvents="none"
                >
                  {issue.sampleA ? `设计 ${issue.sampleA}` : issue.sampleB ? `开发 ${issue.sampleB}` : issue.description}
                </text>
                {hasPair && (
                  <text
                    className={`anno-pick-label ${statusCls}${flashCls}`}
                    x={pct(R.x)}
                    y={pct(R.y)}
                    dx={11}
                    dy={9}
                    dominantBaseline="central"
                    pointerEvents="none"
                  >
                    {`开发 ${issue.sampleB}`}
                  </text>
                )}
              </g>
            )
          }

          // rect（默认，兼容旧数据）
          return (
            <g key={issue.id}>
              <rect
                className={`anno-box ${sevCls} ${issue.isAISuggested && !issue.aiConfirmed ? 'ai-candidate' : ''} ${statusCls}${flashCls}`}
                x={pct(R.x)}
                y={pct(R.y)}
                width={pct(R.width)}
                height={pct(R.height)}
                onMouseDown={editHandler(issue)}
                style={useCustom ? { stroke: issue.color! } : undefined}
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
            <circle className="anno-measure-dot" cx={pct(draftMeasure.x1)} cy={pct(draftMeasure.y1)} r={3.5} />
            <circle className="anno-measure-dot" cx={pct(draftMeasure.x2)} cy={pct(draftMeasure.y2)} r={3.5} />
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
    </div>
  )
}
