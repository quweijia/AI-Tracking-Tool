import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MatchPair, StyleDiff } from '../../../shared/types'

/** 待人工确认的匹配对（置信度 < 0.6）及其差异 */
export interface PendingPair {
  pair: MatchPair
  diffs: StyleDiff[]
}

interface Props {
  items: PendingPair[]
  /** 确认添加选中的差异（按对粒度） */
  onConfirm: (selected: PendingPair[]) => void
  onClose: () => void
}

/** 低置信度匹配对人工确认抽屉：逐对勾选是否采纳其结构化差异 */
export default function MatchConfirmDrawer({ items, onConfirm, onClose }: Props) {
  const { t } = useTranslation('matchConfirmDrawer')
  const [selected, setSelected] = useState<Set<number>>(() => new Set(items.map((_, i) => i)))

  const toggle = (i: number): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const picked = items.filter((_, i) => selected.has(i))
  const pickedCount = picked.reduce((n, it) => n + it.diffs.length, 0)

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal confirm-drawer-modal">
        <h3>{t('title')}</h3>
        <p className="confirm-drawer-sub">{t('desc', { count: items.length })}</p>
        <div className="confirm-drawer-list">
          {items.map((it, i) => {
            const { pair, diffs } = it
            const conf = Math.round(pair.confidence * 100)
            return (
              <div key={`${pair.design.id}-${pair.dom.id}`} className={`confirm-pair ${selected.has(i) ? 'checked' : ''}`}>
                <label className="confirm-pair-check">
                  <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} />
                </label>
                <div className="confirm-pair-main">
                  <div className="confirm-pair-head">
                    <span className="confirm-pair-name" title={pair.design.name}>
                      {pair.design.name || t('unnamedLayer')}
                    </span>
                    <span className="confirm-pair-arrow">→</span>
                    <span className="confirm-pair-name" title={pair.dom.domPath}>
                      {pair.dom.domPath || pair.dom.name}
                    </span>
                    <span className={`confirm-pair-conf ${conf >= 45 ? 'mid' : 'low'}`}>{conf}%</span>
                  </div>
                  <ul className="confirm-pair-diffs">
                    {diffs.slice(0, 4).map((d, di) => (
                      <li key={di}>
                        <span className={`severity-badge severity-${d.severity}`}>{d.label}</span>
                        {d.designValue} → {d.devValue}
                      </li>
                    ))}
                    {diffs.length > 4 && <li className="confirm-pair-more">{t('moreDiffs', { count: diffs.length })}</li>}
                  </ul>
                </div>
              </div>
            )
          })}
        </div>
        <div className="modal-actions">
          <span className="confirm-drawer-count">{t('selectedSummary', { pairs: picked.length, diffs: pickedCount })}</span>
          <button className="btn-secondary" onClick={onClose}>
            {t('skipAll')}
          </button>
          <button className="btn-primary" disabled={picked.length === 0} onClick={() => onConfirm(picked)}>
            {t('addToIssues')}
          </button>
        </div>
      </div>
    </div>
  )
}
