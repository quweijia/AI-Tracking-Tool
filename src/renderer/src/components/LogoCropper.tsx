import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  /** 原图 data URL */
  src: string
  onCancel: () => void
  /** 确认裁剪：返回落盘后的相对路径与裁剪结果 dataUrl */
  onDone: (relativePath: string, dataUrl: string) => void | Promise<void>
}

const VIEW = 240 // 预览区边长（px）
const OUT = 256 // 裁剪输出边长（px）

/**
 * Logo 裁剪弹层：图片在方形预览区内拖动定位 + 滑杆缩放，
 * 确认后 canvas 按当前视窗裁出方形 PNG 并落盘（不引第三方裁剪依赖）。
 */
export default function LogoCropper({ src, onCancel, onDone }: Props) {
  const { t } = useTranslation('logoCropper')
  /** 缩放：1 = 恰好铺满预览区（cover 基准），可放大到 3 倍 */
  const [scale, setScale] = useState(1)
  /** 图片中心相对预览区中心的偏移（px，受边界约束） */
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 })
  const [saving, setSaving] = useState(false)
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  // 载入原图尺寸，初始居中且以 cover 基准铺满
  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
      setScale(1)
      setOffset({ x: 0, y: 0 })
    }
    img.src = src
  }, [src])

  /** 当前缩放下图片显示尺寸 */
  const base = Math.max(VIEW / (imgSize.w || 1), VIEW / (imgSize.h || 1))
  const dispW = imgSize.w * base * scale
  const dispH = imgSize.h * base * scale

  /** 偏移约束：图片始终覆盖预览区，不允许拖出空隙 */
  const clampOffset = (x: number, y: number) => {
    const maxX = Math.max(0, (dispW - VIEW) / 2)
    const maxY = Math.max(0, (dispH - VIEW) / 2)
    return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) }
  }

  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    dragRef.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y }
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = dragRef.current
    if (!d) return
    setOffset(clampOffset(d.ox + (e.clientX - d.px), d.oy + (e.clientY - d.py)))
  }

  const onPointerUp = () => {
    dragRef.current = null
  }

  /** 缩放变化时按比例约束偏移（保持视觉中心不跳） */
  const handleScale = (v: number) => {
    const ratio = base * v / (base * scale || 1)
    setScale(v)
    setOffset((o) => clampOffset(o.x * ratio, o.y * ratio))
  }

  const confirm = async () => {
    if (saving) return
    setSaving(true)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = OUT
      canvas.height = OUT
      const ctx = canvas.getContext('2d')!
      // 预览区 → 输出画布的映射系数：视窗 VIEW px 对应输出 OUT px；
      // 整图按显示尺寸×k 绘制到画布，超出部分即为裁掉区域；
      // 注意预览区图片位置 = 中心 ± offset（transform translate 正向右/下），此处符号须与之一致
      const k = OUT / VIEW
      const dx = (VIEW / 2 - dispW / 2 + offset.x) * k
      const dy = (VIEW / 2 - dispH / 2 + offset.y) * k
      ctx.drawImage(imgRef.current!, 0, 0, imgSize.w, imgSize.h, dx, dy, dispW * k, dispH * k)
      // 直接用 toDataURL（同步、可靠），data URL 字符串经 IPC 落盘，绕开 toBlob/ArrayBuffer 传输
      const dataUrl = canvas.toDataURL('image/png')
      const relativePath = await window.electronAPI.saveDataUrl(dataUrl)
      await onDone(relativePath, dataUrl)
    } catch (err) {
      console.error('Logo 裁剪保存失败', err)
      window.alert(t('alertSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal cropper-modal">
        <h3>{t('title')}</h3>
        <p className="cropper-tip">{t('tip')}</p>
        <div
          className="cropper-view"
          style={{ width: VIEW, height: VIEW }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <img
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            style={{
              position: 'absolute',
              width: dispW || undefined,
              height: dispH || undefined,
              left: `calc(50% - ${(dispW || 0) / 2}px)`,
              top: `calc(50% - ${(dispH || 0) / 2}px)`,
              transform: `translate(${offset.x}px, ${offset.y}px)`
            }}
          />
        </div>
        <div className="cropper-scale-row">
          <span className="cropper-scale-label">{t('zoomOut')}</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={scale}
            onChange={(e) => handleScale(Number(e.target.value))}
          />
          <span className="cropper-scale-label">{t('zoomIn')}</span>
        </div>
        <div className="modal-actions">
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button className="btn-primary" onClick={confirm} disabled={saving || !imgSize.w}>
            {saving ? t('saving') : t('confirmCrop')}
          </button>
        </div>
      </div>
    </div>
  )
}
