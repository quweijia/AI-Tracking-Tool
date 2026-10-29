import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface USelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface Props {
  value: string
  onChange: (value: string) => void
  options: USelectOption[]
  /** 附加到外壳的类名（保留 status-select 等配色类） */
  className?: string
  disabled?: boolean
  placeholder?: string
  title?: string
}

/**
 * 统一美化的下拉选择：自绘弹层（圆角卡片 + 阴影 + 选中高亮），
 * 替代 macOS 原生 select 菜单，风格与整体 UI 一致；
 * 弹层用 fixed 定位，避免被抽屉/弹窗的 overflow 裁剪，空间不足时自动向上翻转。
 */
export default function USelect({ value, onChange, options, className, disabled, placeholder, title }: Props) {
  const { t } = useTranslation('uSelect')
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number; up: boolean } | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const current = options.find((o) => o.value === value)

  const openPop = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const up = r.bottom + 270 > window.innerHeight && r.top - 270 > 0
    setPos({ left: r.left, top: up ? r.top - 6 : r.bottom + 6, minWidth: r.width, up })
    setOpen(true)
  }

  // 弹层展开后按实际宽度校正水平位置：右缘超出屏幕时右对齐按钮右缘
  useLayoutEffect(() => {
    if (!open || !pos) return
    const el = popRef.current
    if (!el) return
    const w = el.offsetWidth
    const right = pos.left + Math.max(pos.minWidth, w)
    if (right > window.innerWidth - 8) {
      setPos({ ...pos, left: Math.max(8, pos.left + pos.minWidth - w) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggle = () => {
    if (disabled) return
    if (open) setOpen(false)
    else openPop()
  }

  // 外点 / Esc / 滚动 / 缩放时关闭弹层
  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const close = () => setOpen(false)
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <span ref={wrapRef} className={`u-select-wrap${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <button
        ref={btnRef}
        type="button"
        className="u-select-btn"
        disabled={disabled}
        onClick={toggle}
        title={title ?? current?.label}
      >
        <span className={`u-select-label${current ? '' : ' placeholder'}`}>{current?.label ?? placeholder ?? t('select')}</span>
        <svg
          className="u-select-chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && pos && (
        <div
          ref={popRef}
          className={`u-select-pop${pos.up ? ' up' : ''}`}
          style={{
            left: pos.left,
            top: pos.top,
            minWidth: Math.max(pos.minWidth, 132),
            ...(pos.up ? { transform: 'translateY(-100%)' } : null)
          }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              disabled={o.disabled}
              className={`u-select-item${o.value === value ? ' active' : ''}`}
              onClick={() => {
                if (o.disabled) return
                onChange(o.value)
                setOpen(false)
              }}
            >
              {o.label}
              {o.value === value && (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
