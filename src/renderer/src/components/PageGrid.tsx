import { useEffect, useState, type DragEvent, type HTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import type { MouseEvent } from 'react'
import { db, softDeleteFolders, softDeletePages, captureBatchDeleteUndo, Folder, WalkthroughPage } from '../db'
import { pushDeleteUndo, pushUndo } from '../dndUndo'
import { tr } from '../i18n'
import { showToast } from './Toast'
import { PlatformIcon } from './PlatformBadge'
import FolderCard from './FolderCard'
import EditPageModal from './EditPageModal'
import { timeAgo } from './ProjectCard'
import { confirmDialog } from './ConfirmDialog'

/** 1×1 透明图：网格拖拽时用 setDragImage 隐藏浏览器默认的链接拖影气泡（与侧边栏同款方案） */
const TRANSPARENT_DRAG_IMG = (() => {
  const img = new Image(1, 1)
  img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  return img
})()

/** 页面卡片顶部的设计稿缩略图 */
export function PageThumb({ path }: { path?: string }) {
  const { t } = useTranslation('pageGrid')
  const [url, setUrl] = useState('')

  useEffect(() => {
    if (!path) return
    let alive = true
    window.electronAPI
      .readImage(path)
      .then((d) => {
        if (alive) setUrl(d ?? '')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [path])

  if (!path || !url) {
    return <div className="page-thumb page-thumb-empty">{t('thumbEmpty')}</div>
  }
  return <img className="page-thumb" src={url} alt="" draggable={false} loading="lazy" />
}

/** 删除单个页面（软删除进回收站，标注与图片文件保留，可在回收站还原） */
async function removePage(pg: WalkthroughPage): Promise<void> {
  const ok = await confirmDialog({ message: tr('deletePageConfirm', 'pageGrid', { name: pg.pageName }), tone: 'danger' })
  if (!ok) return
  await softDeletePages([pg.id])
  showToast(tr('movedToTrash', 'common'), { tone: 'info' })
}

/** 分节折叠头：标题 + 延伸横线 + 线尽头折叠箭头（风格对齐侧边栏分节标签） */
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

interface Props {
  projectId: string
  /** 当前网格内的页面（项目根级未分组页面，或某文件夹内页面） */
  pages: WalkthroughPage[]
  /** 当前层级的子文件夹（独立成行展示在页面区上方；批量模式下可勾选） */
  folders?: Folder[]
  /** 点击文件夹卡片打开（项目详情页切换到该文件夹视图） */
  onOpenFolder?: (folder: Folder) => void
  /** 文件夹末尾「新建文件夹」快捷操作（项目详情页打开新建弹窗） */
  onCreateFolder?: () => void
  /** 「添加页面」入口链接（携带 folderId 或为空） */
  addLink: string
  /** 批量管理模式（状态由外部横幅按钮控制） */
  batchMode?: boolean
  /** 切换批量管理模式（横幅按钮 / 批量条退出共用） */
  onToggleBatch?: () => void
  /** 网格内拖拽状态上抛：外部（项目详情面包屑）据此启用「拖到路径层释放即移动」 */
  onDragChange?: (d: { kind: 'page' | 'folder'; id: string } | null) => void
}

/**
 * 页面网格：文件夹区（上）+ 页面卡片行（下）+ 批量管理条 + 添加入口。
 * 文件夹卡片独立成行展示，不与页面卡平铺混排；批量模式下文件夹与页面均可勾选、
 * 级联删除，批量条 fixed 悬停窗口底部（不随内容滚动），出现时「回到顶部」按钮自动上移。
 * 「批量管理」入口按钮由外部（项目详情横幅）提供。
 */
export default function PageGrid({
  projectId,
  pages,
  folders = [],
  onOpenFolder,
  onCreateFolder,
  addLink,
  batchMode = false,
  onToggleBatch,
  onDragChange
}: Props) {
  const { t } = useTranslation('pageGrid')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // 文件夹区 / 页面区分节折叠（默认展开）
  const [foldersOpen, setFoldersOpen] = useState(true)
  const [pagesOpen, setPagesOpen] = useState(true)
  // 页面卡片编辑：点卡片上的编辑 icon 打开弹窗（名称 / 端类型 / Figma 链接 / 开发 URL）
  const [editingPage, setEditingPage] = useState<WalkthroughPage | null>(null)

  // 批量条出现/消失时同步 body 类（「回到顶部」悬浮按钮据此外移到批量条上方）
  useEffect(() => {
    document.body.classList.toggle('batch-bar-active', batchMode)
    return () => document.body.classList.remove('batch-bar-active')
  }, [batchMode])

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCardClick = (e: MouseEvent, pg: WalkthroughPage) => {
    if (!batchMode) return
    // 批量模式下点击卡片切换选中，不跳转
    e.preventDefault()
    toggleSelect(pg.id)
  }

  const handleBatchDelete = async () => {
    if (!selected.size) return
    const selFolders = folders.filter((f) => selected.has(f.id))
    const selPageIds = pages.filter((p) => selected.has(p.id)).map((p) => p.id)
    const parts = [
      selFolders.length ? t('batchFolderPart', { n: selFolders.length }) : '',
      selPageIds.length ? t('batchPagePart', { n: selPageIds.length }) : ''
    ].filter(Boolean)
    const ok = await confirmDialog({ message: t('batchDeleteConfirm', { n: selected.size, parts: parts.join(t('listSep')) }), tone: 'danger' })
    if (!ok) return
    // 删除前快照（Cmd+Z 撤回）：记录完整数据与图片路径，软删除落库成功后压撤销栈
    const undoData = await captureBatchDeleteUndo(
      selFolders.map((f) => f.id),
      selPageIds
    )
    // 软删除（回收站）：同一批共用时间戳，记录与标注、图片文件全部保留
    const ts = Date.now()
    await softDeleteFolders(
      selFolders.map((f) => f.id),
      ts
    )
    await softDeletePages(selPageIds, ts)
    pushDeleteUndo('walk', undoData)
    showToast(
      t('batchDeleted', {
        n: selected.size,
        keys: navigator.platform.toLowerCase().includes('mac') ? '⌘Z' : 'Ctrl+Z'
      })
    )
    setSelected(new Set())
    onToggleBatch?.()
  }

  const totalCount = folders.length + pages.length
  const allSelected = totalCount > 0 && selected.size === totalCount

  // ===== 拖拽排序 / 拖入文件夹（批量模式下禁用） =====
  type GridDrag = { kind: 'page' | 'folder'; id: string }
  type DropPos = 'before' | 'after' | 'in'
  const [drag, setDrag] = useState<GridDrag | null>(null)
  const [dropHint, setDropHint] = useState<{ kind: GridDrag['kind']; id: string; pos: DropPos } | null>(null)
  // 全量文件夹用于嵌套防环（拖入自己或子孙文件夹时拒绝）；回收站中的文件夹不参与
  const allFolders = useLiveQuery(async () => (await db.folders.toArray()).filter((f) => !f.deletedAt), []) ?? []

  // 拖拽状态上抛给外部（面包屑放置目标）；drag 变 null（含取消/释放到其它目标）时外部同步解除高亮
  useEffect(() => {
    onDragChange?.(drag)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag])

  /** id 是否为 ancestorId 的子孙文件夹（沿 parentId 上溯） */
  const folderIsDescendant = (ancestorId: string, id: string): boolean => {
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

  /** 同级列表换位：整列重排 sortNo（步长 10），与侧边栏树排序口径一致 */
  const reorderInList = async (
    which: 'folders' | 'pages',
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
    // 排序前压撤销栈（Cmd+Z 撤回；文件夹与页面均支持）
    await pushUndo('walk')
    for (let k = 0; k < ids.length; k++) {
      const changes = { sortNo: (k + 1) * 10 }
      if (which === 'folders') await db.folders.update(ids[k], changes)
      else await db.pages.update(ids[k], changes)
    }
  }

  /** 拖入文件夹：页面挂到目标文件夹末尾，文件夹挂为目标子级（已防环） */
  const moveToFolder = async (targetFolderId: string, d: GridDrag) => {
    if (d.kind === 'page') {
      const pg = pages.find((p) => p.id === d.id)
      if (!pg || pg.folderId === targetFolderId) return
      await pushUndo('walk')
      const siblings = await db.pages.where('folderId').equals(targetFolderId).toArray()
      const maxSort = siblings.reduce((m, p) => Math.max(m, p.sortNo ?? 0), 0)
      await db.pages.update(d.id, { folderId: targetFolderId, sortNo: maxSort + 10 })
    } else {
      const f = allFolders.find((x) => x.id === d.id)
      if (!f || f.parentId === targetFolderId) return
      await pushUndo('walk')
      const siblings = await db.folders.where('parentId').equals(targetFolderId).toArray()
      const maxSort = siblings.reduce((m, x) => Math.max(m, x.sortNo ?? 0), 0)
      await db.folders.update(d.id, { parentId: targetFolderId, sortNo: maxSort + 10 })
    }
  }

  /** 文件夹卡片拖拽 props：文件夹拖到文件夹时左/右缘竖条或上/下 25% 换位（同级排序）、正中块才拖入子级；页面拖到文件夹整卡为放入目标 */
  const folderDnd = (f: Folder): HTMLAttributes<HTMLDivElement> | undefined => {
    if (batchMode) return undefined
    return {
      draggable: true,
      onDragStart: (e: DragEvent<HTMLDivElement>) => {
        setDrag({ kind: 'folder', id: f.id })
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMG, 0, 0)
        e.dataTransfer.setData('text/plain', f.id)
      },
      onDragEnd: () => {
        setDrag(null)
        setDropHint(null)
      },
      onDragOver: (e: DragEvent<HTMLDivElement>) => {
        if (!drag) return
        if (drag.kind === 'folder') {
          // 防环：不能放入自己或自己的子孙
          if (drag.id === f.id || folderIsDescendant(f.id, drag.id)) return
          const rect = e.currentTarget.getBoundingClientRect()
          const r = (e.clientY - rect.top) / rect.height
          const x = (e.clientX - rect.left) / rect.width
          // 落点判定：左右缘竖条优先同级换位（before/after），否则按上下 25% 换位，正中块才拖入子级
          const pos: DropPos = x < 0.3 ? 'before' : x > 0.7 ? 'after' : r < 0.25 ? 'before' : r > 0.75 ? 'after' : 'in'
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setDropHint((prev) => (prev?.id === f.id && prev.pos === pos ? prev : { kind: 'folder', id: f.id, pos }))
        } else {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setDropHint((prev) => (prev?.id === f.id && prev.pos === 'in' ? prev : { kind: 'folder', id: f.id, pos: 'in' }))
        }
      },
      onDragLeave: (e: DragEvent<HTMLDivElement>) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        setDropHint((prev) => (prev?.id === f.id ? null : prev))
      },
      onDrop: (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault()
        const hint = dropHint
        const d = drag
        setDrag(null)
        setDropHint(null)
        if (!hint || hint.id !== f.id || !d) return
        if (hint.pos === 'in') {
          void moveToFolder(f.id, d)
        } else if (d.kind === 'folder' && d.id !== f.id) {
          void reorderInList('folders', folders, d.id, f.id, hint.pos)
        }
      }
    }
  }

  /** 页面卡片拖拽 props：页面与页面之间按横向中点换位（同一父级内） */
  const pageDnd = (pg: WalkthroughPage): HTMLAttributes<HTMLAnchorElement> | undefined => {
    if (batchMode) return undefined
    return {
      draggable: true,
      onDragStart: (e: DragEvent<HTMLAnchorElement>) => {
        setDrag({ kind: 'page', id: pg.id })
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMG, 0, 0)
        e.dataTransfer.setData('text/plain', pg.id)
      },
      onDragEnd: () => {
        setDrag(null)
        setDropHint(null)
      },
      onDragOver: (e: DragEvent<HTMLAnchorElement>) => {
        if (!drag || drag.kind !== 'page' || drag.id === pg.id) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const rect = e.currentTarget.getBoundingClientRect()
        const pos: 'before' | 'after' = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
        setDropHint((prev) => (prev?.id === pg.id && prev.pos === pos ? prev : { kind: 'page', id: pg.id, pos }))
      },
      onDragLeave: (e: DragEvent<HTMLAnchorElement>) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        setDropHint((prev) => (prev?.id === pg.id ? null : prev))
      },
      onDrop: (e: DragEvent<HTMLAnchorElement>) => {
        e.preventDefault()
        const hint = dropHint
        const d = drag
        setDrag(null)
        setDropHint(null)
        if (!hint || hint.id !== pg.id || !d || d.kind !== 'page' || d.id === pg.id) return
        if (hint.pos === 'before' || hint.pos === 'after') void reorderInList('pages', pages, d.id, pg.id, hint.pos)
      }
    }
  }

  /** 页面卡片拖拽态样式类 */
  const pageDndCls = (id: string) => {
    let cls = ''
    if (drag?.kind === 'page' && drag.id === id) cls += ' dragging'
    if (dropHint?.kind === 'page' && dropHint.id === id) cls += ` drop-${dropHint.pos}`
    return cls
  }

  return (
    <div className="page-grid-section">
      {/* 文件夹区：分节头（标题 + 横线 + 折叠箭头）+ 文件夹卡片行；批量模式下可勾选，支持拖动排序与拖入文件夹；空层且允许新建时也显示「新建文件夹」入口 */}
      {(folders.length > 0 || (!batchMode && onCreateFolder)) && (
        <>
          <SectionHead title={t('foldersSection')} open={foldersOpen} onToggle={() => setFoldersOpen((v) => !v)} />
          {foldersOpen && (
            <div className="page-grid folder-grid">
              {folders.map((f) => (
                <FolderCard
                  key={f.id}
                  folder={f}
                  batchMode={batchMode}
                  selected={selected.has(f.id)}
                  onOpen={() => onOpenFolder?.(f)}
                  onToggleSelect={() => toggleSelect(f.id)}
                  dndHandlers={folderDnd(f)}
                  dndDragging={drag?.kind === 'folder' && drag.id === f.id}
                  dndDrop={dropHint?.kind === 'folder' && dropHint.id === f.id ? dropHint.pos : null}
                />
              ))}
              {/* 文件夹末尾快捷操作：新建文件夹（虚线卡，与页面区「新建页面+」同款样式） */}
              {!batchMode && onCreateFolder && (
                <button type="button" className="folder-card add-folder" onClick={onCreateFolder}>
                  <span className="grid-add-label">{t('addFolder')}</span>
                </button>
              )}
            </div>
          )}
        </>
      )}
      <SectionHead title={t('pagesSection')} open={pagesOpen} onToggle={() => setPagesOpen((v) => !v)} />
      {pagesOpen && (
        <div className="page-grid">
        {pages.map((pg) => (
          <Link
            key={pg.id}
            to={`/project/${projectId}/page/${pg.id}`}
            className={`page-card${batchMode && selected.has(pg.id) ? ' selected' : ''}${pageDndCls(pg.id)}`}
            onClick={(e) => {
              // 编辑弹窗打开时禁止卡片跳转
              if (editingPage) {
                e.preventDefault()
                return
              }
              handleCardClick(e, pg)
            }}
            {...pageDnd(pg)}
          >
            {batchMode && (
              <span className={`page-check${selected.has(pg.id) ? ' checked' : ''}`}>
                {selected.has(pg.id) ? '✓' : ''}
              </span>
            )}
            <PageThumb path={pg.designImagePath} />
            <span className="page-name-row">
              <span className="page-glyph">
                <PlatformIcon platform={pg.platform} size={13} />
              </span>
              <span className="page-name" title={pg.pageName}>
                {pg.pageName}
              </span>
            </span>
            <span className="page-time">{t('editedAt', { time: timeAgo(pg.updatedAt ?? pg.createdAt) })}</span>
            {!batchMode && (
              <div className="folder-actions">
                <button type="button" className="folder-act-btn" title={t('renamePageTitle')} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditingPage(pg); }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
                  </svg>
                </button>
                <button type="button" className="folder-act-btn danger" title={t('deletePageTitle')} onClick={(e) => { e.preventDefault(); e.stopPropagation(); removePage(pg); }}>
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
        ))}
        {!batchMode && (
          <Link to={addLink} className="page-card add-page" draggable={false}>
            <span className="grid-add-label">{t('addMore')}</span>
          </Link>
        )}
        </div>
      )}

      {batchMode && (
        <div className="batch-bar">
          <label className="inline-label">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) =>
                setSelected(e.target.checked ? new Set([...folders.map((f) => f.id), ...pages.map((p) => p.id)]) : new Set())
              }
            />
            {t('selectAll')}
          </label>
          <span className="batch-count">{t('selectedCount', { n: selected.size })}</span>
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onToggleBatch}>
            {t('exitBatch')}
          </button>
          <button className="btn-danger" onClick={handleBatchDelete} disabled={!selected.size}>
            {t('deleteSelected')}
          </button>
        </div>
      )}

      {editingPage &&
        createPortal(
          // portal 挂到 body：卡片 hover 的 transform 会让 fixed 遮罩相对卡片定位；
          // React 事件仍按组件树冒泡，外层拦下避免误触卡片跳转
          <div onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
            <EditPageModal
              page={editingPage}
              onSave={(fields) => {
                void db.pages.update(editingPage.id, { ...fields, updatedAt: Date.now() })
                setEditingPage(null)
              }}
              onCancel={() => setEditingPage(null)}
            />
          </div>,
          document.body
        )}
    </div>
  )
}
