import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface LoupeRect {
  left: number
  top: number
  width: number
  height: number
}

interface Props {
  /** 当前画布图片（放大镜像素采样来源） */
  dataUrl: string
  /** 鼠标视口坐标：放大镜圆跟随光标移动保持跟手 */
  clientX: number
  clientY: number
  /** 父层锁定的采样像素：逐像素步进动画趋近光标像素（点击时精确吸附），内容与十字准星锚定于此 */
  px: number
  py: number
  /** 画布视口矩形（贴边翻转判断用） */
  rect: LoupeRect
}

/** 倍率范围与默认值（需求：默认 8 倍，滚轮 4~16） */
const ZOOM_MIN = 4
const ZOOM_MAX = 16
const ZOOM_DEFAULT = 8
/** 放大镜目标直径（按倍率取整到源像素网格，保证像素格对齐） */
const LOUPE_TARGET = 148
/** 与光标的偏移距离（避开光标与十字准星） */
const CURSOR_OFFSET = 18
/** 色值信息条尺寸 */
const CHIP_W = 118
const CHIP_H = 46

/** 像素放大镜（测量 / 吸色工具共用）：
 * 挂载在 body 的 fixed 图层（pointer-events: none）。
 * 圆随光标跟手移动；内容与十字准星锚定父层锁定的采样像素（始终为光标下的图像像素）。
 * 最近邻放大（关闭图像平滑）+ 浅灰像素网格 + 中心十字准线 + 侧边 HEX/RGB 色值条。
 * 滚轮调节倍率（capture 阶段拦截，避免冒泡触发外层画布缩放）。 */
