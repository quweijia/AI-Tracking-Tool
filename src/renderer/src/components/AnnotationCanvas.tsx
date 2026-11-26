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
  /** 吸色标注只显示色值（产品标注模式）：不带「设计/截图」前缀（UI 走查对比双画布仍用前缀区分来源） */
  pickerHexOnly?: boolean
  /** 吸色同步取样：另一画布（设计稿/截图）上报的归一化采样点，本画布镜像渲染放大镜（各图按自身尺寸取样） */
  mirrorLoupe?: { nx: number; ny: number } | null
  /** 吸色同步取样：本画布放大镜采样点变化/隐藏时上报（归一化坐标），由父层按「吸色工具 + 同步取样」门控 */
  onPickerPixel?: (p: { nx: number; ny: number } | null) => void
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

/** 点位序号徽章宽度：随位数自适应加宽（2/3 位数），左右各留 5px；单数 18px 保持正圆 */
const numBadgeW = (num: number): number => Math.max(18, Math.ceil(estTextWidth(String(num), 12) + 10))

const SEVERITIES = ['suggestion', 'minor', 'major'] as const

/** 浅色底（如白色）时点位序号自动切深色字，避免与底色融合；深色底用白字（报告/文档导出徽章共用） */
export function inkFor(hex: string): string {
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
  logicalWidth,
  pickerHexOnly,
  mirrorLoupe,
  onPickerPixel
}: Props) {
  const { t } = useTranslation('annotationCanvas')
  const svgRef = useRef<SVGSVGElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  /** 取样用整图 ImageData 缓存（一次性 getImageData，之后只查数组；按 img.src 失效） */
  const sampleDataRef = useRef<{ src: string; w: number; h: number; data: Uint8ClampedArray } | null>(null)
  const [draft, setDraft] = useState<NormalizedRect | null>(null)
  const [draftArrow, setDraftArrow] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  /** 测量工具：已点下的第一点 + 预览终点（第二次点击完成测量） */
  const [draftMeasure, setDraftMeasure] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  /** 拖拽移动中的标注（渲染时用临时坐标覆盖原位置） */
  const [dragPos, setDragPos] = useState<{ id: string; rect: NormalizedRect } | null>(null)

  /** 标记当前 mousedown 已被测量完成消费（阻止同一次点击在冒泡阶段开启新测量） */
  const measureDoneRef = useRef(false)
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

  /** 放大镜：光标视口坐标（圆跟手移动）+ 锁定图像整数像素（采样点逐格步进）+ 画布视口矩形 */
  const [loupe, setLoupe] = useState<{
    cx: number
    cy: number
    px: number
    py: number
    rect: { left: number; top: number; width: number; height: number }
  } | null>(null)
  /** 锁定的采样像素：逐像素步进动画趋近光标像素（缩小显示时 1 屏幕像素跨多个图像像素，
   *  直接映射会让放大镜内容一次跳好几格）；点击落点直接吸附，保证测量端点/取色与光标严格重合 */
  const curPxRef = useRef<{ px: number; py: number } | null>(null)
  /** 步进目标：光标下的精确图像像素 */
  const targetPxRef = useRef<{ px: number; py: number } | null>(null)
  /** 步进动画帧句柄 */
  const loupeRafRef = useRef<number | null>(null)
  const lastClientRef = useRef<{ x: number; y: number } | null>(null)
  const loupeRectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null)

  /** 吸色同步取样回调的镜像（publishLoupe/hideLoupe 在事件闭包里调用，ref 保持始终最新） */
  const onPickerPixelRef = useRef<Props['onPickerPixel']>(undefined)
  onPickerPixelRef.current = onPickerPixel

  /** 放大镜发布：光标坐标（圆跟手）+ 锁定像素（采样点）+ 图像显示盒 */
  const publishLoupe = () => {
    const cur = curPxRef.current
    const rect = loupeRectRef.current
    const cursor = lastClientRef.current
    if (!cur || !rect || !cursor) return
    setLoupe({ cx: cursor.x, cy: cursor.y, px: cur.px, py: cur.py, rect: { ...rect } })
    // 吸色同步取样：把采样点归一化后上报（对侧画布按自身图片尺寸取样镜像显示）
    const img = imgRef.current
    if (onPickerPixelRef.current && img?.naturalWidth && img.naturalHeight) {
      onPickerPixelRef.current({ nx: (cur.px + 0.5) / img.naturalWidth, ny: (cur.py + 0.5) / img.naturalHeight })
    }
  }

  /** 停止步进动画（吸附/隐藏/移出画布时调用） */
  const stopLoupeStep = () => {
    if (loupeRafRef.current !== null) {
      cancelAnimationFrame(loupeRafRef.current)
      loupeRafRef.current = null
    }
  }

  /** 隐藏放大镜并重置锁定状态（移出画布/ESC/右键/切图）：下次进入直接对齐光标像素 */
  const hideLoupe = () => {
    stopLoupeStep()
    targetPxRef.current = null
    curPxRef.current = null
    lastClientRef.current = null
    loupeRectRef.current = null
    setLoupe(null)
    onPickerPixelRef.current?.(null)
  }
  /** 测量/吸色工具且非平移态时启用放大镜 */
  const loupeActive = (tool === 'measure' || tool === 'picker') && !panMode && !spacePan

  // 切换工具/卸载时清理测量半成品（卸载同时停掉放大镜步进动画，避免 rAF 泄漏）
  useEffect(() => {
    setDraftMeasure(null)
    measureDoneRef.current = false
  }, [tool])
  useEffect(
    () => () => {
      setDraftMeasure(null)
      stopLoupeStep()
    },
    []
  )

  // 切换图片：像素锁定与取样缓存全部重置
  useEffect(() => {
    hideLoupe()
    sampleDataRef.current = null
  }, [dataUrl])

  /** 构建整图 ImageData 缓存（一次性 getImageData，之后只查数组；按 img.src 失效） */
  const ensureSampleData = () => {
    const img = imgRef.current
    if (!img || !img.naturalWidth || !img.naturalHeight) return null
    let entry = sampleDataRef.current
    if (entry && entry.src === img.src && entry.w === img.naturalWidth) return entry
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    try {
      ctx.drawImage(img, 0, 0)
      entry = {
        src: img.src,
        w: canvas.width,
        h: canvas.height,
        data: ctx.getImageData(0, 0, canvas.width, canvas.height).data
      }
    } catch {
      return null
    }
    sampleDataRef.current = entry
    return entry
  }

  /** 读取图上指定整数像素的颜色（hex），失败返回 null */
  const sampleColorAtPx = (px: number, py: number): string | null => {
    const entry = ensureSampleData()
    if (!entry) return null
    const cx = Math.min(entry.w - 1, Math.max(0, Math.round(px)))
    const cy = Math.min(entry.h - 1, Math.max(0, Math.round(py)))
    const o = (cy * entry.w + cx) * 4
    return rgbToHex(entry.data[o], entry.data[o + 1], entry.data[o + 2])
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

  /** 显示坐标 → 图像原始整数像素（floor + 钳制；floor 保证一个显示像素只对应唯一的图像像素） */
  const toImagePixel = (clientX: number, clientY: number): { px: number; py: number } | null => {
    const img = imgRef.current
    const rect = svgRef.current?.getBoundingClientRect()
    if (!img || !img.naturalWidth || !img.naturalHeight || !rect?.width || !rect?.height) return null
    const px = Math.floor(((clientX - rect.left) * img.naturalWidth) / rect.width)
    const py = Math.floor(((clientY - rect.top) * img.naturalHeight) / rect.height)
    return {
      px: Math.min(img.naturalWidth - 1, Math.max(0, px)),
      py: Math.min(img.naturalHeight - 1, Math.max(0, py))
    }
  }

  /** 图像整数像素 → 归一化坐标（取像素中心 +0.5，与采样/测量换算同一约定） */
  const pxToNormalized = (p: { px: number; py: number }): { x: number; y: number } | null => {
    const img = imgRef.current
    if (!img || !img.naturalWidth || !img.naturalHeight) return null
    return {
      x: clamp01((p.px + 0.5) / img.naturalWidth),
      y: clamp01((p.py + 0.5) / img.naturalHeight)
    }
  }

  /** 步进动画帧：锁定像素朝光标像素推进（间隔大按比例加速追赶，间隔小则严格一格一格走），
   *  每帧发布放大镜刷新内容；收敛到位自动停止，鼠标静止后无残留偏移 */
  const loupeStepFrame = () => {
    loupeRafRef.current = null
    const cur = curPxRef.current
    const target = targetPxRef.current
    if (!cur || !target || (cur.px === target.px && cur.py === target.py)) return
    const adv = (c: number, t: number) => {
      const gap = Math.abs(t - c)
      if (!gap) return c
      return c + Math.sign(t - c) * Math.min(gap, Math.max(1, Math.floor(gap / 6)))
    }
    curPxRef.current = { px: adv(cur.px, target.px), py: adv(cur.py, target.py) }
    publishLoupe()
    loupeRafRef.current = requestAnimationFrame(loupeStepFrame)
  }

  /** 指针事件 → 锁定像素 + 逐像素步进：目标恒为光标下的精确图像像素（floor 保证唯一映射），
   *  锁定像素经 rAF 动画逐格趋近——测量/吸色放大镜随鼠标一个一个像素移动，不再一次跨多格；
   *  snap=true（点击落点）跳过动画直接吸附，保证测量端点/取色像素与光标严格重合 */
  const lockPixelFromEvent = (clientX: number, clientY: number, snap = false): { px: number; py: number } | null => {
    const rect = svgRef.current?.getBoundingClientRect()
    const t = toImagePixel(clientX, clientY)
    if (!rect?.width || !rect?.height || !t) return null
    loupeRectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    lastClientRef.current = { x: clientX, y: clientY }
    if (snap || !curPxRef.current) {
      stopLoupeStep()
      targetPxRef.current = null
      curPxRef.current = { ...t }
      publishLoupe()
      return { ...t }
    }
    const cur = curPxRef.current
    // 显示比非整数时 floor 映射会跳像素（300% 缩放下 1 屏幕px 仍跨 ~1.3 图像px，部分像素鼠标停不上去）：
    // 小间隔（≤4 图像px）把步进目标钳到 ±1——放大镜一格一格走、停在任何像素上都稳；
    // 想去的像素被跳过时微移一下走一格即可；大间隔不钳制，保持加速追赶不拖沓
    const gx = Math.abs(t.px - cur.px)
    const gy = Math.abs(t.py - cur.py)
    if (gx <= 4 && gy <= 4) {
      targetPxRef.current = {
        px: cur.px + Math.sign(t.px - cur.px),
        py: cur.py + Math.sign(t.py - cur.py)
      }
    } else {
      targetPxRef.current = { ...t }
    }
    publishLoupe()
    if (loupeRafRef.current === null) loupeRafRef.current = requestAnimationFrame(loupeStepFrame)
    return { ...curPxRef.current }
  }

  /** 放大镜跟随：更新步进目标（光标像素），锁定像素由动画逐像素趋近 */
  const handleLoupeMove = (e: React.MouseEvent) => {
    lockPixelFromEvent(e.clientX, e.clientY)
  }

  /** 移出画布：放大镜隐藏并重置锁定状态 */
  const handleLoupeLeave = () => {
    hideLoupe()
  }

  // ESC 隐藏放大镜 / 右键拦截菜单 / 方向键逐像素微调：
  // 图片显示尺寸小于原始尺寸时，光标移动 1px 对应多个图像像素，鼠标无法逐像素选择——
  // 方向键每次移动 1 个图像像素（Shift 加速 10px），移动后点击/取样即用微调后的像素
  const loupeShown = loupe !== null
  useEffect(() => {
    if (!loupeShown) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        hideLoupe()
        return
      }
      const step = e.shiftKey ? 10 : 1
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
      if (!dx && !dy) return
      e.preventDefault()
      const img = imgRef.current
      const cur = curPxRef.current
      if (!img?.naturalWidth || !img.naturalHeight || !cur) return
      stopLoupeStep()
      targetPxRef.current = null
      curPxRef.current = {
        px: Math.min(img.naturalWidth - 1, Math.max(0, cur.px + dx)),
        py: Math.min(img.naturalHeight - 1, Math.max(0, cur.py + dy))
      }
      publishLoupe()
    }
    const onCtx = (e: MouseEvent) => {
      if (svgRef.current && e.target instanceof Node && svgRef.current.contains(e.target)) e.preventDefault()
      hideLoupe()
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
    // 测量刚完成的同一次 mousedown 已被消费（捕获阶段），不再开启新测量
    if (measureDoneRef.current) {
      measureDoneRef.current = false
      e.preventDefault()
      return
    }
    e.preventDefault()
    // 测量/吸色按下：锁定像素直接吸附光标下的精确像素（终止步进动画），端点/取色与光标严格重合
    if (loupeActive) lockPixelFromEvent(e.clientX, e.clientY, true)
    const start = toNormalized(e.clientX, e.clientY)

    if (tool === 'measure') {
      // 两点测量：第一点按下开始，移动预览，第二点按下完成
      // 起点/终点均取光标下像素的中心：与放大镜十字准星严格对齐，不产生偏移错位
      if (!draftMeasure) {
        const sp = curPxRef.current ?? toImagePixel(e.clientX, e.clientY)
        const sN = (sp && pxToNormalized(sp)) || start
        setDraftMeasure({ x1: sN.x, y1: sN.y, x2: sN.x, y2: sN.y })
        const move = (ev: MouseEvent) => {
          const p = lockPixelFromEvent(ev.clientX, ev.clientY)
          const cur = (p && pxToNormalized(p)) || toNormalized(ev.clientX, ev.clientY)
          // 按住 Shift 吸附到 0/30/45/60/90°（含镜像方向）
          const end = ev.shiftKey ? snapMeasure(sN, cur) : cur
          setDraftMeasure({ x1: sN.x, y1: sN.y, x2: end.x, y2: end.y })
        }
        const down = (ev: MouseEvent) => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mousedown', down, true)
          // 阻止本次按下默认行为：间隔较近的两次点击会被浏览器判为双击选词/拖选，导致整页文字被选中
          ev.preventDefault()
          // 仅当完成点击落在画布内才置消费旗标——画布外完成时冒泡不会进画布，
          // 旗标残留会吞掉下一次测量的第一下（表现为「点第一下没反应」）
          if (svgRef.current && ev.target instanceof Node && svgRef.current.contains(ev.target)) {
            measureDoneRef.current = true // 标记当前点击已被消费，阻止冒泡阶段开启新测量
            // 兜底自动清除：完成点击若落在已有标注上（stopPropagation 拦截冒泡），旗标无人消费而
            // 残留，下一次测量的第一下会被吞掉；同一次点击的冒泡处理在同一任务内同步执行，
            // 仍能看到旗标，不受本次清除影响
            window.setTimeout(() => {
              measureDoneRef.current = false
            }, 0)
          }
          const p = lockPixelFromEvent(ev.clientX, ev.clientY, true)
          const cur = (p && pxToNormalized(p)) || toNormalized(ev.clientX, ev.clientY)
          const end = ev.shiftKey ? snapMeasure(sN, cur) : cur
          if (Math.hypot(end.x - sN.x, end.y - sN.y) > 0.005) {
            onQuickCreate?.(
              { x: sN.x, y: sN.y, width: end.x - sN.x, height: end.y - sN.y },
              targetImage,
              { measurePx: measurePx(end.x - sN.x, end.y - sN.y) }
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
        // 取锁定像素（同像素内微动不改变取样点），兜底用按下点换算；标注位置取像素中心
        const p = curPxRef.current ?? toImagePixel(e.clientX, e.clientY)
        const pos = p ? pxToNormalized(p) : null
        if (!p || !pos) return
        const hex = sampleColorAtPx(p.px, p.py)
        if (hex) onQuickCreate?.({ x: pos.x, y: pos.y, width: 0, height: 0 }, targetImage, { colorHex: hex })
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
          {/* 已修复状态专用箭头：线随状态变绿，三角头同步变绿 */}
          <marker
            id={`ah-${targetImage}-fixed`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="4.5"
            markerHeight="4.5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="arrow-head arrow-fixed" />
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
          // 备选问题未勾选：画布以虚线幽灵框显示（样式同 AI 候选），点击可编辑、清单卡片点击可聚焦定位
          const ghostCls = issue.level === 'optional' && issue.optionalChecked !== true ? ' issue-ghost' : ''
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
                {/* 序号徽章：圆角胶囊随位数自适应加宽（rx=9 两端保持半圆） */}
                <rect
                  className={`anno-point ${sevCls} ${statusCls}${flashCls}${focusCls}`}
                  x={R.x * canvasSize.w - numBadgeW(num) / 2}
                  y={R.y * canvasSize.h - 9}
                  width={numBadgeW(num)}
                  height={18}
                  rx={9}
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
                    issue.status === 'fixed'
                      ? `url(#ah-${targetImage}-fixed)`
                      : useCustom
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
            // 贴右边缘时文字改向左侧延伸，避免超出画板（描述含 \n 时按最长行估算宽度）
            const lines = issue.description.split('\n')
            const textW = Math.max(0, ...lines.map((ln) => estTextWidth(ln, 14)))
            const flip = R.x * canvasW + textW + 4 > canvasW
            // 产品标注：参考走查 point 样式在锚点画序号圆点，明确标注的是哪个点
            const withPoint = pickerHexOnly
            return (
              <g key={issue.id}>
                {withPoint && (
                  <>
                    <circle className="anno-point-hit" cx={pct(R.x)} cy={pct(R.y)} r={16} onMouseDown={editHandler(issue)} />
                    {/* 序号徽章：圆角胶囊随位数自适应加宽 */}
                    <rect
                      className={`anno-point ${sevCls} ${statusCls}${flashCls}${focusCls}`}
                      x={R.x * canvasSize.w - numBadgeW(num) / 2}
                      y={R.y * canvasSize.h - 9}
                      width={numBadgeW(num)}
                      height={18}
                      rx={9}
                      pointerEvents="none"
                      style={useCustom ? { fill: issue.color! } : undefined}
                    />
                    <text
                      className={`anno-num point-num ${statusCls}`}
                      x={pct(R.x)}
                      y={pct(R.y)}
                      textAnchor="middle"
                      dominantBaseline="central"
                      pointerEvents="none"
                      style={useCustom ? { fill: inkFor(issue.color!) } : undefined}
                    >
                      {num}
                    </text>
                  </>
                )}
                {/* 序号：走查模式文字向右延伸时放起点左侧，向左延伸时放起点右侧（与测量标注序号同款样式） */}
                {!withPoint && (
                  <text
                    className={`anno-num ${sevCls}`}
                    x={pct(R.x)}
                    y={pct(R.y)}
                    dx={flip ? 10 : -10}
                    textAnchor={flip ? 'start' : 'end'}
                    pointerEvents="none"
                  >
                    {num}
                  </text>
                )}
                <text
                  className={`anno-text ${sevCls} ${statusCls}${flashCls}${focusCls}`}
                  x={pct(R.x)}
                  y={pct(R.y)}
                  dx={withPoint ? (flip ? -13 : 13) : flip ? 10 : -10}
                  textAnchor={flip ? 'end' : 'start'}
                  dominantBaseline={withPoint ? 'central' : undefined}
                  onMouseDown={editHandler(issue)}
                  style={useCustom ? { fill: issue.color! } : undefined}
                >
                  {/* 按 \n 拆行渲染：产品模式整块相对点位垂直居中，走查模式保持末行基线不变；空行用空格占位保证行距推进 */}
                  {lines.map((ln, idx) => (
                    <tspan
                      key={idx}
                      x={pct(R.x)}
                      dx={withPoint ? (flip ? -13 : 13) : flip ? 10 : -10}
                      dy={idx === 0 ? (withPoint ? -((lines.length - 1) / 2) * 18 : -(lines.length - 1) * 18) : 18}
                    >
                      {ln || ' '}
                    </tspan>
                  ))}
                </text>
              </g>
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
                    className={`anno-measure-line ${sevCls} ${statusCls}${flashCls}${focusCls}`}
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
            // 按画布类型只显示对应色值：设计稿显示 sampleA，开发截图显示 sampleB；
            // pickerHexOnly 模式（产品标注）去掉「设计/截图」前缀，只保留色值
            const hexValue = targetImage === 'design' ? issue.sampleA : issue.sampleB
            const displayText = hexValue
              ? (pickerHexOnly ? hexValue : (targetImage === 'design' ? t('pickerLabelDesign', { hex: hexValue }) : t('pickerLabelShot', { hex: hexValue })))
              : (issue.description.length > 40 ? `${issue.description.slice(0, 40)}…` : issue.description)
            // 点位色块：外侧描边与取样色形成对比（白色取样→深色描边，深色取样→白色描边），浅底/深底都可见
            const chipFill = hexValue || issue.color || (targetImage === 'design' ? '#3b82f6' : '#ef4444')
            // 贴右边缘时色值翻转到点位左侧，避免超出画板
            const flip = R.x * canvasW + 11 + estTextWidth(displayText, 12) + 4 > canvasW
            // 产品标注：色块圆点参考走查 point 样式放大并内嵌序号，明确取样的是哪个点
            const withPoint = pickerHexOnly
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
                {/* 取样点色块：先画色块再画序号（序号内嵌色块中心不被遮挡）；产品标注模式徽章胶囊随位数加宽 */}
                {withPoint ? (
                  <rect
                    className={`anno-pick-chip ${statusCls}${flashCls}${focusCls}`}
                    x={R.x * canvasSize.w - numBadgeW(num) / 2}
                    y={R.y * canvasSize.h - 9}
                    width={numBadgeW(num)}
                    height={18}
                    rx={9}
                    pointerEvents="none"
                    stroke={inkFor(chipFill)}
                    strokeWidth={1.5}
                    style={{ fill: chipFill }}
                  />
                ) : (
                  <circle
                    className={`anno-pick-chip ${statusCls}${flashCls}${focusCls}`}
                    cx={pct(R.x)}
                    cy={pct(R.y)}
                    r={7}
                    pointerEvents="none"
                    stroke={inkFor(chipFill)}
                    strokeWidth={1.5}
                    style={{ fill: chipFill }}
                  />
                )}
                {/* 序号：走查模式放点位旁侧；产品标注模式内嵌色块圆点中心 */}
                {withPoint ? (
                  <text
                    className={`anno-num point-num ${statusCls}`}
                    x={pct(R.x)}
                    y={pct(R.y)}
                    textAnchor="middle"
                    dominantBaseline="central"
                    pointerEvents="none"
                    style={{ fill: inkFor(chipFill) }}
                  >
                    {num}
                  </text>
                ) : (
                  <text
                    className={`anno-num ${sevCls}`}
                    x={pct(R.x)}
                    y={pct(R.y)}
                    dx={flip ? 11 : -11}
                    textAnchor={flip ? 'start' : 'end'}
                    dominantBaseline="central"
                    pointerEvents="none"
                  >
                    {num}
                  </text>
                )}
                {/* 颜色文字标签：可点击打开详情 */}
                <text
                  className={`anno-pick-label ${statusCls}${flashCls}${focusCls}`}
                  x={pct(R.x)}
                  y={pct(R.y)}
                  dx={(withPoint ? 13 : 11) * (flip ? -1 : 1)}
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
                className={`anno-box ${sevCls} ${issue.isAISuggested && !issue.aiConfirmed ? 'ai-candidate' : ''} ${ghostCls}${statusCls}${flashCls}${focusCls}`}
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
      {loupeActive && loupe && (
        <PixelLoupe dataUrl={dataUrl} clientX={loupe.cx} clientY={loupe.cy} px={loupe.px} py={loupe.py} rect={loupe.rect} />
      )}
      {/* 吸色同步取样镜像放大镜：对侧画布悬停时按同一归一化位置在本图取样显示（设计稿/截图尺寸不同各自换算） */}
      {loupeActive &&
        !loupe &&
        mirrorLoupe &&
        (() => {
          const rect = svgRef.current?.getBoundingClientRect()
          const img = imgRef.current
          if (!rect?.width || !rect?.height || !img?.naturalWidth || !img.naturalHeight) return null
          const cx = rect.left + mirrorLoupe.nx * rect.width
          const cy = rect.top + mirrorLoupe.ny * rect.height
          const px = Math.min(img.naturalWidth - 1, Math.floor(mirrorLoupe.nx * img.naturalWidth))
          const py = Math.min(img.naturalHeight - 1, Math.floor(mirrorLoupe.ny * img.naturalHeight))
          return <PixelLoupe dataUrl={dataUrl} clientX={cx} clientY={cy} px={px} py={py} rect={rect} />
        })()}
    </div>
  )
}
