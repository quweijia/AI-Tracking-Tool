import { useEffect, useRef, useSyncExternalStore, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

/** 对话框语义档：danger 用于删除/清空等破坏性操作，确认键改用危险色 */
export type ConfirmTone = 'default' | 'danger'

export interface ConfirmDialogOptions {
  /** 标题；缺省时使用通用「确认操作」文案 */
  title?: string
  /** 正文提示（沿用原 confirm 文案，不做改写） */
  message: string
  /** 确认键文案；缺省「确定」 */
  confirmText?: string
  /** 取消键文案；缺省「取消」 */
  cancelText?: string
  tone?: ConfirmTone
}

interface ConfirmRequest extends ConfirmDialogOptions {
  id: number
  resolve: (ok: boolean) => void
}

/** 模块级队列：同一时刻只展示队首，保证原生 confirm 的串行语义 */
let seq = 0
let queue: ConfirmRequest[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): ConfirmRequest[] {
  return queue
}

function settle(id: number, ok: boolean): void {
  const target = queue.find((item) => item.id === id)
  if (!target) return
  queue = queue.filter((item) => item.id !== id)
  target.resolve(ok)
  emit()
}

/** 命令式确认对话框：返回 Promise<boolean>，等价于原生 confirm 的 true/false */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { ...options, id: ++seq, resolve }]
    emit()
  })
}

/** 确认对话框容器：与 Toast 同级挂载，层级低于 Toast、高于普通弹窗与下拉层 */
export function ConfirmDialogHost(): ReactElement | null {
  const { t } = useTranslation()
  const list = useSyncExternalStore(subscribe, getSnapshot)
  const active = list[0]
  const dialogRef = useRef<HTMLDivElement>(null)
  const prevFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return
    prevFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    return () => {
      prevFocusRef.current?.focus?.()
    }
  }, [active?.id])

  if (!active) return null

  const tone = active.tone ?? 'default'
  const confirmText = active.confirmText ?? t('confirm')
  const cancelText = active.cancelText ?? t('cancel')
  const title = active.title ?? t('confirmAction')
  const titleId = `confirm-dialog-title-${active.id}`
  const descId = `confirm-dialog-desc-${active.id}`

  return (
    <div
      className="modal-mask confirm-dialog-mask"
      onMouseDown={(e) => {
        // 仅点击遮罩本身取消；对话框内点击不触发
        if (e.target === e.currentTarget) settle(active.id, false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          settle(active.id, false)
        }
      }}
    >
      <div
        ref={dialogRef}
        className="modal confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
      >
        <h3 id={titleId}>{title}</h3>
        <p id={descId} className="confirm-dialog-message">
          {active.message}
        </p>
        <div className="modal-actions confirm-dialog-actions">
          <button type="button" className="btn-secondary" onClick={() => settle(active.id, false)}>
            {cancelText}
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'btn-danger' : 'btn-primary'}
            onClick={() => settle(active.id, true)}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
