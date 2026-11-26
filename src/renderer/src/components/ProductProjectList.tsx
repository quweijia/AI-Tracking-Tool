import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { productDb, ProductProject, bySort, genId, softDeleteProductProjects } from '../db/product'
import { confirmDialog } from './ConfirmDialog'
import { showToast } from './Toast'
import { ProjectLogo, LOGO_COLORS, logoColorOf } from './ProjectCard'
import LogoCropper from './LogoCropper'
import { Skeleton } from './Skeleton'
import heroBannerArtUrl from '../assets/hero-banner-art.png'
import heroBannerArtDarkUrl from '../assets/hero-banner-art-dark.png'

/** 1×1 透明 GIF：拖拽排序时替换浏览器默认的卡片拖影 */
const TRANSPARENT_DRAG_IMG = (() => {
  const img = new Image(1, 1)
  img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  return img
})()

/** 项目聚合统计：文件夹数 / 标注集（页面）数（回收站中的不计入） */
function useProjectStats(projectId: string) {
  return useLiveQuery(async () => {
    const [folders, sets] = await Promise.all([
      productDb.folders.where('projectId').equals(projectId).filter((f) => !f.deletedAt).count(),
      productDb.sets.where('projectId').equals(projectId).filter((s) => !s.deletedAt).count()
    ])
    return { folders, sets }
  }, [projectId])
}

/** 相对时间 */
function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const m = 60e3
  const h = 36e5
  const d = 864e5
  if (diff < m) return '刚刚'
  if (diff < h) return `${Math.floor(diff / m)} 分钟前`
  if (diff < d) return `${Math.floor(diff / h)} 小时前`
  if (diff < 30 * d) return `${Math.floor(diff / d)} 天前`
  return `${Math.floor(diff / (30 * d))} 个月前`
}

/** ───────────── 简化版新建/编辑弹窗 ───────────── */
function ProductProjectModal({ project, onDone, onCancel }: {
  project?: ProductProject
  onDone: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation('productProjectList')
  const navigate = useNavigate()
  const [name, setName] = useState(project?.name ?? '')
  /** 已裁剪确认的 Logo（relativePath = 磁盘相对路径，dataUrl = 预览） */
  const [logo, setLogo] = useState<{ relativePath: string; dataUrl: string } | null>(null)
  /** 无 Logo 时文字占位底色（'' = 自动按项目散列取色） */
  const [logoColor, setLogoColor] = useState(project?.logoColor ?? '')
  /** 待裁剪的原图（选图后先进裁剪确认；含临时文件路径，结束时清理） */
  const [pendingOriginal, setPendingOriginal] = useState<{ relativePath: string; dataUrl: string } | null>(null)
  /** 待裁剪的原图 dataUrl（驱动裁剪弹层显示） */
  const [cropping, setCropping] = useState<string | null>(null)

  const duplicate = useLiveQuery(() => {
    const trimmed = name.trim()
    if (!trimmed) return undefined
    return productDb.projects
      .filter((p) => !p.deletedAt && p.name === trimmed && p.id !== project?.id)
      .first()
  }, [name, project?.id])

  const canSave = name.trim().length > 0 && !duplicate

  // 编辑模式：读取已保存的 Logo 作为初始预览
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
      if (e.key === 'Escape') {
        if (cropping) void handleCropCancel()
        else onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, cropping])

  const pickLogo = async () => {
    const result = await window.electronAPI.selectImage()
    if (!result) return
    // GIF 动图跳过裁剪（canvas 裁剪输出静态 PNG 会丢动画），直接采用 selectImage 已落盘的原图
    if (result.dataUrl.startsWith('data:image/gif')) {
      setLogo(result)
      return
    }
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

  const handleSave = async () => {
    if (!canSave) return
    const nextLogoPath = logo?.relativePath ?? project?.logoPath
    // 替换 Logo 时清理旧图片文件（编辑模式且新旧路径不同）
    if (project?.logoPath && project.logoPath !== nextLogoPath) {
      await window.electronAPI.deleteImage(project.logoPath).catch(() => undefined)
    }
    if (project) {
      await productDb.projects.update(project.id, {
        name: name.trim(),
        ...(nextLogoPath ? { logoPath: nextLogoPath } : { logoPath: undefined }),
        ...(logoColor ? { logoColor } : { logoColor: undefined }),
        updatedAt: Date.now()
      })
    } else {
      const now = Date.now()
      await productDb.projects.add({
        id: genId(),
        name: name.trim(),
        ...(nextLogoPath ? { logoPath: nextLogoPath } : {}),
        ...(logoColor ? { logoColor } : {}),
        createdAt: now,
        updatedAt: now
      })
    }
    onDone()
  }

  /** 编辑模式：删除整个项目（软删除进回收站，标注集/页面/标注与 Logo 文件全部保留，可在回收站还原） */
  const handleDelete = async () => {
    if (!project) return
    const ok = await confirmDialog({ message: t('deleteConfirm', { name: project.name }), tone: 'danger' })
    if (!ok) return
    await softDeleteProductProjects([project.id])
    onDone()
    showToast(t('common:movedToTrash'), { tone: 'info' })
  }

  const avatarSrc = logo?.dataUrl ?? ''

  return (
    <>
      <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
        <div className="modal project-modal">
          <h3>{project ? t('save') : t('create')}</h3>

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
                  navigate(`/product/${duplicate.id}`)
                }}
              >
                {t('openProject')}
              </button>
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
      {cropping && <LogoCropper src={cropping} onCancel={handleCropCancel} onDone={handleCropDone} />}
    </>
  )
}

