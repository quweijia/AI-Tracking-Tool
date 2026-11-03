import { useTranslation } from 'react-i18next'
import type { LayeredRunSummary } from '../../../shared/types'

interface Props {
  /** 最近一次走查的分层还原度旁路结果 */
  summary: LayeredRunSummary
  onClose: () => void
}

/** 分层还原度明细抽屉（只读旁路展示）：不落库、不进问题清单、不进报告 */
export default function LayeredResultDrawer({ summary, onClose }: Props) {
  const { t } = useTranslation('layeredResultDrawer')
  const score = Math.round(summary.score)
  // 还原度分色：≥90 绿 / ≥75 黄 / 其余红（与 severity 三档语义呼应）
  const tone = score >= 90 ? 'good' : score >= 75 ? 'mid' : 'low'

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal confirm-drawer-modal">
        <h3>{t('title')}</h3>
        <p className="confirm-drawer-sub">{t('desc')}</p>
        <div className="lr-summary">
          <div className={`lr-stat lr-tone-${tone}`}>
            <span className="lr-stat-num">{score}</span>
            <span className="lr-stat-label">{t('score')}</span>
          </div>
          <div className="lr-stat">
            <span className="lr-stat-num">{summary.moduleAbsorbed}</span>
            <span className="lr-stat-label">{t('absorbed')}</span>
          </div>
          <div className="lr-stat">
            <span className="lr-stat-num">{summary.elementReported}</span>
            <span className="lr-stat-label">{t('reported')}</span>
          </div>
        </div>
        <div className="confirm-drawer-list">
          {summary.items.length === 0 ? (
            <p className="lr-empty">{t('noItems')}</p>
          ) : (
            summary.items.map((it, i) => (
              <div key={i} className="confirm-pair">
                <div className="confirm-pair-main">
                  <div className="confirm-pair-head">
                    <span className={`severity-badge severity-${it.severity}`}>
                      {t(`level_${it.level}`)} · {t(`dim_${it.dim}`)}
                    </span>
                    <span className={`lr-verdict lr-verdict-${it.verdict}`}>{t(`verdict_${it.verdict}`)}</span>
                    <span className="confirm-pair-name" title={it.node.designName}>
                      {it.node.designName || t('unnamed')}
                    </span>
                  </div>
                  <ul className="confirm-pair-diffs">
                    <li>{it.description}</li>
                    <li className="lr-meta">
                      {t('deviation', { delta: it.delta.toFixed(1), ratio: Math.round(it.ratio * 10) / 10 })}
                    </li>
                  </ul>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="modal-actions">
          <span className="confirm-drawer-count">{t('itemCount', { count: summary.items.length })}</span>
          <button className="btn-secondary" onClick={onClose}>
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  )
}
