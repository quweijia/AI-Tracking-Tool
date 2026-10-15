import { useEffect, useState } from 'react'
import { db, deleteProjectCascade, Platform, PLATFORM_LABELS, Project, platformList } from '../db'
import { PlatformIcon } from './PlatformBadge'
import { LOGO_COLORS, logoColorOf } from './ProjectCard'

interface Props {
  /** 传 project 为编辑模式，否则为新建 */
  project?: Project
  onDone: () => void
  onCancel: () => void
}

const PLATFORM_KEYS = Object.keys(PLATFORM_LABELS) as Platform[]

/** 新建 / 编辑项目弹窗：名称、适用端类型（多选）、项目 Logo；删除项目入口收进编辑弹窗 */
export default function ProjectModal({ project, onDone, onCancel }: Props) {
  const [name, setName] = useState(project?.name ?? '')
  const [platforms, setPlatforms] = useState<Platform[]>(() => {
    const list = platformList(project?.platform)
    return list.length ? list : ['h5']
  })
  const [logo, setLogo] = useState<{ relativePath: string; dataUrl: string } | null>(null)
  const [removedLogo, setRemovedLogo] = useState(false) // 编辑时清空原 Logo
  /** 无 Logo 时文字占位底色（'' = 自动按项目散列取色） */
  const [logoColor, setLogoColor] = useState(project?.logoColor ?? '')

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const togglePlatform = (k: Platform) => {
    setPlatforms((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]))
  }

  const pickLogo = async () => {
    const result = await window.electronAPI.selectImage()
    if (result) {
      setLogo(result)
      setRemovedLogo(false)
    }
  }

  const canSave = name.trim().length > 0 && platforms.length > 0

  /** 编辑模式：删除整个项目（级联清理），入口收进编辑弹窗 */
  const handleDelete = async () => {
    if (!project) return
    const ok = window.confirm(
      `确定删除项目「${project.name}」吗？\n将同时删除其下所有版本、页面、问题记录与图片文件，删除后不可恢复。`
    )
    if (!ok) return
    await deleteProjectCascade(project.id)
    onDone()
  }

  const handleSave = async () => {
    if (!canSave) return
    const nextLogoPath = logo ? logo.relativePath : removedLogo ? undefined : project?.logoPath

    if (project) {
      // 替换 / 移除 Logo 时清理旧图片文件
      if (project.logoPath && project.logoPath !== nextLogoPath) {
        await window.electronAPI.deleteImage(project.logoPath).catch(() => undefined)
      }
      await db.projects.update(project.id, {
        name: name.trim(),
        platform: platforms,
        ...(nextLogoPath ? { logoPath: nextLogoPath } : removedLogo ? { logoPath: undefined } : {}),
        logoColor: logoColor || undefined,
        updatedAt: Date.now()
      })
    } else {
      await db.projects.add({
        id: crypto.randomUUID(),
        name: name.trim(),
        platform: platforms,
        ...(nextLogoPath ? { logoPath: nextLogoPath } : {}),
        ...(logoColor ? { logoColor } : {}),
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
    }
    onDone()
  }

  const avatarSrc = removedLogo ? '' : (logo?.dataUrl ?? '')

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h3>{project ? '编辑项目' : '新建项目'}</h3>

        <label className="field-label">项目 Logo（可选）</label>
        <div className="logo-picker">
          <button
            className="logo-avatar"
            onClick={pickLogo}
            title="点击选择 Logo 图片"
            style={avatarSrc ? undefined : { background: logoColor || logoColorOf(project?.id ?? name) }}
          >
            {avatarSrc ? (
              <img src={avatarSrc} alt="" draggable={false} />
            ) : (
              <span>{name.trim().slice(0, 1) || '+'}</span>
            )}
          </button>
          <div className="logo-picker-side">
            <button className="btn-text" onClick={pickLogo}>
              {avatarSrc ? '更换 Logo' : '上传 Logo'}
            </button>
            {avatarSrc && (
              <button className="btn-text danger" onClick={() => setRemovedLogo(true)}>
                移除
              </button>
            )}
          </div>
        </div>

        {!avatarSrc && (
          <>
            <label className="field-label">文字 Logo 底色</label>
            <div className="logo-color-row">
              {LOGO_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`logo-color-dot${logoColor === c ? ' active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setLogoColor(c)}
                  title={c}
                />
              ))}
            </div>
          </>
        )}

        <label className="field-label">项目名称</label>
        <input
          className="input"
          autoFocus
          placeholder="如：XX App、官网、数据平台"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="field-label">适用端类型（可多选）</label>
        <div className="platform-options">
          {PLATFORM_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              className={`platform-option${platforms.includes(k) ? ' active' : ''}`}
              onClick={() => togglePlatform(k)}
            >
              <PlatformIcon platform={k} size={15} />
              {PLATFORM_LABELS[k]}
            </button>
          ))}
        </div>

        <div className="modal-actions">
          {project && (
            <button className="btn-danger" onClick={handleDelete}>
              删除项目
            </button>
          )}
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button className="btn-primary" disabled={!canSave} onClick={handleSave}>
            {project ? '保存' : '确认创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
