import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { db, bySort, softDeleteFolders, Folder } from '../db'
import { timeAgo } from './ProjectCard'
import { FolderIconGlyph } from './FolderIcon'
import { confirmDialog } from './ConfirmDialog'
import { showToast } from './Toast'
import FolderModal from './FolderModal'

/** 标题编辑 icon（线性风格，随文字颜色继承） */
function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

/** 空缩略图槽位的小文件夹 icon（浅灰，占位提示） */
function SlotFolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6a2 2 0 0 1 1.5.68L12.1 6.3H18.5A2.5 2.5 0 0 1 21 8.8v8.7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Z" />
    </svg>
  )
}

/** 页面缩略图（与页面卡共用读取逻辑） */
function SlotThumb({ path }: { path?: string }) {
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
  if (!path || !url) return null
  return <img src={url} alt="" draggable={false} loading="lazy" />
}

interface Props {
  folder: Folder
  /** 点击卡片打开（项目详情页切换到该文件夹视图） */
  onOpen: () => void
  /** 批量管理模式：点击卡片切换选中，不打开 */
  batchMode?: boolean
  /** 批量模式选中态 */
  selected?: boolean
  /** 批量模式切换选中 */
  onToggleSelect?: () => void
  /** 拖拽事件（拖动排序 / 拖入文件夹，由 PageGrid 注入） */
  dndHandlers?: React.HTMLAttributes<HTMLDivElement>
  /** 拖拽中高亮 */
  dndDragging?: boolean
  /** 放置指示：before/after 边缘换位，in 拖入成为子文件夹 */
  dndDrop?: 'before' | 'after' | 'in' | null
}

/**
 * 分组文件夹卡片（参考 Figma 项目管理）：
 * 白底圆角卡片内 3 格缩略图槽拼贴前 3 张页面缩略图，空槽显示浅灰占位 + 小文件夹 icon；
 * 底部为文件夹 icon + 名称 + 「更新于 xx」。批量模式下可勾选参与批量删除。
 */
export default function FolderCard({
  folder,
  onOpen,
  batchMode = false,
  selected = false,
  onToggleSelect,
  dndHandlers,
  dndDragging = false,
  dndDrop = null
}: Props) {
  const { t } = useTranslation('folderCard')
  // 封面取文件夹内前 3 个页面缩略图（与侧边栏排序一致）；latest 取内容最近更新时间
  const info = useLiveQuery(
    async () => {
      const pages = (await db.pages.where('folderId').equals(folder.id).toArray())
        .filter((p) => !p.deletedAt)
        .sort(bySort)
      const latest = pages.reduce((m, p) => Math.max(m, p.updatedAt ?? p.createdAt), folder.createdAt)
      return { sample: pages.slice(0, 3), count: pages.length, latest }
    },
    [folder.id]
  )

  // 编辑走弹窗（重命名 + 换 icon + 主题色，编辑弹窗内亦可删除）；弹窗用 portal 挂到 body，
  // 避免卡片 hover 的 transform 让 fixed 遮罩相对卡片定位
  const [editing, setEditing] = useState(false)

  const openEdit = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setEditing(true)
  }

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const ok = await confirmDialog({ message: t('deleteConfirm', { name: folder.name }), tone: 'danger' })
    if (!ok) return
    await softDeleteFolders([folder.id])
    showToast(t('common:movedToTrash'), { tone: 'info' })
  }
  // 3 格缩略图槽：不足 3 张的剩余槽位显示占位
  const slots = [0, 1, 2]

  const handleCardClick = () => {
    // 编辑弹窗打开期间卡片点击一律忽略（含 portal 事件冒泡与键盘回车）
    if (editing) return
    if (batchMode) {
      onToggleSelect?.()
      return
    }
    onOpen()
  }

  return (
    <div
      className={`folder-card${batchMode && selected ? ' selected' : ''}${dndDragging ? ' dragging' : ''}${
        dndDrop ? ` drop-${dndDrop}` : ''
      }`}
      onClick={handleCardClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && handleCardClick()}
      {...dndHandlers}
    >
      {batchMode && (
        <span className={`page-check${selected ? ' checked' : ''}`}>{selected ? '✓' : ''}</span>
      )}
      <div className="folder-slots">
        {slots.map((i) => {
          const pg = info?.sample[i]
          if (!pg) {
            return (
              <div key={i} className="folder-slot empty">
                <SlotFolderIcon />
              </div>
            )
          }
          return (
            <div key={pg.id} className="folder-slot">
              <SlotThumb path={pg.designImagePath} />
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
          <button type="button" className="folder-act-btn" title={t('editTitle')} onClick={openEdit}>
            <PencilIcon />
          </button>
          <button type="button" className="folder-act-btn danger" title={t('deleteTitle')} onClick={handleDelete}>
            <TrashIcon />
          </button>
        </div>
      )}
      {editing &&
        createPortal(
          // portal 挂到 body 后 React 合成事件仍按组件树冒泡到卡片 onClick（点弹窗任意位置都会
          // 误触「打开文件夹」），这里拦下冒泡；点击遮罩关闭仍由 FolderModal 自身处理
          <div onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
            <FolderModal
              projectId={folder.projectId}
              parentId={folder.parentId}
              folder={folder}
              onDone={() => setEditing(false)}
              onCancel={() => setEditing(false)}
            />
          </div>,
          document.body
        )}
    </div>
  )
}
