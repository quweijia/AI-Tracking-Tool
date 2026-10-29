import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { db, touchPage, Issue } from '../db'

interface Props {
  issue: Issue
  /** 页面原开发截图（修复前基准），父组件异步加载 */
  oldScreenshotUrl: string | null
  onClose: () => void
}

export default function ReverifyModal({ issue, oldScreenshotUrl, onClose }: Props) {
  const { t } = useTranslation('reverifyModal')
  const [fixPath, setFixPath] = useState(issue.fixScreenshotPath ?? '')
  const [fixUrl, setFixUrl] = useState('')
  const [note, setNote] = useState(issue.fixNote ?? '')
  const [slider, setSlider] = useState(50)
  const [picking, setPicking] = useState(false)

  // 回显已上传过的修复图
  useEffect(() => {
    if (issue.fixScreenshotPath) {
      window.electronAPI.readImage(issue.fixScreenshotPath).then((url) => setFixUrl(url ?? ''))
    }
  }, [issue.fixScreenshotPath])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pickImage = async () => {
    setPicking(true)
    try {
      const result = await window.electronAPI.selectImage()
      if (result) {
        setFixPath(result.relativePath)
        setFixUrl(result.dataUrl)
      }
    } finally {
      setPicking(false)
    }
  }

  const submit = async (passed: boolean) => {
    await db.issues.update(issue.id, {
      fixScreenshotPath: fixPath || undefined,
      fixNote: note.trim() || undefined,
      fixStatus: passed ? 'passed' : 'failed',
      status: passed ? 'fixed' : 'pending',
      verifiedAt: Date.now(),
      reverifyCount: (issue.reverifyCount ?? 0) + 1
    })
    void touchPage(issue.pageId)
    onClose()
  }

  const hasCompare = Boolean(oldScreenshotUrl && fixUrl)

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <h3>{t('title')}</h3>
        <div className="reverify-issue-meta">
          <span className={`severity-badge severity-${issue.severity}`}>
            {t(`severity_${issue.severity}`)}
          </span>
          <span className="meta-cat">{t(`category_${issue.category}`)}</span>
          <span className="meta-desc">{issue.description}</span>
        </div>

        <div className="reverify-upload">
          <button className="btn-secondary" onClick={pickImage} disabled={picking}>
            {picking ? t('picking') : fixUrl ? t('reselectFixShot') : t('selectFixShot')}
          </button>
          {fixUrl && <img src={fixUrl} alt={t('fixThumbAlt')} className="verify-thumb" />}
        </div>

        {fixUrl && !oldScreenshotUrl && (
          <div className="verify-wrap">
            <div className="verify-scroll">
              <img src={fixUrl} alt={t('fixShotAlt')} className="verify-img" draggable={false} />
            </div>
            <span className="verify-tag tag-right">{t('afterFixTag')}</span>
          </div>
        )}

        {hasCompare && (
          <>
            <div className="verify-wrap">
              <div className="verify-scroll">
                <img src={oldScreenshotUrl!} alt={t('preFixShotAlt')} className="verify-img" draggable={false} />
                <img
                  src={fixUrl}
                  alt={t('fixShotAlt')}
                  className="verify-img verify-new"
                  draggable={false}
                  style={{ clipPath: `inset(0 0 0 ${slider}%)` }}
                />
              </div>
              <div className="verify-divider" style={{ left: `${slider}%` }} />
              <span className="verify-tag tag-left">{t('beforeFixTag')}</span>
              <span className="verify-tag tag-right">{t('afterFixTag')}</span>
            </div>
            <input
              type="range"
              className="verify-slider"
              min={0}
              max={100}
              value={slider}
              onChange={(e) => setSlider(Number(e.target.value))}
            />
          </>
        )}

        <label className="field-label">{t('noteLabel')}</label>
        <textarea
          className="input"
          rows={2}
          placeholder={t('notePlaceholder')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            {t('cancel')}
          </button>
          <span className="modal-spacer" />
          <button className="btn-danger" onClick={() => submit(false)} title={t('failTitle')}>
            {t('failButton')}
          </button>
          <button
            className="btn-primary"
            disabled={!fixUrl}
            title={fixUrl ? t('passTitle') : t('passTitleNeedShot')}
            onClick={() => submit(true)}
          >
            {t('passButton')}
          </button>
        </div>
      </div>
    </div>
  )
}