export default function PixelLoupe({ dataUrl, clientX, clientY, px, py, rect }: Props) {
  const [zoom, setZoom] = useState(ZOOM_DEFAULT)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** 整图像素缓存：离屏 canvas（绘制源）+ ImageData 数组（中心取色），一次性读取、按 src 失效 */
  const sampleRef = useRef<{
    src: string
    canvas: HTMLCanvasElement
    w: number
    h: number
    data: Uint8ClampedArray
  } | null>(null)
  /** 图像原始尺寸（displayScale 定位换算用，加载完成后设置） */
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  /** 中心像素颜色（hex 未变化则跳过 setState） */
  const [color, setColor] = useState<{ hex: string; r: number; g: number; b: number } | null>(null)
  const lastHexRef = useRef<string | null>(null)

  // 切换设计稿/重新加载图片：重建整图像素缓存并重置倍率
  useEffect(() => {
    setZoom(ZOOM_DEFAULT)
    setDims(null)
    setColor(null)
    lastHexRef.current = null
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      const w = img.naturalWidth
      const h = img.naturalHeight
      if (!w || !h) return
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      try {
        ctx.drawImage(img, 0, 0)
        // 整图 ImageData 一次性读取，之后中心取色只查数组（禁止逐帧 getImageData）
        sampleRef.current = { src: dataUrl, canvas, w, h, data: ctx.getImageData(0, 0, w, h).data }
        setDims({ w, h })
      } catch {
        /* 跨域图片等取不到像素时保持缓存为空 */
      }
    }
    img.src = dataUrl
    return () => {
      cancelled = true
    }
  }, [dataUrl])

  // 滚轮调节倍率：capture 捕获阶段拦截，阻止冒泡触发外层画布缩放
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + (e.deltaY < 0 ? 2 : -2))))
    }
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [])

  // 重绘：锁定像素 / 倍率 / 图片变化时执行（像素锁定由父层状态机控制，同一像素内不重绘）
  useEffect(() => {
    const entry = sampleRef.current
    const canvas = canvasRef.current
    if (!entry || !canvas || !dims) return

    // 锁定像素钳制到图内（父层已钳制，这里兜底）
    const cx = Math.min(entry.w - 1, Math.max(0, Math.round(px)))
    const cy = Math.min(entry.h - 1, Math.max(0, Math.round(py)))

    // 半径取整使直径 = (2r+1)×倍率，中心采样像素精确居中、网格完美对齐
    const r = Math.max(2, Math.round(LOUPE_TARGET / (2 * zoom)))
    const srcSpan = 2 * r + 1
    const size = srcSpan * zoom
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // 关闭图像平滑：最近邻放大，清晰显示单个像素格
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, size, size)
    try {
      ctx.drawImage(entry.canvas, cx - r, cy - r, srcSpan, srcSpan, 0, 0, size, size)
    } catch {
      return
    }

    // 浅灰像素网格线（按倍率步进，偏移 0.5 保证 1px 细线）
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = 1; i <= 2 * r; i++) {
      const p = i * zoom + 0.5
      ctx.moveTo(p, 0)
      ctx.lineTo(p, size)
      ctx.moveTo(0, p)
      ctx.lineTo(size, p)
    }
    ctx.stroke()

    // 中心像素高亮框
    const c = size / 2
    ctx.strokeStyle = 'rgba(255, 92, 92, 0.9)'
    ctx.strokeRect(c - zoom / 2 + 0.5, c - zoom / 2 + 0.5, zoom - 1, zoom - 1)

    // 细十字准线（深色描边 + 白色细线，深浅底色都可见）
    // 准星穿过中心像素的正中心：画布测量端点锚定像素中心（px+0.5），两者严格对齐，消除十字光标与实测位置的偏移
    const drawCross = (w: number, style: string) => {
      const g = c
      ctx.lineWidth = w
      ctx.strokeStyle = style
      ctx.beginPath()
      ctx.moveTo(0, g)
      ctx.lineTo(size, g)
      ctx.moveTo(g, 0)
      ctx.lineTo(g, size)
      ctx.stroke()
    }
    drawCross(3, 'rgba(0, 0, 0, 0.55)')
    drawCross(1, 'rgba(255, 255, 255, 0.95)')

    // 中心像素色值（HEX / RGB）：读整图缓存数组，不做逐帧 getImageData
    const o = (cy * entry.w + cx) * 4
    const hex = `#${[entry.data[o], entry.data[o + 1], entry.data[o + 2]]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')}`.toUpperCase()
    if (hex !== lastHexRef.current) {
      lastHexRef.current = hex
      setColor({ hex, r: entry.data[o], g: entry.data[o + 1], b: entry.data[o + 2] })
    }
  }, [dims, zoom, px, py])

  // 倍率 → 放大镜直径
  const r = Math.max(2, Math.round(LOUPE_TARGET / (2 * zoom)))
  const size = (2 * r + 1) * zoom
  // 像素未就绪（图片加载中）不渲染，避免空白圆环闪现在错误位置
  if (!dims) return null

  // 圆随光标跟手：默认在光标右下方，贴近画布右/下边缘时翻转到左/上方；色值条贴放大镜外侧
  // 内容与十字准星锚定锁定像素（px/py），采样点逐格步进不跳格
  let lx = clientX + CURSOR_OFFSET
  let ly = clientY + CURSOR_OFFSET
  if (lx + size > rect.left + rect.width) lx = clientX - CURSOR_OFFSET - size
  if (ly + size > rect.top + rect.height) ly = clientY - CURSOR_OFFSET - size
  lx = Math.max(4, Math.min(lx, window.innerWidth - size - 4))
  ly = Math.max(4, Math.min(ly, window.innerHeight - size - 4))
  let chipX = lx + size + 10
  if (chipX + CHIP_W > rect.left + rect.width) chipX = lx - CHIP_W - 10
  chipX = Math.max(4, Math.min(chipX, window.innerWidth - CHIP_W - 4))
  const chipY = Math.max(4, Math.min(ly, window.innerHeight - CHIP_H - 4))

  return createPortal(
    <div style={{ position: 'fixed', left: 0, top: 0, zIndex: 9999, pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: lx,
          top: ly,
          width: size,
          height: size,
          borderRadius: '50%',
          overflow: 'hidden',
          border: '2px solid rgba(15, 23, 42, 0.9)',
          background: 'rgba(15, 23, 42, 0.35)',
          boxShadow: '0 6px 20px rgba(0, 0, 0, 0.35)'
        }}
      >
        <canvas ref={canvasRef} />
      </div>
      <div
        style={{
          position: 'absolute',
          left: chipX,
          top: chipY,
          width: CHIP_W,
          boxSizing: 'border-box',
          padding: '6px 9px',
          borderRadius: 6,
          background: 'rgba(15, 23, 42, 0.92)',
          color: '#f8fafc',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 11,
          lineHeight: 1.5,
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>{color ? color.hex : '------'}</span>
          <span style={{ opacity: 0.7 }}>×{zoom}</span>
        </div>
        <div style={{ opacity: 0.85 }}>
          {color ? `rgb(${color.r}, ${color.g}, ${color.b})` : 'rgb(-, -, -)'}
        </div>
      </div>
    </div>,
    document.body
  )
}
