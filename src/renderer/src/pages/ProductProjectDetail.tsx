import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState, type MouseEvent, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { productDb, ProductAnnotationSet, ProductPage, ProductProject, ProductFolder, bySort, genId, softDeleteProductFolders, softDeleteProductSets, softDeleteProductProjects, captureProductBatchDeleteUndo, PRODUCT_THUMB_MAX } from '../db/product'
import { pushDeleteUndo, pushUndo } from '../dndUndo'
import { emitGridDrag } from '../gridDragBus'
import { confirmDialog } from '../components/ConfirmDialog'
import { showToast } from '../components/Toast'
import { showScreenPermissionGuide } from '../components/ScreenPermissionGuide'
import { FOLDER_COLORS, FOLDER_ICONS, FolderIconGlyph } from '../components/FolderIcon'
import { LOGO_COLORS, logoColorOf } from '../components/ProjectCard'
import LogoCropper from '../components/LogoCropper'

/** 1×1 透明 GIF：拖拽排序时替换浏览器默认的卡片拖影 */
const TRANSPARENT_DRAG_IMG = (() => {
  const img = new Image(1, 1)
  img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  return img
})()

/** 新建页面来源选择弹窗 */
/** 从 URL 提取站点名称（去除 www. 前缀，域名中 - 替换为空格，首字母大写） */
function urlToSiteName(rawUrl: string): string {
  try {
    const url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`)
    let host = url.hostname.replace(/^www\./, '')
    // 取主域名（去掉子域名）
    const parts = host.split('.')
    if (parts.length >= 2) {
      host = parts.slice(-2).join('.')
    }
    host = host.replace(/-/g, ' ')
    return host.split('.').join(' ').replace(/\b\w/g, (c) => c.toUpperCase())
  } catch {
    return ''
  }
}

function NewPageSourceModal({
  defaultName,
  onSelect,
  onCancel
}: {
  defaultName: string
  onSelect: (source: 'upload' | 'screenshot' | 'url', name: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation('productProjectList')
  const [pageName, setPageName] = useState(defaultName)
  /** URL 采集：展开内嵌 URL 输入框 */
  const [showUrlInput, setShowUrlInput] = useState(false)
  const [urlInput, setUrlInput] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const iconStyle: React.CSSProperties = { width: 20, height: 20, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }
  const cardStyle: React.CSSProperties = {
    width: '100%', padding: '14px 16px', display: 'flex', alignItems: 'flex-start', gap: 12,
    textAlign: 'left', cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 8,
    background: 'var(--surface-1)', transition: 'border-color .15s, background .15s'
  }

  const canSubmit = pageName.trim().length > 0

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" style={{ minWidth: 420, position: 'relative' }}>
        <h3 style={{ margin: '0 0 16px' }}>{t('newPage')}</h3>
        <button
          type="button"
          onClick={onCancel}
          style={{
            position: 'absolute', top: 12, right: 12, background: 'none', border: 'none',
            cursor: 'pointer', color: 'var(--fg-2)', padding: 4, display: 'flex'
          }}
          title={t('cancel', { ns: 'productProjectList' })}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        <label className="field-label">{t('pageNameLabel')}</label>
        <input
          className="input"
          autoFocus
          placeholder={t('pageNamePlaceholder')}
          value={pageName}
          onChange={(e) => setPageName(e.target.value)}
        />

        <p style={{ fontSize: 13, color: 'var(--fg-2, #6b7280)', marginBottom: 12, marginTop: 16 }}>{t('selectPageSource')}</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* ① 本地上传 */}
          <button
            type="button"
            style={cardStyle}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--primary)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)' }}
            onClick={() => canSubmit && onSelect('upload', pageName.trim())}
            disabled={!canSubmit}
          >
            <span style={iconStyle}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{t('uploadLocal')}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-3, #9ca3af)', marginTop: 2 }}>{t('uploadLocalDesc')}</div>
            </div>
          </button>

          {/* ② 调用截图功能 */}
          <button
            type="button"
            style={cardStyle}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--primary)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)' }}
            onClick={() => canSubmit && onSelect('screenshot', pageName.trim())}
            disabled={!canSubmit}
          >
            <span style={iconStyle}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="12" cy="12" r="3" />
                <path d="M3 9h2M19 9h2M3 15h2M19 15h2M9 3v2M15 3v2M9 19v2M15 19v2" />
              </svg>
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{t('captureScreen')}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-3, #9ca3af)', marginTop: 2 }}>{t('captureScreenDesc')}</div>
            </div>
          </button>

          {/* ③ 输入开发 URL */}
          {!showUrlInput ? (
            <button
              type="button"
              style={cardStyle}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--primary)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)' }}
              onClick={() => canSubmit && setShowUrlInput(true)}
              disabled={!canSubmit}
            >
              <span style={iconStyle}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{t('devUrl')}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-3, #9ca3af)', marginTop: 2 }}>{t('devUrlDesc')}</div>
              </div>
            </button>
          ) : (
            <div style={{ ...cardStyle, cursor: 'default', borderColor: 'var(--primary)', background: 'var(--surface-inset)' }}>
              <span style={iconStyle}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>{t('devUrl')}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    autoFocus
                    placeholder={t('enterUrlPlaceholder')}
                    value={urlInput}
                    onChange={(e) => {
                      const val = e.target.value
                      setUrlInput(val)
                      // 自动从 URL 提取站点名称填充页面名称
                      if (val.trim()) {
                        const siteName = urlToSiteName(val)
                        if (siteName) setPageName(siteName)
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && urlInput.trim()) {
                        const normalized = /^https?:\/\//i.test(urlInput) ? urlInput.trim() : `http://${urlInput.trim()}`
                        window.electronAPI.openBrowserWindow(normalized, { captureMode: true })
                      }
                    }}
                  />
                  <button
                    className="btn-primary"
                    disabled={!urlInput.trim()}
                    onClick={() => {
                      if (urlInput.trim()) {
                        const normalized = /^https?:\/\//i.test(urlInput) ? urlInput.trim() : `http://${urlInput.trim()}`
                        window.electronAPI.openBrowserWindow(normalized, { captureMode: true })
                      }
                    }}
                  >
                    {t('openBrowser')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 生成页面缩略图 webp dataURL（最长边 ≤ PRODUCT_THUMB_MAX，高质量降采样） */
async function generatePageThumb(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const maxDim = PRODUCT_THUMB_MAX
      const scale = Math.min(maxDim / img.width, maxDim / img.height, 1)
      const canvas = document.createElement('canvas')
      canvas.width = img.width * scale
      canvas.height = img.height * scale
      const ctx = canvas.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/webp', 0.85))
    }
    img.onerror = () => resolve('')
    img.src = URL.createObjectURL(blob)
  })
}

