import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export interface UTreeNode {
  value: string
  label: string
  /** 节点前置 icon（如文件夹彩色图标） */
  icon?: ReactNode
  children?: UTreeNode[]
}

interface Props {
  value: string
  onChange: (value: string) => void
  nodes: UTreeNode[]
  /** 按钮显示文案覆盖（如选中文件夹时显示全层级路径） */
  displayLabel?: string
  className?: string
  disabled?: boolean
  placeholder?: string
  title?: string
  /** 弹层底部附加区块（如「新建文件夹」快捷入口），点击后关闭弹层（用于打开新建弹窗等场景） */
  footer?: ReactNode
  /** 节点右侧「+」回调（如在该文件夹下新建子文件夹）；value 为 '' 的节点（如「未分组」）不显示 */
  onNodeCreate?: (value: string, label: string) => void
}

/** 深度优先收集含子节点的 id（初始全部展开） */
function collectExpandable(nodes: UTreeNode[], acc: string[] = []): string[] {
  for (const n of nodes) {
    if (n.children?.length) {
      acc.push(n.value)
      collectExpandable(n.children, acc)
    }
  }
  return acc
}

/** 深度优先查找节点 label（按钮回显用） */
function findLabel(nodes: UTreeNode[], value: string): string | undefined {
  for (const n of nodes) {
    if (n.value === value) return n.label
    const hit = n.children ? findLabel(n.children, value) : undefined
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * 树形下拉选择：多级节点支持展开/折叠后逐级选择，
 * 弹层定位与关闭行为与 USelect 一致（fixed 防裁剪、空间不足向上翻转、外点/Esc/滚动关闭）。
 */
export default function UTreeSelect({
  value,
  onChange,
  nodes,
  displayLabel,
  className,
  disabled,
  placeholder,
  title,
  footer,
  onNodeCreate
}: Props) {
  const { t } = useTranslation('uSelect')
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number; up: boolean } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(collectExpandable(nodes)))
  const wrapRef = useRef<HTMLSpanElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const buttonLabel = displayLabel ?? findLabel(nodes, value)

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

  const toggleExpand = (v: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      return next
    })
  }

  const renderNodes = (list: UTreeNode[], depth: number): ReactNode =>
    list.map((n) => {
      const hasChildren = !!n.children?.length
      const isOpen = expanded.has(n.value)
      return (
        <div key={n.value} className="u-tree-branch">
          <button
            type="button"
            className={`u-select-item u-tree-item${n.value === value ? ' active' : ''}`}
            style={{ paddingLeft: 6 + depth * 16 }}
            onClick={() => {
              onChange(n.value)
              setOpen(false)
            }}
          >
            <span className="u-tree-main">
              {hasChildren ? (
                <span
                  className={`u-tree-toggle${isOpen ? ' open' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleExpand(n.value)
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </span>
              ) : (
                <span className="u-tree-toggle" />
              )}
              {n.icon && <span className="u-tree-icon">{n.icon}</span>}
              <span className="u-tree-label">{n.label}</span>
            </span>
            {/* 节点级「+」：在当前文件夹下新建子文件夹。外层是 button，故用 span
                （HTML 不允许 button 嵌套 button）；stopPropagation 防误触节点选中 */}
            {onNodeCreate && n.value !== '' && (
              <span
                role="button"
                className="u-tree-add"
                title={t('createSubfolder', { name: n.label })}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                  onNodeCreate(n.value, n.label)
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </span>
            )}
            {n.value === value && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20 6 9 17l-5-5" />
              </svg>
            )}
          </button>
          {hasChildren && isOpen && renderNodes(n.children!, depth + 1)}
        </div>
      )
    })

  return (
    <span ref={wrapRef} className={`u-select-wrap${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <button
        ref={btnRef}
        type="button"
        className="u-select-btn"
        disabled={disabled}
        onClick={toggle}
        title={title ?? buttonLabel}
      >
        <span className={`u-select-label${buttonLabel ? '' : ' placeholder'}`}>
          {buttonLabel ?? placeholder ?? t('select')}
        </span>
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
          <div className="u-select-list">{renderNodes(nodes, 0)}</div>
          {/* footer 点击后收起弹层。必须用 onClick：若在 mousedown 阶段卸载弹层，
              后续 click 事件因目标元素已移除 DOM 而不会派发，内部「新建文件夹」按钮
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
