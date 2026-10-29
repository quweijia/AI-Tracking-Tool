import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { extractFigmaFileKey } from '../../../shared/figmaUrl'
import { db, genId, type DesignSpec } from '../db'

/** 规范套新建/编辑弹窗：名称与 Figma 规范链接必填，链接实时校验并回填 file key */
export default function SpecModal({
  categoryId,
  spec,
  onCancel
}: {
  categoryId: string
  spec?: DesignSpec
  onCancel: () => void
}) {
  const { t } = useTranslation('specsPage')
  const [name, setName] = useState(spec?.name ?? '')
  const [url, setUrl] = useState(spec?.figmaUrl ?? '')
  const [note, setNote] = useState(spec?.note ?? '')
  const [urlTouched, setUrlTouched] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const fileKey = url.trim() ? extractFigmaFileKey(url) : null
  const urlInvalid = urlTouched && !!url.trim() && !fileKey
  const canSave = !!name.trim() && !!url.trim() && !!fileKey

  const save = async () => {
    if (!canSave) {
      setUrlTouched(true)
      return
    }
    const now = Date.now()
    if (spec) {
      await db.designSpecs.update(spec.id, {
        name: name.trim(),
        figmaUrl: url.trim(),
        figmaFileKey: fileKey!,
        note: note.trim() || undefined,
        updatedAt: now
      })
    } else {
      await db.designSpecs.add({
        id: genId(),
        categoryId,
        name: name.trim(),
        figmaUrl: url.trim(),
        figmaFileKey: fileKey!,
        note: note.trim() || undefined,
        createdAt: now,
        updatedAt: now
      })
    }
    onCancel()
  }

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal">
        <h3>{spec ? t('specEditTitle') : t('specCreateTitle')}</h3>
        <label className="field-label">{t('specNameLabel')}</label>
        <input
          className="input"
          autoFocus
          value={name}
          placeholder={t('specNamePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="field-label">{t('specUrlLabel')}</label>
        <input
          className="input"
          value={url}
          placeholder={t('specUrlPlaceholder')}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => setUrlTouched(true)}
        />
        {urlInvalid && <div className="spec-form-error">{t('specUrlInvalid')}</div>}
        <label className="field-label">{t('specNoteLabel')}</label>
        <textarea
          className="input spec-note-input"
          rows={3}
          value={note}
          placeholder={t('specNotePlaceholder')}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="modal-actions">
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button className="btn-primary" disabled={!canSave} onClick={() => void save()}>
            {spec ? t('save') : t('create')}
          </button>
        </div>
      </div>
    </div>
  )
}
