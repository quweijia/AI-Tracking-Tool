import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
  /** 弹层底部附加区块（如「新建项目」快捷入口），点击后关闭弹层（用于打开新建弹窗等场景） */
  footer?: ReactNode
}

/**
 * 统一美化的下拉选择：自绘弹层（圆角卡片 + 阴影 + 选中高亮），
 * 替代 macOS 原生 select 菜单，风格与整体 UI 一致；
 * 弹层用 fixed 定位，避免被抽屉/弹窗的 overflow 裁剪，空间不足时自动向上翻转。
 */
export default function USelect({ value, onChange, options, className, disabled, placeholder, title, footer }: Props) {
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
    // 300 ≈ 弹层 max-height 270 + footer 高度，保证带 footer 时不溢出视口
    const up = r.bottom + 300 > window.innerHeight && r.top - 300 > 0
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
    // 滚动关闭弹层时排除弹层自身：弹层内滚轮滚动（弹层滚动条）不关闭，仅页面滚动才关闭
    const close = (e: Event) => {
      const t = e.target as Node | null
      if (t && popRef.current?.contains(t)) return
      setOpen(false)
    }
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
          <div className="u-select-list">
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
          {/* footer 点击后收起弹层。必须用 onClick：若在 mousedown 阶段卸载弹层，
              后续 click 事件因目标元素已移除 DOM 而不会派发，内部「新建项目」按钮
              的 onClick 不执行，弹窗打不开。click 在按钮上触发（开弹窗）后冒泡到
              此处关闭弹层；弹层 z-index 高于弹窗（弹窗内下拉需浮出），保持展开会
              遮挡随后打开的弹窗 */}
          {footer && (
            <div className="u-select-footer" onClick={() => setOpen(false)}>
              {footer}
            </div>
          )}
        </div>
      )}
    </span>
  )
}
