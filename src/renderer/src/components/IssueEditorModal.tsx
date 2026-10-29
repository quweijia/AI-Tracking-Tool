import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ANNOTATION_COLORS,
  Category,
  CATEGORY_LABELS,
  Issue,
  IssueStatus,
  ISSUE_STATUS_LABELS,
  Severity,
  SEVERITY_LABELS,
  TargetImage
} from '../db'
import USelect from './USelect'

/** 标注颜色值 → 语言包 key（与 db 的 ANNOTATION_COLORS 顺序无关，按色值映射） */
const COLOR_LABEL_KEYS: Record<string, string> = {
  '': 'color_auto',
  '#ef4444': 'color_red',
  '#f59e0b': 'color_orange',
  '#2563eb': 'color_blue',
  '#16a34a': 'color_green',
  '#9333ea': 'color_purple',
  '#ffffff': 'color_white',
  '#000000': 'color_black'
}

/** 枚举值转语言包 key 后缀（'in-progress' → 'in_progress'） */
const enumKey = (v: string) => v.replace(/-/g, '_')

interface Props {
  /** 编辑已有问题，或创建模式下的初始值 */
  issue: Issue
  mode: 'create' | 'edit'
  onSave: (fields: {
    description: string
    severity: Severity
    category: Category
    status: IssueStatus
    targetImage: TargetImage
    /** 自定义标注颜色，空串 = 按严重度 */
    color?: string
    /** 测量标注的尺寸文案（仅测量标注） */
    measureValue?: string
  }) => void
  onDelete?: () => void
  onCancel: () => void
}

export default function IssueEditorModal({ issue, mode, onSave, onDelete, onCancel }: Props) {
  const { t } = useTranslation('issueEditorModal')
  const [description, setDescription] = useState(issue.description)
  const [severity, setSeverity] = useState<Severity>(issue.severity)
  const [category, setCategory] = useState<Category>(issue.category)
  const [status, setStatus] = useState<IssueStatus>(issue.status)
  const [targetImage, setTargetImage] = useState<TargetImage>(issue.targetImage)
  const [colorPreset, setColorPreset] = useState<string>(issue.color ?? '')
  /** 测量标注的尺寸文案（可修改） */
  const [measureValue, setMeasureValue] = useState(issue.measureValue ?? '')

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const canSave = description.trim().length > 0

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h3>{t(mode === 'create' ? 'titleCreate' : 'titleEdit')}</h3>

        <label className="field-label">{t('description')}</label>
        <textarea
          className="input"
          rows={3}
          autoFocus
          placeholder={t('descriptionPlaceholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <div className="modal-grid">
          <div>
            <label className="field-label">{t('category')}</label>
            <USelect
              value={category}
              onChange={(v) => setCategory(v as Category)}
              options={(Object.keys(CATEGORY_LABELS) as Category[]).map((k) => ({
                value: k,
                label: t(`cat_${enumKey(k)}`)
              }))}
            />
          </div>
          <div>
            <label className="field-label">{t('severity')}</label>
            <USelect
              value={severity}
              onChange={(v) => setSeverity(v as Severity)}
              options={(Object.keys(SEVERITY_LABELS) as Severity[]).map((k) => ({
                value: k,
                label: t(`sev_${enumKey(k)}`)
              }))}
            />
          </div>
          <div>
            <label className="field-label">{t('targetImage')}</label>
            <USelect
              value={targetImage}
              onChange={(v) => setTargetImage(v as TargetImage)}
              options={[
                { value: 'design', label: t('design') },
                { value: 'screenshot', label: t('devScreenshot') }
              ]}
            />
          </div>
          {mode === 'edit' && (
            <div>
              <label className="field-label">{t('status')}</label>
              <USelect
                value={status}
                onChange={(v) => setStatus(v as IssueStatus)}
                options={(Object.keys(ISSUE_STATUS_LABELS) as IssueStatus[]).map((k) => ({
                  value: k,
                  label: t(`status_${enumKey(k)}`)
                }))}
              />
            </div>
          )}
        </div>

        {issue.shape === 'measure' && (
          <>
            <label className="field-label">{t('measureValue')}</label>
            <input
              className="input"
              placeholder={t('measureValuePlaceholder')}
              value={measureValue}
              onChange={(e) => setMeasureValue(e.target.value)}
            />
          </>
        )}

        <label className="field-label">{t('annotationColor')}</label>
        <div className="color-palette">
          {ANNOTATION_COLORS.map((c) => (
            <button
              key={c.value || 'auto'}
              type="button"
              className={`color-swatch ${c.value ? '' : 'auto'} ${colorPreset === c.value ? 'active' : ''}`}
              style={c.value ? { background: c.value } : undefined}
              title={t(COLOR_LABEL_KEYS[c.value] ?? 'color_auto')}
              onClick={() => setColorPreset(c.value)}
            />
          ))}
        </div>

        <div className="modal-actions">
          {mode === 'edit' && onDelete && (
            <button className="btn-danger" onClick={onDelete}>
              {t('delete')}
            </button>
          )}
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={!canSave}
            onClick={() =>
              canSave &&
              onSave({
                description: description.trim(),
                severity,
                category,
                status,
                targetImage,
                color: colorPreset || undefined,
                ...(issue.shape === 'measure' ? { measureValue: measureValue.trim() || undefined } : {})
              })
            }
          >
            {t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}
