import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import {
  db,
  deleteProjectCascade,
  genId,
  Platform,
  PLATFORM_LABELS,
  Project,
  platformList,
  DesignSpec,
  type ProjectSpecBinding
} from '../db'
import { PlatformIcon } from './PlatformBadge'
import { LOGO_COLORS, logoColorOf } from './ProjectCard'
import LogoCropper from './LogoCropper'
import USelect from './USelect'

interface Props {
  /** 传 project 为编辑模式，否则为新建 */
  project?: Project
  onDone: () => void
  onCancel: () => void
}

const PLATFORM_KEYS = Object.keys(PLATFORM_LABELS) as Platform[]

/** 新建 / 编辑项目弹窗：名称、适用端类型（多选）、项目 Logo；删除项目入口收进编辑弹窗 */
export default function ProjectModal({ project, onDone, onCancel }: Props) {
  const { t } = useTranslation('projectModal')
  const navigate = useNavigate()
  const [name, setName] = useState(project?.name ?? '')
  const [platforms, setPlatforms] = useState<Platform[]>(() => {
    const list = platformList(project?.platform)
    return list.length ? list : ['h5']
  })
  const [logo, setLogo] = useState<{ relativePath: string; dataUrl: string } | null>(null)
  /** 无 Logo 时文字占位底色（'' = 自动按项目散列取色） */
  const [logoColor, setLogoColor] = useState(project?.logoColor ?? '')
  /** 待裁剪的原图（选图后先进裁剪确认；含临时文件路径，结束时清理） */
  const [pendingOriginal, setPendingOriginal] = useState<{ relativePath: string; dataUrl: string } | null>(null)
  /** 待裁剪的原图 dataUrl（驱动裁剪弹层显示） */
  const [cropping, setCropping] = useState<string | null>(null)
  /** 规范绑定：端分类 id → 规范套 id（'' = 不绑定） */
  const [bindByCategory, setBindByCategory] = useState<Record<string, string>>({})

  // 绑定选择器数据：端分类、规范套、编辑模式下的已有绑定
  const categories = useLiveQuery(() => db.specCategories.toArray(), []) ?? []
  const specs = useLiveQuery(() => db.designSpecs.toArray(), []) ?? []
  const bindings = useLiveQuery(
    () =>
      project
        ? db.projectSpecBindings.where('projectId').equals(project.id).toArray()
        : Promise.resolve<ProjectSpecBinding[]>([]),
    [project?.id]
  )

  // 编辑模式：读取已保存的 Logo 作为初始预览（否则弹窗里只显示文字占位）
  useEffect(() => {
    const p = project?.logoPath
    if (!p) return
    let alive = true
    window.electronAPI
      .readImage(p)
      .then((d) => {
        if (alive && d) setLogo({ relativePath: p, dataUrl: d })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [project?.logoPath])

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

  // 规范套 id → 所属端分类 id（绑定反查用）
  const specCatOf = useMemo(() => new Map(specs.map((s) => [s.id, s.categoryId])), [specs])

  // 编辑模式：已有绑定初始化为选中态（bindings 与 specs 都就绪后执行一次）
  useEffect(() => {
    if (!bindings) return
    const map: Record<string, string> = {}
    for (const b of bindings) {
      const catId = specCatOf.get(b.specId)
      if (catId) map[catId] = b.specId
    }
    setBindByCategory(map)
  }, [bindings, specCatOf])

  // 只显示项目所选端对应的分类（走查取套依据：page.platform → category.platformKey）
  const visibleCats = useMemo(
    () =>
      categories
        .filter((c) => platforms.includes(c.platformKey))
        .sort((a, b) => (a.sortNo ?? 0) - (b.sortNo ?? 0) || a.createdAt - b.createdAt),
    [categories, platforms]
  )

  // 规范套按分类分组
  const specsByCat = useMemo(() => {
    const m: Record<string, DesignSpec[]> = {}
    for (const s of specs) (m[s.categoryId] ??= []).push(s)
    return m
  }, [specs])

  const setBind = (catId: string, specId: string) => setBindByCategory((prev) => ({ ...prev, [catId]: specId }))

  const pickLogo = async () => {
    const result = await window.electronAPI.selectImage()
    if (!result) return
    // 选择后先进入裁剪界面，确认后再采用（原图临时文件在裁剪结束/取消时清理）
    setPendingOriginal(result)
    setCropping(result.dataUrl)
  }

  /** 裁剪确认：采用裁剪结果并清理原图临时文件 */
  const handleCropDone = async (relativePath: string, dataUrl: string) => {
    if (pendingOriginal) {
      await window.electronAPI.deleteImage(pendingOriginal.relativePath).catch(() => undefined)
    }
    setPendingOriginal(null)
    setCropping(null)
    setLogo({ relativePath, dataUrl })
  }

  /** 裁剪取消：丢弃选图并清理原图临时文件 */
  const handleCropCancel = async () => {
    if (pendingOriginal) {
      await window.electronAPI.deleteImage(pendingOriginal.relativePath).catch(() => undefined)
    }
    setPendingOriginal(null)
    setCropping(null)
  }

  /** 命名查重：与其他项目同名（编辑时排除自身）时禁止保存，并提供跳转入口 */
  const duplicate = useLiveQuery(() => {
    const t = name.trim()
    if (!t) return undefined
    return db.projects.filter((p) => p.name === t && p.id !== project?.id).first()
  }, [name, project?.id])

  const canSave = name.trim().length > 0 && platforms.length > 0 && !duplicate

  /** 编辑模式：删除整个项目（级联清理），入口收进编辑弹窗 */
  const handleDelete = async () => {
    if (!project) return
    const ok = window.confirm(t('deleteConfirm', { name: project.name }))
    if (!ok) return
    await deleteProjectCascade(project.id)
    onDone()
  }

  const handleSave = async () => {
    if (!canSave) return
    const nextLogoPath = logo?.relativePath ?? project?.logoPath
    // 先确定项目 id（新建也提前生成），绑定写入需要它
    const pid = project?.id ?? crypto.randomUUID()

    if (project) {
      // 替换 Logo 时清理旧图片文件
      if (project.logoPath && project.logoPath !== nextLogoPath) {
        await window.electronAPI.deleteImage(project.logoPath).catch(() => undefined)
      }
      await db.projects.update(project.id, {
        name: name.trim(),
        platform: platforms,
        ...(nextLogoPath ? { logoPath: nextLogoPath } : {}),
        logoColor: logoColor || undefined,
        updatedAt: Date.now()
      })
    } else {
      await db.projects.add({
        id: pid,
        name: name.trim(),
        platform: platforms,
        ...(nextLogoPath ? { logoPath: nextLogoPath } : {}),
        ...(logoColor ? { logoColor } : {}),
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
    }

    // 规范绑定全删重建（仅保存当前所选端分类的选择；未选 = 不绑定）
    await db.transaction('rw', db.projectSpecBindings, async () => {
      await db.projectSpecBindings.where('projectId').equals(pid).delete()
      const rows = Object.entries(bindByCategory)
        .filter(([, specId]) => !!specId)
        .map(([, specId]) => ({ id: genId(), projectId: pid, specId, createdAt: Date.now() }))
      if (rows.length) await db.projectSpecBindings.bulkAdd(rows)
    })
    onDone()
  }

  const avatarSrc = logo?.dataUrl ?? ''

  return (
    <>
      <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h3>{project ? t('editTitle') : t('createTitle')}</h3>

        <label className="field-label">{t('logoLabel')}</label>
        <div className="logo-picker">
          {/* 上传/更换统一收口到点击 Logo 头像本身（已设置时悬停显示「更换 Logo」提示） */}
          <button
            className={`logo-avatar${avatarSrc ? ' has-logo' : ''}`}
            onClick={pickLogo}
            title={avatarSrc ? t('logoReplaceTitle') : t('logoPickTitle')}
            style={avatarSrc ? undefined : { background: logoColor || logoColorOf(project?.id ?? name) }}
          >
            {avatarSrc ? (
              <img src={avatarSrc} alt="" draggable={false} />
            ) : (
              <span>{name.trim().slice(0, 1) || '+'}</span>
            )}
          </button>
        </div>

        {!avatarSrc && (
          <>
            <label className="field-label">{t('logoColorLabel')}</label>
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

        <label className="field-label">{t('nameLabel')}</label>
        <input
          className="input"
          autoFocus
          placeholder={t('namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {duplicate && (
          <div className="dup-hint">
            <span>{t('duplicateMsg')}</span>
            <button
              type="button"
              className="btn-text"
              onClick={() => {
                onDone()
                navigate(`/project/${duplicate.id}`)
              }}
            >
              {t('openProject')}
            </button>
          </div>
        )}

        <label className="field-label">{t('platformLabel')}</label>
        <div className="platform-options">
          {PLATFORM_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              className={`platform-option${platforms.includes(k) ? ' active' : ''}`}
              onClick={() => togglePlatform(k)}
            >
              <PlatformIcon platform={k} size={15} />
              {t(`platform_${k}`)}
            </button>
          ))}
        </div>

        <label className="field-label">{t('specBindLabel')}</label>
        {specs.length === 0 ? (
          <div className="spec-bind-empty">{t('specBindEmpty')}</div>
        ) : (
          <div className="spec-bind-grid">
            {visibleCats.map((cat) => {
              const bound = bindByCategory[cat.id] ?? ''
              const opts = [
                { value: '', label: t('specBindNone') },
                ...(specsByCat[cat.id] ?? []).map((s) => ({ value: s.id, label: s.name }))
              ]
              return (
                <div key={cat.id} className="spec-bind-row">
                  <span className={`spec-bind-cat${bound ? ' bound' : ''}`}>
                    <PlatformIcon platform={cat.platformKey} size={13} />
                    {cat.name}
                  </span>
                  <USelect
                    className={`spec-bind-select${bound ? ' is-bound' : ''}`}
                    value={bound}
                    onChange={(v) => setBind(cat.id, v)}
                    options={opts}
                  />
                </div>
              )
            })}
          </div>
        )}

        <div className="modal-actions">
          {project && (
            <button className="btn-danger" onClick={handleDelete}>
              {t('deleteProject')}
            </button>
          )}
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button className="btn-primary" disabled={!canSave} onClick={handleSave}>
            {project ? t('save') : t('create')}
          </button>
        </div>
      </div>
      </div>
      {/* Logo 裁剪弹层（覆盖在项目弹窗之上） */}
      {cropping && (
        <LogoCropper src={cropping} onCancel={handleCropCancel} onDone={handleCropDone} />
      )}
    </>
  )
}
