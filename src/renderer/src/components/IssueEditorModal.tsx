import { useEffect, useState } from 'react'
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
        <h3>{mode === 'create' ? '新建问题标注' : '编辑问题标注'}</h3>

        <label className="field-label">问题描述</label>
        <textarea
          className="input"
          rows={3}
          autoFocus
          placeholder="描述这里与设计稿不一致的地方"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <div className="modal-grid">
          <div>
            <label className="field-label">分类</label>
            <USelect
              value={category}
              onChange={(v) => setCategory(v as Category)}
              options={(Object.keys(CATEGORY_LABELS) as Category[]).map((k) => ({ value: k, label: CATEGORY_LABELS[k] }))}
            />
          </div>
          <div>
            <label className="field-label">严重度</label>
            <USelect
              value={severity}
              onChange={(v) => setSeverity(v as Severity)}
              options={(Object.keys(SEVERITY_LABELS) as Severity[]).map((k) => ({ value: k, label: SEVERITY_LABELS[k] }))}
            />
          </div>
          <div>
            <label className="field-label">标注图</label>
            <USelect
              value={targetImage}
              onChange={(v) => setTargetImage(v as TargetImage)}
              options={[
                { value: 'design', label: '设计稿' },
                { value: 'screenshot', label: '开发截图' }
              ]}
            />
          </div>
          {mode === 'edit' && (
            <div>
              <label className="field-label">状态</label>
              <USelect
                value={status}
                onChange={(v) => setStatus(v as IssueStatus)}
                options={(Object.keys(ISSUE_STATUS_LABELS) as IssueStatus[]).map((k) => ({
                  value: k,
                  label: ISSUE_STATUS_LABELS[k]
                }))}
              />
            </div>
          )}
        </div>

        {issue.shape === 'measure' && (
          <>
            <label className="field-label">尺寸数值</label>
            <input
              className="input"
              placeholder="如 128px"
              value={measureValue}
              onChange={(e) => setMeasureValue(e.target.value)}
            />
          </>
        )}

        <label className="field-label">标注颜色</label>
        <div className="color-palette">
          {ANNOTATION_COLORS.map((c) => (
            <button
              key={c.value || 'auto'}
              type="button"
              className={`color-swatch ${c.value ? '' : 'auto'} ${colorPreset === c.value ? 'active' : ''}`}
              style={c.value ? { background: c.value } : undefined}
              title={c.label}
              onClick={() => setColorPreset(c.value)}
            />
          ))}
        </div>

        <div className="modal-actions">
          {mode === 'edit' && onDelete && (
            <button className="btn-danger" onClick={onDelete}>
              删除
            </button>
          )}
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            取消
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
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
