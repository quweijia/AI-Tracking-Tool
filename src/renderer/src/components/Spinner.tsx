import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

/** 加载指示：圆环 + 可见文案，role="status" 供读屏播报 */
export function Spinner({ label }: { label?: string }): ReactElement {
  const { t } = useTranslation()
  const text = label ?? t('loading')

  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="spinner-label">{text}</span>
    </span>
  )
}