/** 已执行过缩略图升级的项目（模块级缓存，避免重复扫描） */
const thumbUpgradedProjects = new Set<string>()

/** 旧版 240px 缩略图懒升级：进入项目时按当前分辨率逐页重生成（写回 thumbMax 标记，之后不再重复） */
async function upgradeStaleThumbs(projectId: string): Promise<void> {
  if (thumbUpgradedProjects.has(projectId)) return
  thumbUpgradedProjects.add(projectId)
  try {
    const pages = await productDb.pages.where('projectId').equals(projectId).toArray()
    for (const p of pages) {
      if (p.thumbMax === PRODUCT_THUMB_MAX) continue
      const thumb = await generatePageThumb(p.image)
      if (thumb) await productDb.pages.update(p.id, { thumbDataUrl: thumb, thumbMax: PRODUCT_THUMB_MAX })
    }
  } catch (e) {
    console.error('[ProductDetail] 缩略图升级失败:', e)
  }
}

/** 缩略图占位底色 */
const THUMB_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f43f5e', '#14b8a6', '#0ea5e9', '#f97316', '#22c55e']
const thumbColorOf = (id: string) => {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return THUMB_COLORS[h % THUMB_COLORS.length]
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

/** ───────────── 分节折叠头（标题 + 延伸横线 + 线尽头折叠箭头，样式对齐 UI 走查 PageGrid） ───────────── */
function SectionHead({ title, open, onToggle }: { title: string; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={`grid-sec-head${open ? '' : ' closed'}`} onClick={onToggle}>
      <span className="grid-sec-title">{title}</span>
      <i className="grid-sec-line" aria-hidden />
      <svg
        className="grid-sec-caret"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  )
}

/** ───────────── 标注集操作菜单（右键/悬浮） ───────────── */
interface SetMenuState {
  setId: string
  x: number
  y: number
}

function SetMenu({ menu, sets, onClose, onRenameRequest }: {
  menu: SetMenuState
  sets: ProductAnnotationSet[]
  onClose: () => void
  /** 菜单内「重命名」：关闭菜单并让父组件进入卡片内联重命名（window.prompt 在 Electron 中不可用） */
  onRenameRequest?: () => void
}) {
  const { t } = useTranslation('productProjectList')
  const set = sets.find((s) => s.id === menu.setId)
  if (!set) return null

  const handleRename = () => {
    onClose()
    onRenameRequest?.()
  }

  const handleDelete = async () => {
    const ok = await confirmDialog({
      message: t('deleteSetConfirm', { name: set.name }),
      tone: 'danger'
    })
    if (!ok) return
    await softDeleteProductSets([set.id])
    showToast(t('common:movedToTrash'), { tone: 'info' })
    onClose()
  }

  return (
    <>
      <div
        className="modal-mask"
        style={{ zIndex: 9999 }}
        onMouseDown={onClose}
        onClick={onClose}
      />
      <div
        className="page-menu"
        style={{
          position: 'fixed',
          left: menu.x,
          top: menu.y,
          zIndex: 10000,
          background: 'var(--surface-2, #fff)',
          borderRadius: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,.12)',
          padding: '4px 0',
          minWidth: 120
        }}
      >
        <button
          className="page-menu-item"
          onClick={handleRename}
          style={{
            display: 'block',
            width: '100%',
            padding: '8px 16px',
            border: 'none',
            background: 'none',
            textAlign: 'left',
            cursor: 'pointer',
            fontSize: 13,
            color: 'var(--fg-1, #1a1a1a)'
          }}
        >
          {t('renamePage')}
        </button>
        <button
          className="page-menu-item danger"
          onClick={handleDelete}
          style={{
            display: 'block',
            width: '100%',
            padding: '8px 16px',
            border: 'none',
            background: 'none',
            textAlign: 'left',
            cursor: 'pointer',
            fontSize: 13,
            color: '#ef4444'
          }}
        >
          {t('deletePage')}
        </button>
      </div>
    </>
  )
}

