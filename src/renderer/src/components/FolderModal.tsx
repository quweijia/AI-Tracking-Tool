import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { db, deleteFolderCascade, Folder } from '../db'
import { FOLDER_COLORS, FOLDER_ICONS, FolderIconGlyph } from './FolderIcon'

interface Props {
  projectId: string
  /** 新建时的父文件夹（缺省挂项目根级） */
  parentId?: string
  /** 传 folder 为编辑模式，否则为新建 */
  folder?: Folder
  onDone: () => void
  onCancel: () => void
}

/**
 * 新建 / 编辑文件夹弹窗：名称 + 自定义 icon + 主题色；
 * 编辑模式额外提供删除文件夹（级联删除子内容），入口收进弹窗。
 */
export default function FolderModal({ projectId, parentId, folder, onDone, onCancel }: Props) {
  const navigate = useNavigate()
  const { t } = useTranslation('folderModal')
  const [name, setName] = useState(folder?.name ?? '')
  const [icon, setIcon] = useState(folder?.icon ?? 'folder')
  const [color, setColor] = useState(folder?.color ?? FOLDER_COLORS[0])

  /** 同层级命名查重：同一项目、同一父级下的其他文件夹同名时提示并支持跳转 */
  const duplicate = useLiveQuery(() => {
    const t = name.trim()
    if (!t) return undefined
    const key = parentId ?? ''
    return db.folders
      .filter((f) => f.projectId === projectId && (f.parentId ?? '') === key && f.name === t && f.id !== folder?.id)
      .first()
  }, [name, projectId, parentId, folder?.id])

  // Esc 关闭（编辑态时避免与重命名输入冲突，保持一致简单处理）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const canSave = name.trim().length > 0 && !duplicate

  const handleDelete = async () => {
    if (!folder) return
    const ok = window.confirm(t('deleteConfirm', { name: folder.name }))
    if (!ok) return
    await deleteFolderCascade(folder.id)
    onDone()
  }

  const handleSave = async () => {
    if (!canSave) return
    if (folder) {
      await db.folders.update(folder.id, { name: name.trim(), icon, color })
    } else {
      await db.folders.add({
        id: crypto.randomUUID(),
        projectId,
        parentId: parentId || undefined,
        name: name.trim(),
        icon,
        color,
        createdAt: Date.now()
      })
    }
    onDone()
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h3>{folder ? t('editTitle') : t('createTitle')}</h3>

        <label className="field-label">{t('nameLabel')}</label>
        <input
          className="input"
          autoFocus
          placeholder={t('namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
        />
        {duplicate && (
          <div className="dup-hint">
            <span>{t('duplicateMsg')}</span>
            <button
              type="button"
              className="btn-text"
              onClick={() => {
                onDone()
                navigate(`/project/${projectId}?f=${duplicate.id}`)
              }}
            >
              {t('openFolder')}
            </button>
          </div>
        )}

        <label className="field-label">{t('iconLabel')}</label>
        <div className="folder-icon-grid">
          {FOLDER_ICONS.map((it) => (
            <button
              key={it.key}
              type="button"
              className={`folder-icon-item${icon === it.key ? ' active' : ''}`}
              style={icon === it.key ? { color } : undefined}
              title={t(it.label, { ns: 'folderIcon' })}
              onClick={() => setIcon(it.key)}
            >
              <FolderIconGlyph icon={it.key} size={18} />
            </button>
          ))}
        </div>

        <label className="field-label">{t('colorLabel')}</label>
        <div className="logo-color-row">
          {FOLDER_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`logo-color-dot${color === c ? ' active' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              title={c}
            />
          ))}
        </div>

        <div className="modal-actions">
          {folder && (
            <button className="btn-danger" onClick={handleDelete}>
              {t('deleteFolder')}
            </button>
          )}
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button className="btn-primary" disabled={!canSave} onClick={handleSave}>
            {folder ? t('save') : t('create')}
          </button>
        </div>
      </div>
    </div>
  )
}