/** ───────────── 产品项目卡片（平铺视图） ───────────── */
export interface CardDnd {
  dragging?: boolean
  dropPos?: 'before' | 'after' | null
  handlers?: React.HTMLAttributes<HTMLAnchorElement>
}

function ProductProjectCard({ project, dnd }: { project: ProductProject; dnd?: CardDnd }) {
  const { t } = useTranslation('productProjectList')
  const stats = useProjectStats(project.id)

  return (
    <Link
      to={`/product/${project.id}`}
      className={`project-card card${dnd?.dragging ? ' dragging' : ''}${dnd?.dropPos ? ` drop-${dnd.dropPos}` : ''}`}
      {...dnd?.handlers}
    >
      <div className="card-top">
        <ProjectLogo project={project} size={40} />
        <h3 title={project.name}>{project.name}</h3>
      </div>
      <div className="card-stats">
        <span className="card-stat">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          {t('foldersCount', { count: stats?.folders ?? 0 })}
        </span>
        <span className="card-stat">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18" />
            <path d="M9 21V9" />
          </svg>
          {t('setsCount', { count: stats?.sets ?? 0 })}
        </span>
      </div>
      <div className="card-foot">
        <span>{t('updatedAt', { time: timeAgo(project.updatedAt) })}</span>
        <svg className="foot-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m9 18 6-6-6-6" />
        </svg>
      </div>
    </Link>
  )
}

/** ───────────── 产品项目行（列表视图） ───────────── */
function ProductProjectRow({ project, dnd }: { project: ProductProject; dnd?: CardDnd }) {
  const { t } = useTranslation('productProjectList')
  const stats = useProjectStats(project.id)

  return (
    <Link
      to={`/product/${project.id}`}
      className={`project-row product-row${dnd?.dragging ? ' dragging' : ''}${dnd?.dropPos ? ` drop-${dnd.dropPos}` : ''}`}
      {...dnd?.handlers}
    >
      <ProjectLogo project={project} size={32} />
      <span className="row-name" title={project.name}>
        {project.name}
      </span>
      <span className="row-counts">
        {t('foldersCount', { count: stats?.folders ?? 0 })} · {t('setsCount', { count: stats?.sets ?? 0 })}
      </span>
      <span className="row-time">{t('updatedAt', { time: timeAgo(project.updatedAt) })}</span>
      <svg className="row-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m9 18 6-6-6-6" />
      </svg>
    </Link>
  )
}

