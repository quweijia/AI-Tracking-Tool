import { useSyncExternalStore, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

/** 轻提示语义档：info 中性、success/warning/danger 分别对应左侧语义色条 */
export type ToastTone = 'info' | 'success' | 'warning' | 'danger'

export interface ToastOptions {
  tone?: ToastTone
  /** 自动关闭时长（毫秒），缺省 info/success/warning 3000、danger 5000 */
  duration?: number
  /** 操作按钮（如删除后的「撤销」）：点击后先关闭提示再执行回调 */
  action?: { label: string; onClick: () => void }
}

interface ToastItem {
  id: number
  message: string
  tone: ToastTone
  action?: ToastOptions['action']
}

let seq = 0
let items: ToastItem[] = []
const listeners = new Set<() => void>()
const timers = new Map<number, number>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): ToastItem[] {
  return items
}

function dismissToast(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    timers.delete(id)
  }
  const next = items.filter((item) => item.id !== id)
  if (next.length === items.length) return
  items = next
  emit()
}

/** 命令式轻提示：无需 Context，任意模块可直接调用 */
export function showToast(message: string, options: ToastOptions = {}): void {
  const tone = options.tone ?? 'info'
  const id = ++seq
  items = [...items, { id, message, tone, action: options.action }]
  const duration = options.duration ?? (tone === 'danger' ? 5000 : 3000)
  timers.set(
    id,
    window.setTimeout(() => dismissToast(id), duration)
  )
  emit()
}

/** 轻提示容器：常驻 aria-live 区域，保证新增提示能被读屏播报 */
export function ToastViewport(): ReactElement {
  const { t } = useTranslation()
  const list = useSyncExternalStore(subscribe, getSnapshot)

  return (
    <div className="toast-viewport" role="status" aria-live="polite" aria-atomic="false">
      {list.map((item) => (
        <div key={item.id} className={`toast toast-${item.tone}`}>
          <span className="toast-msg">{item.message}</span>
          {item.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                dismissToast(item.id)
                item.action?.onClick()
              }}
            >
              {item.action.label}
            </button>
          )}
          <button
            type="button"
            className="toast-close"
            aria-label={t('close')}
            onClick={() => dismissToast(item.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