/** ───────────── 产品文件夹弹窗 ───────────── */
function ProductFolderModal({
  projectId,
  parentId,
  folder,
  onDone,
  onCancel
}: {
  projectId: string
  parentId?: string
  folder?: ProductFolder
  onDone: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation('folderModal')
  const navigate = useNavigate()
  const [name, setName] = useState(folder?.name ?? '')
  const [icon, setIcon] = useState(folder?.icon ?? 'folder')
  const [color, setColor] = useState(folder?.color ?? FOLDER_COLORS[0])

  const duplicate = useLiveQuery(() => {
    const trimmed = name.trim()
    if (!trimmed) return undefined
    const key = parentId ?? ''
    return productDb.folders.filter((f) => !f.deletedAt && f.projectId === projectId && (f.parentId ?? '') === key && f.name === trimmed && f.id !== folder?.id).first()
  }, [name, projectId, parentId, folder?.id])

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
    const ok = await confirmDialog({ message: t('deleteConfirm', { name: folder.name }), tone: 'danger' })
    if (!ok) return
    await softDeleteProductFolders([folder.id])
    onDone()
    showToast(t('common:movedToTrash'), { tone: 'info' })
  }

  const handleSave = async () => {
    if (!canSave) return
    if (folder) {
      await productDb.folders.update(folder.id, { name: name.trim(), icon, color })
    } else {
      await productDb.folders.add({
        id: genId(),
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
                navigate(`/product/${projectId}?f=${duplicate.id}`)
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
              {/* 弹窗内实时预览当前所选主题色（默认矢量文件夹 icon 随之着色） */}
              <FolderIconGlyph icon={it.key} size={18} color={icon === it.key ? color : undefined} />
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

/** ───────────── 产品文件夹卡片 ───────────── */
function ProductFolderCard({
  folder,
  onOpen,
  onRename,
  onDelete,
  batchMode,
  selected,
  onToggleSelect,
  dndHandlers,
  dndDragging,
  dndDrop,
}: {
  folder: ProductFolder
  onOpen: () => void
  onRename: () => void
  onDelete: () => void
  batchMode?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  dndHandlers?: React.HTMLAttributes<HTMLDivElement>
  dndDragging?: boolean
  dndDrop?: 'before' | 'after' | 'in' | null
}) {
  const { t } = useTranslation('folderCard')

  const info = useLiveQuery(
    async () => {
      // 文件夹内的标注集（网格并列单位），取各集首图作为 3 格缩略图（回收站中的不计入）
      const sets = (await productDb.sets.where('folderId').equals(folder.id).toArray())
        .filter((s) => !s.deletedAt)
        .sort(bySort)
      const samples = await Promise.all(
        sets.slice(0, 3).map(async (s) => {
          const pages = (await productDb.pages.where('setId').equals(s.id).toArray()).sort(bySort)
          return pages[0]
        })
      )
      const latest = sets.reduce((m, s) => Math.max(m, s.updatedAt), folder.createdAt)
      return { sample: samples.filter((p): p is ProductPage => !!p), count: sets.length, latest }
    },
    [folder.id]
  )

  const handleCardClick = () => {
    if (batchMode) {
      onToggleSelect?.()
      return
    }
    onOpen()
  }

  // 3 格缩略图槽
  const slots = [0, 1, 2]

  return (
    <div
      className={`folder-card${batchMode && selected ? ' selected' : ''}${dndDragging ? ' dragging' : ''}${
        dndDrop ? ` drop-${dndDrop}` : ''
      }`}
      onClick={handleCardClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && !batchMode && handleCardClick()}
      {...dndHandlers}
    >
      {batchMode && (
        <span className={`page-check${selected ? ' checked' : ''}`}>{selected ? '✓' : ''}</span>
      )}
      <div className="folder-slots">
        {slots.map((i) => {
          const pg = info?.sample[i]
          // 与 UI 走查 FolderCard 一致：无图槽位显示浅灰占位 + 小文件夹 icon
          if (!pg || !pg.thumbDataUrl) {
            return (
              <div key={i} className="folder-slot empty">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6a2 2 0 0 1 1.5.68L12.1 6.3H18.5A2.5 2.5 0 0 1 21 8.8v8.7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Z" />
                </svg>
              </div>
            )
          }
          return (
            <div key={pg.id} className="folder-slot">
              <img src={pg.thumbDataUrl} alt="" draggable={false} loading="lazy" />
            </div>
          )
        })}
      </div>
      <div className="folder-meta">
        <span className="folder-name-row">
          <span className="folder-glyph" style={folder.color ? { color: folder.color } : undefined}>
            <FolderIconGlyph icon={folder.icon} size={14} color={folder.color} />
          </span>
          <span className="folder-name" title={folder.name}>
            {folder.name}
          </span>
        </span>
        <span className="folder-time">
          {info?.count
            ? t('updatedAt', { time: timeAgo(info.latest) })
            : t('createdAt', { time: timeAgo(folder.createdAt) })}
        </span>
      </div>
      {!batchMode && (
        <div className="folder-actions">
          <button type="button" className="folder-act-btn" title={t('renameTitle')} onClick={(e) => { e.stopPropagation(); onRename(); }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
            </svg>
          </button>
          <button type="button" className="folder-act-btn danger" title={t('deleteTitle')} onClick={(e) => { e.stopPropagation(); onDelete(); }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}

/** ───────────── 项目编辑弹窗 ───────────── */
function ProjectEditModal({ project, onDone, onCancel }: {
  project: ProductProject
  onDone: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation('productProjectList')
  const navigate = useNavigate()
  const [name, setName] = useState(project.name)
  /** 已裁剪确认的 Logo（relativePath = 磁盘相对路径，dataUrl = 预览） */
  const [logo, setLogo] = useState<{ relativePath: string; dataUrl: string } | null>(null)
  /** 无 Logo 时文字占位底色（'' = 自动按项目散列取色） */
  const [logoColor, setLogoColor] = useState(project.logoColor ?? '')
  /** 待裁剪的原图（选图后先进裁剪确认；含临时文件路径，结束时清理） */
  const [pendingOriginal, setPendingOriginal] = useState<{ relativePath: string; dataUrl: string } | null>(null)
  /** 待裁剪的原图 dataUrl（驱动裁剪弹层显示） */
  const [cropping, setCropping] = useState<string | null>(null)

  const duplicate = useLiveQuery(() => {
    const trimmed = name.trim()
    if (!trimmed) return undefined
    return productDb.projects.filter((p) => !p.deletedAt && p.name === trimmed && p.id !== project.id).first()
  }, [name, project.id])

  const canSave = name.trim().length > 0 && !duplicate

  // 编辑模式：读取已保存的 Logo 作为初始预览
  useEffect(() => {
    const p = project.logoPath
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
  }, [project.logoPath])

  // Esc 关闭（裁剪弹层打开时先关裁剪）
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
    const nextLogoPath = logo?.relativePath ?? project.logoPath
    // 替换 Logo 时清理旧图片文件（新旧路径不同）
    if (project.logoPath && project.logoPath !== nextLogoPath) {
      await window.electronAPI.deleteImage(project.logoPath).catch(() => undefined)
    }
    await productDb.projects.update(project.id, {
      name: name.trim(),
      ...(nextLogoPath ? { logoPath: nextLogoPath } : { logoPath: undefined }),
      ...(logoColor ? { logoColor } : { logoColor: undefined }),
      updatedAt: Date.now()
    })
    onDone()
  }

  const handleDelete = async () => {
    const ok = await confirmDialog({
      message: t('deleteConfirm', { name: project.name }),
      tone: 'danger'
    })
    if (!ok) return
    // 软删除进回收站：项目及其下文件夹/标注集/页面打同一批标记，记录与 Logo 文件全部保留
    await softDeleteProductProjects([project.id])
    navigate('/product')
    onDone()
    showToast(t('common:movedToTrash'), { tone: 'info' })
  }

  const avatarSrc = logo?.dataUrl ?? ''

  return (
    <>
      <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal project-modal">
        <h3>{t('save')}</h3>

        <label className="field-label">{t('logoLabel')}</label>
        <div className="logo-picker">
          {/* 上传/更换统一收口到点击 Logo 头像本身（已设置时悬停显示「更换 Logo」提示） */}
          <button
            className={`logo-avatar${avatarSrc ? ' has-logo' : ''}`}
            onClick={pickLogo}
            title={avatarSrc ? t('logoReplaceTitle') : t('logoPickTitle')}
            style={avatarSrc ? undefined : { background: logoColor || logoColorOf(project.id) }}
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
          <button className="btn-danger" onClick={handleDelete}>
            {t('deleteProject')}
          </button>
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button className="btn-primary" disabled={!canSave} onClick={handleSave}>
            {t('save')}
          </button>
        </div>
      </div>
      </div>
      {/* Logo 裁剪弹层（覆盖在编辑弹窗之上） */}
      {cropping && (
        <LogoCropper src={cropping} onCancel={handleCropCancel} onDone={handleCropDone} />
      )}
    </>
  )
}

/** ───────────── 标注集卡片（项目网格并列单位，对等 UI 走查 page-card：进入后画板内左侧缩略图管理集内多页面） ───────────── */
function SetCard({
  set,
  projectId,
  batchMode,
  selected,
  dnd,
  renaming,
  onCardClick,
  onContextMenu,
  onStartRename,
  onRenameDone,
  onDelete
}: {
  set: ProductAnnotationSet
  projectId: string
  batchMode: boolean
  selected: boolean
  dnd?: {
    dragging?: boolean
    dropPos?: 'before' | 'after' | null
    handlers?: React.AnchorHTMLAttributes<HTMLAnchorElement>
  }
  /** 当前卡片处于内联重命名态（父组件统一管理，编辑按钮 / 右键菜单均可触发） */
  renaming?: boolean
  onCardClick?: (e: MouseEvent, setId: string) => void
  onContextMenu?: (e: MouseEvent, setId: string) => void
  onStartRename?: (setId: string) => void
  /** 提交重命名；newName 为 null 表示取消 */
  onRenameDone?: (setId: string, newName: string | null) => void
  onDelete?: (setId: string) => void
}) {
  const { t } = useTranslation('productProjectList')
  const [renameValue, setRenameValue] = useState(set.name)
  const renameRef = useRef<HTMLInputElement>(null)

  // 进入重命名态：同步输入值并把光标置于名称末尾（不全选）
  useEffect(() => {
    if (!renaming) return
    setRenameValue(set.name)
    setTimeout(() => {
      const el = renameRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    }, 0)
  }, [renaming, set.name])

  const commitSetRename = (cancel = false) => {
    onRenameDone?.(set.id, cancel ? null : renameValue.trim() || null)
  }

  // 集内页面（按 sortNo 排序）：首页做缩略图，页面数展示在卡片底部（回收站中的不计入）
  const setPages = useLiveQuery(
    async () =>
      (await productDb.pages.where('setId').equals(set.id).toArray()).filter((p) => !p.deletedAt).sort(bySort),
    [set.id]
  )
  const firstPage = setPages?.[0]

  return (
    <Link
      to={`/product/${projectId}/set/${set.id}`}
      className={`page-card${dnd?.dragging ? ' dragging' : ''}${dnd?.dropPos ? ` drop-${dnd.dropPos}` : ''}${batchMode && selected ? ' selected' : ''}`}
      {...dnd?.handlers}
      draggable={renaming ? false : !!dnd?.handlers?.draggable}
      onClick={(e) => {
        // 重命名中禁止卡片跳转
        if (renaming) {
          e.preventDefault()
          return
        }
        onCardClick?.(e, set.id)
      }}
      onContextMenu={(e) => onContextMenu?.(e, set.id)}
    >
      {batchMode && (
        <span className={`page-check${selected ? ' checked' : ''}`}>
          {selected ? '✓' : ''}
        </span>
      )}
      {/* 缩略图：与 UI 走查 page-card 同类名同几何（page-thumb 16:10），无图时色块占位 */}
      {firstPage?.thumbDataUrl ? (
        <img className="page-thumb" src={firstPage.thumbDataUrl} alt="" draggable={false} loading="lazy" />
      ) : (
        <div className="page-thumb" style={{
          background: thumbColorOf(set.id),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontSize: 24,
          fontWeight: 600
        }}>
          {set.name.slice(0, 1)}
        </div>
      )}
      <span className="page-name-row">
        {renaming ? (
          <input
            ref={renameRef}
            className="page-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => commitSetRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitSetRename()
              if (e.key === 'Escape') commitSetRename(true)
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="page-name" title={set.name}>{set.name}</span>
        )}
      </span>
      <span className="page-time">
        {setPages !== undefined ? `${t('pageCountLabel', { n: setPages.length })} · ${timeAgo(set.updatedAt)}` : ''}
      </span>
      {/* 悬停编辑/删除按钮（与文件夹卡片一致） */}
      {!batchMode && (
        <div className="folder-actions">
          <button type="button" className="folder-act-btn" title={t('renamePage')} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onStartRename?.(set.id); }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
            </svg>
          </button>
          <button type="button" className="folder-act-btn danger" title={t('deletePage')} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete?.(set.id); }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
            </svg>
          </button>
        </div>
      )}
    </Link>
  )
}

/** ───────────── 拖拽类型定义 ───────────── */
type GridDrag = { kind: 'set', id: string } | { kind: 'folder', id: string }
type DropHint =
  | { kind: 'set', id: string, pos: 'before' | 'after' }
  | { kind: 'folder', id: string, pos: 'before' | 'after' | 'in' }
  | null

/** ───────────── 主页面 ───────────── */
export default function ProductProjectDetail() {
  const { t } = useTranslation('productProjectList')
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // 当前文件夹（URL ?f=<folderId> 控制文件夹视图）
  const activeFolderId = searchParams.get('f')

  const [editing, setEditing] = useState(false)
  const [batchMode, setBatchMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [setMenu, setSetMenu] = useState<SetMenuState | null>(null)
  // 内联重命名的标注集 id（卡片编辑按钮 / 右键菜单共用）
  const [renamingSetId, setRenamingSetId] = useState<string | null>(null)
  // 文件夹区 / 页面（标注集）区分节折叠（默认展开）
  const [foldersOpen, setFoldersOpen] = useState(true)
  const [setsOpen, setSetsOpen] = useState(true)

  // 文件夹弹窗状态
  const [folderModal, setFolderModal] = useState<{ mode: 'create' } | { mode: 'edit'; folder: ProductFolder } | null>(null)
  // 新建页面来源选择弹窗
  const [showNewPageSource, setShowNewPageSource] = useState(false)

  // 关闭弹窗/菜单/批量模式当 projectId 变化时
  useEffect(() => {
    setEditing(false)
    setBatchMode(false)
    setSelected(new Set())
    setSetMenu(null)
    setFolderModal(null)
  }, [projectId])

  // 进入项目时后台升级旧版 240px 缩略图（网格卡片与文件夹三格预览共用）
  useEffect(() => {
    if (!projectId) return
    void upgradeStaleThumbs(projectId)
  }, [projectId])

  // 监听内置浏览器 URL 采集回传
  useEffect(() => {
    if (!projectId) return
    const cleanup = (window.electronAPI as any).onNewPageResult(async (data: { dataUrl: string; name?: string }) => {
      const setId = await handleScreenshotResult(data.dataUrl, data.name)
      if (setId) navigate(`/product/${projectId}/set/${setId}`)
    })
    return () => { if (cleanup) cleanup() }
  }, [projectId])

  // 批量条出现/消失时同步 body 类
  useEffect(() => {
    document.body.classList.toggle('batch-bar-active', batchMode)
    return () => document.body.classList.remove('batch-bar-active')
  }, [batchMode])

  const project = useLiveQuery(() => productDb.projects.get(projectId!), [projectId])

  // 所有文件夹（回收站中的不参与展示与防环）
  const allFolders = useLiveQuery(
    async () =>
      (await productDb.folders.where('projectId').equals(projectId!).toArray())
        .filter((f) => !f.deletedAt)
        .sort(bySort),
    [projectId]
  )

  // 当前层级的子文件夹
  const subFolders = useMemo(
    () => (allFolders ?? []).filter(
      (f) => (activeFolderId ? f.parentId === activeFolderId : !f.parentId)
    ),
    [allFolders, activeFolderId]
  )

  // 当前层级的标注集（文件夹内标注集 或 根级标注集）——项目网格并列单位（回收站中的不展示）
  const levelSets = useLiveQuery(
    async () => {
      if (activeFolderId) {
        return (await productDb.sets.where('folderId').equals(activeFolderId).toArray())
          .filter((s) => !s.deletedAt)
          .sort(bySort)
      }
      return (await productDb.sets.where('projectId').equals(projectId!).toArray())
        .filter((s) => !s.folderId && !s.deletedAt)
        .sort(bySort)
    },
    [projectId, activeFolderId]
  )

  // 面包屑导航
  const breadcrumb = useMemo(() => {
    if (!activeFolderId || !allFolders) return []
    const chain: ProductFolder[] = []
    let cur = allFolders.find((f) => f.id === activeFolderId)
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      chain.unshift(cur)
      cur = cur.parentId ? allFolders.find((f) => f.id === cur!.parentId) : undefined
    }
    return chain
  }, [activeFolderId, allFolders])

  // 文件夹判断：防止循环嵌套
  const folderIsDescendant = (ancestorId: string, id: string): boolean => {
    if (!allFolders) return false
    let cur = allFolders.find((f) => f.id === id)
    const seen = new Set<string>()
    while (cur?.parentId) {
      if (cur.parentId === ancestorId) return true
      if (seen.has(cur.parentId)) return false
      seen.add(cur.parentId)
      cur = allFolders.find((f) => f.id === cur!.parentId)
    }
    return false
  }

  // 跳转到文件夹
  const jumpToFolder = (id: string) => {
    setBatchMode(false)
    setSelected(new Set())
    setSearchParams(id ? { f: id } : {})
  }

  // 无项目时跳转回列表
  useEffect(() => {
    if (project === null && projectId) {
      navigate('/product')
    }
  }, [project, projectId, navigate])

  /** 批量选中切换 */
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 批量删除（标注集 + 文件夹），删除后可 Cmd+Z 撤回 */
  const handleBatchDelete = async () => {
    if (!selected.size) return
    const ok = await confirmDialog({
      message: t('batchDeleteConfirm', { n: selected.size }),
      tone: 'danger'
    })
    if (!ok) return
    // 删除前快照（Cmd+Z 撤回）：记录完整级联数据，删除落库成功后压撤销栈
    const undoData = await captureProductBatchDeleteUndo([...selected])
    // 软删除进回收站：标注集与文件夹同一批时间戳，记录、标注与页面 Blob 全部保留
    const ts = Date.now()
    const folderIds = [...selected].filter((id) => allFolders?.some((f) => f.id === id))
    const setIds = [...selected].filter((id) => !folderIds.includes(id))
    await softDeleteProductFolders(folderIds, ts)
    await softDeleteProductSets(setIds, ts)
    pushDeleteUndo('product', undoData)
    showToast(
      t('batchDeleted', {
        n: selected.size,
        keys: navigator.platform.toLowerCase().includes('mac') ? '⌘Z' : 'Ctrl+Z'
      })
    )
    setSelected(new Set())
    setBatchMode(false)
  }

  /** 提交/取消标注集内联重命名（newName 为 null 表示取消） */
  const handleRenameSet = async (setId: string, newName: string | null) => {
    setRenamingSetId(null)
    if (!newName) return
    const set = levelSets?.find((s) => s.id === setId)
    if (!set || newName === set.name) return
    await productDb.sets.update(setId, { name: newName, updatedAt: Date.now() })
  }

  /** 删除标注集（软删除进回收站，可在回收站还原） */
  const handleDeleteSet = async (setId: string) => {
    const set = levelSets?.find((s) => s.id === setId)
    if (!set) return
    const ok = await confirmDialog({
      message: t('deletePageConfirm', { name: set.name }),
      tone: 'danger'
    })
    if (!ok) return
    await softDeleteProductSets([setId])
    showToast(t('common:movedToTrash'), { tone: 'info' })
  }

  /** 同层级（同项目同文件夹）重名时自动加序号后缀（xx 2 / xx 3 …）：每次上传/采集都保存为新标注集 */
  const uniqueSetName = async (base: string): Promise<string> => {
    const name = base.trim()
    if (!name) return name
    const siblings = await productDb.sets.where('projectId').equals(projectId!).toArray()
    const taken = new Set(
      siblings
        .filter((s) => !s.deletedAt && (s.folderId || undefined) === (activeFolderId || undefined))
        .map((s) => s.name)
    )
    if (!taken.has(name)) return name
    let n = 2
    while (taken.has(`${name} ${n}`)) n++
    return `${name} ${n}`
  }

  /** 上传文件 → 生成缩略图 → 创建标注集 + 页面，返回 setId */
  const handleUploadFile = async (file: File, name?: string): Promise<string | undefined> => {
    const thumb = await generatePageThumb(file)
    const fileName = file.name.replace(/\.[^.]+$/, '')
    const setName = await uniqueSetName(name || fileName)
    if (!setName || !setName.trim()) return
    const setId = genId()
    const set: ProductAnnotationSet = {
      id: setId,
      projectId: projectId!,
      folderId: activeFolderId || undefined,
      name: setName.trim(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await productDb.sets.add(set)
    await productDb.pages.add({
      id: genId(),
      projectId: projectId!,
      setId,
      name: fileName,
      image: file,
      thumbDataUrl: thumb,
      thumbMax: PRODUCT_THUMB_MAX,
      createdAt: Date.now(),
    })
    return setId
  }

  /** 截图结果 → 创建标注集 + 页面，返回 setId */
  const handleScreenshotResult = async (dataUrl: string, name?: string): Promise<string | undefined> => {
    const defaultName = `页面 ${levelSets ? levelSets.length + 1 : 1}`
    const setName = await uniqueSetName(name || defaultName)
    if (!setName || !setName.trim()) return
    const setId = genId()
    const set: ProductAnnotationSet = {
      id: setId,
      projectId: projectId!,
      folderId: activeFolderId || undefined,
      name: setName.trim(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await productDb.sets.add(set)
    // 截图 dataUrl → File
    const blob = await fetch(dataUrl).then((r) => r.blob())
    const file = new File([blob], 'screenshot.png', { type: 'image/png' })
    const thumb = await generatePageThumb(file)
    await productDb.pages.add({
      id: genId(),
      projectId: projectId!,
      setId,
      name: defaultName,
      image: file,
      thumbDataUrl: thumb,
      thumbMax: PRODUCT_THUMB_MAX,
      createdAt: Date.now(),
    })
    return setId
  }

  /** 卡片点击处理（批量模式下切换选中） */
  const handleCardClick = (e: MouseEvent, setId: string) => {
    if (!batchMode) return
    e.preventDefault()
    toggleSelect(setId)
  }

  /** 右键菜单 */
  const handleContextMenu = (e: MouseEvent, setId: string) => {
    e.preventDefault()
    setSetMenu({ setId, x: e.clientX, y: e.clientY })
  }

  // 关闭右键菜单
  useEffect(() => {
    if (!setMenu) return
    const handler = () => setSetMenu(null)
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [setMenu])

  // ===== 拖拽排序 =====
  const [drag, setDrag] = useState<GridDrag | null>(null)
  const [dropHint, setDropHint] = useState<DropHint>(null)
  /** 当前拖拽悬停的面包屑路径胶囊 id（高亮提示）；拖拽结束（含取消）时清除 */
  const [crumbDrop, setCrumbDrop] = useState<string | null>(null)
  useEffect(() => {
    if (!drag) setCrumbDrop(null)
    // 广播给侧边栏树（Layout）：网格卡片可拖到左侧文件夹/项目根节点放置
    emitGridDrag(drag ? { mode: 'product', kind: drag.kind, id: drag.id, projectId: projectId!, parentId: activeFolderId || undefined } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag])

  const reorderInList = async (
    which: 'folders' | 'sets',
    list: { id: string }[],
    fromId: string,
    toId: string,
    pos: 'before' | 'after'
  ) => {
    if (fromId === toId) return
    const ids = list.map((x) => x.id).filter((x) => x !== fromId)
    const i = ids.indexOf(toId)
    if (i < 0) return
    ids.splice(pos === 'before' ? i : i + 1, 0, fromId)
    // 排序前压撤销栈（Cmd+Z 撤回；文件夹与标注集均支持）
    await pushUndo('product')
    for (let k = 0; k < ids.length; k++) {
      const changes = { sortNo: (k + 1) * 10 }
      if (which === 'folders') await productDb.folders.update(ids[k], changes)
      else await productDb.sets.update(ids[k], changes)
    }
  }

  /** 拖入文件夹：标注集挂到目标文件夹末尾，文件夹挂为目标子级（已防环） */
  const moveToFolder = async (targetFolderId: string, d: GridDrag) => {
    if (d.kind === 'set') {
      const st = levelSets?.find((s) => s.id === d.id)
      if (!st || st.folderId === targetFolderId) return
      await pushUndo('product')
      const siblings = await productDb.sets.where('folderId').equals(targetFolderId).toArray()
      const maxSort = siblings.reduce((m, s) => Math.max(m, s.sortNo ?? 0), 0)
      await productDb.sets.update(d.id, { folderId: targetFolderId, sortNo: maxSort + 10, updatedAt: Date.now() })
    } else {
      const f = allFolders?.find((x) => x.id === d.id)
      if (!f || f.parentId === targetFolderId) return
      // 防止循环嵌套
      if (folderIsDescendant(targetFolderId, d.id)) return
      await pushUndo('product')
      const siblings = await productDb.folders.where('parentId').equals(targetFolderId).toArray()
      const maxSort = siblings.reduce((m, x) => Math.max(m, x.sortNo ?? 0), 0)
      await productDb.folders.update(d.id, { parentId: targetFolderId, sortNo: maxSort + 10 })
    }
  }

  /** 拖到面包屑路径胶囊释放：移动到该层末尾（'' = 项目根，写回无 parentId/folderId 的初始态；其余层复用 moveToFolder） */
  const moveToCrumbSeg = async (targetFolderId: string, d: GridDrag) => {
    if (targetFolderId) {
      await moveToFolder(targetFolderId, d)
      return
    }
    if (d.kind === 'set') {
      const st = levelSets?.find((s) => s.id === d.id)
      if (!st || !st.folderId) return
      await pushUndo('product')
      const siblings = (await productDb.sets.where('projectId').equals(projectId!).toArray()).filter((s) => !s.folderId)
      const maxSort = siblings.reduce((m, s) => Math.max(m, s.sortNo ?? 0), 0)
      await productDb.sets.update(d.id, { folderId: undefined, sortNo: maxSort + 10, updatedAt: Date.now() })
    } else {
      const f = allFolders?.find((x) => x.id === d.id)
      if (!f || !f.parentId) return
      await pushUndo('product')
      const maxSort = (allFolders ?? []).filter((x) => !x.parentId).reduce((m, x) => Math.max(m, x.sortNo ?? 0), 0)
      await productDb.folders.update(d.id, { parentId: undefined, sortNo: maxSort + 10 })
    }
  }

  // 文件夹拖拽 handlers（对齐走查 PageGrid 交互）：文件夹拖到文件夹时左/右缘竖条或上/下 25% 换位（同级排序）、正中块才拖入子级；标注集拖到文件夹整卡视为放入目标
  const folderDnd = (folder: ProductFolder): React.HTMLAttributes<HTMLDivElement> | undefined => {
    if (batchMode) return undefined
    return {
      draggable: true,
      onDragStart: (e: DragEvent<HTMLDivElement>) => {
        setDrag({ kind: 'folder', id: folder.id })
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMG, 0, 0)
        e.dataTransfer.setData('text/plain', folder.id)
      },
      onDragEnd: () => {
        setDrag(null)
        setDropHint(null)
      },
      onDragOver: (e: DragEvent<HTMLDivElement>) => {
        if (!drag) return
        if (drag.kind === 'folder') {
          // 防环：不能放入自己或自己的子孙
          if (drag.id === folder.id || folderIsDescendant(folder.id, drag.id)) return
          const rect = e.currentTarget.getBoundingClientRect()
          const r = (e.clientY - rect.top) / rect.height
          const x = (e.clientX - rect.left) / rect.width
          // 落点判定：左右缘竖条优先同级换位（before/after），否则按上下 25% 换位，正中块才拖入子级
          const pos: 'before' | 'after' | 'in' = x < 0.3 ? 'before' : x > 0.7 ? 'after' : r < 0.25 ? 'before' : r > 0.75 ? 'after' : 'in'
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setDropHint((prev) => (prev?.kind === 'folder' && prev.id === folder.id && prev.pos === pos ? prev : { kind: 'folder', id: folder.id, pos }))
        } else {
          // 标注集拖到文件夹：整卡视为放入目标
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setDropHint((prev) => (prev?.kind === 'folder' && prev.id === folder.id && prev.pos === 'in' ? prev : { kind: 'folder', id: folder.id, pos: 'in' }))
        }
      },
      onDragLeave: (e: DragEvent<HTMLDivElement>) => {
        if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return
        setDropHint((prev) => (prev?.kind === 'folder' && prev.id === folder.id ? null : prev))
      },
      onDrop: (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault()
        const hint = dropHint
        const d = drag
        setDrag(null)
        setDropHint(null)
        if (!hint || hint.kind !== 'folder' || hint.id !== folder.id || !d) return
        if (hint.pos === 'in') {
          void moveToFolder(folder.id, d)
        } else if (d.kind === 'folder' && d.id !== folder.id) {
          void reorderInList('folders', subFolders, d.id, folder.id, hint.pos)
        }
      }
    }
  }

  // 标注集（页面卡片）拖拽 handlers：标注集与标注集之间按横向中点换位（同一父级内），对齐走查 PageGrid
  const setDnd = (id: string): React.AnchorHTMLAttributes<HTMLAnchorElement> | undefined => {
    if (batchMode) return undefined
    return {
      draggable: true,
      onDragStart: (e: DragEvent<HTMLAnchorElement>) => {
        setDrag({ kind: 'set', id })
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMG, 0, 0)
        e.dataTransfer.setData('text/plain', id)
      },
      onDragEnd: () => {
        setDrag(null)
        setDropHint(null)
      },
      onDragOver: (e: DragEvent<HTMLAnchorElement>) => {
        if (!drag || drag.kind !== 'set' || drag.id === id) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const rect = e.currentTarget.getBoundingClientRect()
        const pos: 'before' | 'after' = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
        setDropHint((prev) => (prev?.kind === 'set' && prev.id === id && prev.pos === pos ? prev : { kind: 'set', id, pos }))
      },
      onDragLeave: (e: DragEvent<HTMLAnchorElement>) => {
        if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return
        setDropHint((prev) => (prev?.kind === 'set' && prev.id === id ? null : prev))
      },
      onDrop: (e: DragEvent<HTMLAnchorElement>) => {
        e.preventDefault()
        const hint = dropHint
        const d = drag
        setDrag(null)
        setDropHint(null)
        if (!hint || hint.kind !== 'set' || hint.id !== id || !d || d.kind !== 'set' || d.id === id) return
        if (hint.pos === 'before' || hint.pos === 'after') void reorderInList('sets', levelSets ?? [], d.id, id, hint.pos)
      }
    }
  }

  // 面包屑路径链：项目根 + 中间文件夹（不含当前层）
  const crumbTrail = useMemo(
    () => [
      { id: '', name: project?.name ?? t('defaultName', { ns: 'projectDetail' }) },
      ...(activeFolderId && breadcrumb.length > 0
        ? breadcrumb.slice(0, -1).map((f) => ({ id: f.id, name: f.name }))
        : []),
    ],
    [activeFolderId, breadcrumb, project?.name, t]
  )

  const totalCount = ((subFolders ?? []).length + (levelSets ?? []).length)
  const allSelected = totalCount > 0 && selected.size === totalCount

  // 合并当前层级标注集用于右键菜单
  const allSetsForMenu = levelSets ?? []

  // 当前文件夹对象
  const activeFolder = activeFolderId ? allFolders?.find((f) => f.id === activeFolderId) : undefined
  const inFolderView = !!activeFolderId

  return (
    <div className="page">
      {/* 顶部横幅：文件夹视图显示路径导航 + 当前文件夹名；根视图显示返回 + 项目名 */}
      <div className="rv2-hero detail-hero">
        <div className="rv2-hero-main">
          {inFolderView && activeFolder ? (
            <>
              {/* 路径胶囊链：与 UI 走查同款。
                  拖住网格内的标注集/文件夹悬停到胶囊上高亮，释放即移动到该层 */}
              <div className="hero-crumb">
                {crumbTrail.map((seg, i) => (
                  <button
                    key={seg.id || 'root'}
                    type="button"
                    className={`back-link hero-crumb-pill${i === 0 ? ' has-icon' : ''}${crumbDrop === seg.id ? ' crumb-drop' : ''}`}
                    onClick={() => jumpToFolder(seg.id)}
                    title={seg.name}
                    onDragOver={(e) => {
                      if (!drag) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      setCrumbDrop((prev) => (prev === seg.id ? prev : seg.id))
                    }}
                    onDragLeave={(e) => {
                      if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return
                      setCrumbDrop((prev) => (prev === seg.id ? null : prev))
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      const d = drag
                      setDrag(null)
                      setDropHint(null)
                      if (d) void moveToCrumbSeg(seg.id, d)
                    }}
                  >
                    {i === 0 && (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M15 18l-6-6 6-6" />
                      </svg>
                    )}
                    <span className="crumb-pill-text">{seg.name}</span>
                  </button>
                ))}
              </div>
              <h1 className="rv2-title detail-title">
                <span
                  className="folder-title-glyph"
                  style={activeFolder.color ? { color: activeFolder.color } : undefined}
                >
                  <FolderIconGlyph icon={activeFolder.icon} size={30} color={activeFolder.color} />
                </span>
                <span className="detail-title-text">{activeFolder.name}</span>
                <button
                  className="title-edit-btn"
                  onClick={() => setFolderModal({ mode: 'edit', folder: activeFolder })}
                  title={t('editFolder', { ns: 'folderModal' })}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
                  </svg>
                </button>
              </h1>
            </>
          ) : (
            <>
              <Link to="/product" className="back-link" draggable={false}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                {t('backToProducts')}
              </Link>
              <h1 className="rv2-title detail-title">
                <span className="detail-title-text">{project?.name ?? '...'}</span>
                {project && (
                  <button
                    className="title-edit-btn"
                    onClick={() => setEditing(true)}
                    title={t('editProject')}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
                    </svg>
                  </button>
                )}
              </h1>
            </>
          )}
        </div>
        <div className="detail-actions">
          {(totalCount) > 0 && (
            <button
              className={`btn-secondary batch-toggle${batchMode ? ' active' : ''}`}
              onClick={() => setBatchMode(!batchMode)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
                <path d="m8.5 12.2 2.6 2.6 4.9-5.2" />
              </svg>
              {batchMode ? t('exitBatch') : t('batchMode')}
            </button>
          )}
          <button
            className="btn-secondary"
            onClick={() => setFolderModal({ mode: 'create' })}
            title={t('newFolder')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            </svg>
            {t('newFolder')}
          </button>
          <button
            className="btn-primary"
            onClick={() => setShowNewPageSource(true)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
            {t('newPage')}
          </button>
        </div>
      </div>

      {/* 文件夹 + 页面（标注集）分节网格：分节折叠头样式对齐 UI 走查（文件夹区 + 页面区各自可折叠） */}
      {(subFolders.length > 0 || (!batchMode) || levelSets && levelSets.length > 0) ? (
        <div className="page-grid-section">
          {/* 文件夹区：空层且非批量模式时也显示「新建文件夹」入口 */}
          {(subFolders.length > 0 || !batchMode) && (
            <>
              <SectionHead title={t('foldersSection')} open={foldersOpen} onToggle={() => setFoldersOpen((v) => !v)} />
              {foldersOpen && (
                <div className="page-grid folder-grid">
                  {subFolders.map((folder) => (
                    <ProductFolderCard
                      key={folder.id}
                      folder={folder}
                      onOpen={() => jumpToFolder(folder.id)}
                      onRename={() => setFolderModal({ mode: 'edit', folder })}
                      onDelete={() => setFolderModal({ mode: 'edit', folder })}
                      batchMode={batchMode}
                      selected={selected.has(folder.id)}
                      onToggleSelect={() => toggleSelect(folder.id)}
                      dndHandlers={folderDnd(folder)}
                      dndDragging={drag?.kind === 'folder' && drag.id === folder.id}
                      dndDrop={dropHint?.kind === 'folder' && dropHint.id === folder.id ? dropHint.pos : null}
                    />
                  ))}
                  {/* 文件夹末尾快捷操作：新建文件夹 */}
                  {!batchMode && (
                    <button
                      type="button"
                      className="folder-card add-folder"
                      onClick={() => setFolderModal({ mode: 'create' })}
                    >
                      <span className="grid-add-label">{t('addFolder', { ns: 'pageGrid' })}</span>
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          {/* 页面（标注集）区 */}
          <SectionHead title={t('pagesSection')} open={setsOpen} onToggle={() => setSetsOpen((v) => !v)} />
          {setsOpen && (
            <div className="page-grid">
              {levelSets?.map((set) => (
                <SetCard
                  key={set.id}
                  set={set}
                  projectId={projectId!}
                  batchMode={batchMode}
                  selected={selected.has(set.id)}
                  dnd={{
                    dragging: drag?.kind === 'set' && drag.id === set.id,
                    dropPos: dropHint?.kind === 'set' && dropHint.id === set.id ? dropHint.pos : null,
                    handlers: setDnd(set.id)
                  }}
                  onCardClick={handleCardClick}
                  onContextMenu={handleContextMenu}
                  renaming={renamingSetId === set.id}
                  onStartRename={(sid) => setRenamingSetId(sid)}
                  onRenameDone={handleRenameSet}
                  onDelete={handleDeleteSet}
                />
              ))}

              {!batchMode && (
                <button
                  type="button"
                  className="page-card add-page"
                  onClick={() => setShowNewPageSource(true)}
                  draggable={false}
                >
                  <span className="grid-add-label">{t('addMore')}</span>
                </button>
              )}
            </div>
          )}
        </div>
      ) : levelSets !== undefined ? (
        <div className="empty-state">
          <p>{t('emptyState')}</p>
        </div>
      ) : null}

      {/* 批量管理条 */}
      {batchMode && totalCount > 0 && (
        <div className="batch-bar">
          <label className="inline-label">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? new Set([
                      ...(subFolders.map((f) => f.id)),
                      ...(levelSets?.map((s) => s.id) ?? [])
                    ])
                    : new Set()
                )
              }
            />
            {t('selectAll')}
          </label>
          <span className="batch-count">{t('selectedCount', { n: selected.size })}</span>
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={() => setBatchMode(false)}>
            {t('exitBatch')}
          </button>
          <button className="btn-danger" onClick={handleBatchDelete} disabled={!selected.size}>
            {t('deleteSelected')}
          </button>
        </div>
      )}

      {/* 右键菜单 */}
      {setMenu && (
        <SetMenu
          menu={setMenu}
          sets={allSetsForMenu}
          onClose={() => setSetMenu(null)}
          onRenameRequest={() => {
            if (setMenu) setRenamingSetId(setMenu.setId)
          }}
        />
      )}

      {/* 项目编辑弹窗 */}
      {editing && project && (
        <ProjectEditModal
          project={project}
          onDone={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      )}

      {/* 新建页面来源选择弹窗 */}
      {showNewPageSource && (
        <NewPageSourceModal
          defaultName={`页面 ${levelSets ? levelSets.length + 1 : 1}`}
          onSelect={async (source, name) => {
            setShowNewPageSource(false)
            if (source === 'upload') {
              // 本地上传
              const input = document.createElement('input')
              input.type = 'file'
              input.accept = 'image/*'
              input.multiple = true
              input.onchange = async (e: any) => {
                const files = e.target.files as FileList
                let lastSetId: string | undefined
                for (const file of Array.from(files)) {
                  // 页面名称按文件名自动获取（忽略弹窗输入名）
                  lastSetId = await handleUploadFile(file)
                }
                if (lastSetId) navigate(`/product/${projectId}/set/${lastSetId}`)
              }
              input.click()
            } else if (source === 'screenshot') {
              // 调用截图功能
              try {
                const result = await (window.electronAPI as any).captureRegion()
                if (result?.ok && result.dataUrl) {
                  const setId = await handleScreenshotResult(result.dataUrl, name)
                  if (setId) navigate(`/product/${projectId}/set/${setId}`)
                } else if (result && !result.ok && result.reason === 'permission') {
                  // macOS 录屏权限未授权：弹出 TRAE CN 风格权限引导
                  showScreenPermissionGuide()
                } else if (result && !result.ok && result.reason === 'error') {
                  alert(t('captureScreenError', '截图失败，请确保已授予屏幕录制权限'))
                  setShowNewPageSource(false)
                }
                // cancelled 或 busy：静默关闭弹窗
                setShowNewPageSource(false)
              } catch (e) {
                console.error('[ProductProjectDetail] 截图失败:', e)
                setShowNewPageSource(false)
              }
            } else if (source === 'url') {
              // URL 采集已在弹窗内直接打开浏览器，不会到达这里
              setShowNewPageSource(false)
            }
          }}
          onCancel={() => setShowNewPageSource(false)}
        />
      )}

      {/* 文件夹弹窗 */}
      {folderModal && (
        <ProductFolderModal
          projectId={projectId!}
          parentId={folderModal.mode === 'create' ? activeFolderId || undefined : undefined}
          folder={folderModal.mode === 'edit' ? folderModal.folder : undefined}
          onDone={() => setFolderModal(null)}
          onCancel={() => setFolderModal(null)}
        />
      )}
    </div>
  )
}