/** ───────────── 主列表 ───────────── */
export default function ProductProjectList() {
  const { t } = useTranslation('productProjectList')

  const projects = useLiveQuery(async () => (await productDb.projects.toArray()).filter((p) => !p.deletedAt).sort(bySort), [])
  const [showNew, setShowNew] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return (projects ?? []).filter(
      (p) => !kw || p.name.toLowerCase().includes(kw)
    )
  }, [projects, keyword])

  // ===== 拖拽排序 =====
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ id: string; pos: 'before' | 'after' } | null>(null)
  const reorderable = !keyword.trim()

  const reorderProjects = async (fromId: string, toId: string, pos: 'before' | 'after') => {
    if (fromId === toId) return
    const ids = (projects ?? []).map((p) => p.id).filter((x) => x !== fromId)
    const i = ids.indexOf(toId)
    if (i < 0) return
    ids.splice(pos === 'before' ? i : i + 1, 0, fromId)
    for (let k = 0; k < ids.length; k++) {
      await productDb.projects.update(ids[k], { sortNo: (k + 1) * 10 })
    }
  }

  const cardDnd = (id: string, axis: 'x' | 'y'): CardDnd => {
    if (!reorderable) return {}
    return {
      dragging: dragId === id,
      dropPos: dropHint?.id === id ? dropHint.pos : null,
      handlers: {
        draggable: true,
        onDragStart: (e: DragEvent) => {
          setDragId(id)
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', id)
          e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMG, 0, 0)
        },
        onDragEnd: () => {
          setDragId(null)
          setDropHint(null)
        },
        onDragOver: (e: DragEvent) => {
          if (dragId === null || dragId === id) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const rect = e.currentTarget.getBoundingClientRect()
          const pos =
            axis === 'x'
              ? e.clientX < rect.left + rect.width / 2
                ? ('before' as const)
                : ('after' as const)
              : e.clientY < rect.top + rect.height / 2
                ? ('before' as const)
                : ('after' as const)
          setDropHint((prev) => (prev?.id === id && prev.pos === pos ? prev : { id, pos }))
        },
        onDragLeave: (e: DragEvent) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return
          setDropHint((prev) => (prev?.id === id ? null : prev))
        },
        onDrop: (e: DragEvent) => {
          if (dragId === null || dragId === id) return
          e.preventDefault()
          const pos = dropHint?.pos ?? 'after'
          const fromId = dragId
          setDragId(null)
          setDropHint(null)
          void reorderProjects(fromId, id, pos)
        }
      }
    }
  }

  // 关闭弹窗后刷新
  const handleModalDone = () => {
    setShowNew(false)
  }

  return (
    <div className="page project-list-page">
      {/* 顶部横幅 */}
      <div className="rv2-hero projects-hero product-hero">
        <div className="rv2-hero-main">
          <h1 className="rv2-title">{t('title')}</h1>
          <p className="rv2-desc">{t('desc')}</p>
        </div>
        <button className="btn-primary projects-new-btn" onClick={() => setShowNew(true)}>
          {t('newProject')}
        </button>
        {/* 产品模式横幅隐藏装饰插图，高度自适应文字 */}
        <img className="rv2-hero-art product-hero-art" src={heroBannerArtUrl} alt={t('artAlt')} draggable={false} />
        <img className="rv2-hero-art-dark product-hero-art" src={heroBannerArtDarkUrl} alt="" draggable={false} />
      </div>

      <div className="filter-row">
        <div />
        <div className="filter-right">
          <div className="filter-search">
            <span className="search-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            </span>
            <input
              className="input"
              placeholder={t('searchPlaceholder')}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <div className="tabs tabs--icon">
            <button
              type="button"
              className={`tabs-item ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
              title={t('gridView')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
            </button>
            <button
              type="button"
              className={`tabs-item ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
              title={t('listView')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M8 6h13M8 12h13M8 18h13" />
                <circle cx="3.5" cy="6" r="1" fill="currentColor" stroke="none" />
                <circle cx="3.5" cy="12" r="1" fill="currentColor" stroke="none" />
                <circle cx="3.5" cy="18" r="1" fill="currentColor" stroke="none" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {viewMode === 'grid' ? (
        <div className="project-grid">
          {filtered.map((p) => (
            <ProductProjectCard key={p.id} project={p} dnd={cardDnd(p.id, 'x')} />
          ))}
        </div>
      ) : (
        <div className="project-rows">
          {filtered.map((p) => (
            <ProductProjectRow key={p.id} project={p} dnd={cardDnd(p.id, 'y')} />
          ))}
        </div>
      )}

      {projects?.length === 0 && !showNew && (
        <div className="empty-state">
          <p>{t('emptyNoProjects')}</p>
        </div>
      )}
      {!!projects?.length && filtered.length === 0 && (
        <div className="empty-state">
          <p>{t('emptyNoMatch')}</p>
        </div>
      )}

      {/* 新建弹窗 */}
      {showNew && <ProductProjectModal onDone={handleModalDone} onCancel={() => setShowNew(false)} />}
    </div>
  )
}
