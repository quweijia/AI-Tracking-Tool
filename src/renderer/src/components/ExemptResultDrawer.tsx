import { useTranslation } from 'react-i18next'
import type { StyleDiff } from '../../../shared/types'

interface Props {
  /** 最近一次结构化比对产生的圆角父级裁剪豁免项 */
  items: StyleDiff[]
  onClose: () => void
}

/** 圆角父级裁剪豁免项抽屉（只读旁路展示）：不落库、不进问题清单、不进报告 */
export default function ExemptResultDrawer({ items, onClose }: Props) {
  const { t } = useTranslation('exemptResultDrawer')

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal confirm-drawer-modal">
        <h3>{t('title')}</h3>
        <p className="confirm-drawer-sub">{t('desc')}</p>
        <div className="confirm-drawer-list">
          {items.length === 0 ? (
            <p className="lr-empty">{t('noItems')}</p>
          ) : (
            items.map((it, i) => (
              <div key={i} className="confirm-pair">
                <div className="confirm-pair-main">
                  <div className="confirm-pair-head">
                    <span className={`badge ${it.severity === 'major' ? 'badge-danger' : it.severity === 'minor' ? 'badge-warning' : 'badge-neutral'}`}>{t('badge')}</span>
                    <span className="confirm-pair-name" title={it.domPath ?? it.figmaNodeId ?? ''}>
                      {it.label}
                    </span>
                  </div>
                  <ul className="confirm-pair-diffs">
                    <li>{it.description}</li>
                  </ul>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="modal-actions">
          <span className="confirm-drawer-count">{t('itemCount', { count: items.length })}</span>
          <button className="btn-secondary" onClick={onClose}>
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  )
}
