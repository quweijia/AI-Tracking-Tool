import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { db, bySort, deleteFolderCascade, Folder } from '../db'
import { timeAgo } from './ProjectCard'
import { FolderIconGlyph } from './FolderIcon'

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
      const pages = (await db.pages.where('folderId').equals(folder.id).toArray()).sort(bySort)
      const latest = pages.reduce((m, p) => Math.max(m, p.updatedAt ?? p.createdAt), folder.createdAt)
      return { sample: pages.slice(0, 3), count: pages.length, latest }
    },
    [folder.id]
  )

  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(folder.name)
  const renameRef = useRef<HTMLInputElement>(null)

  // 非编辑态时输入框跟随文件夹名
  useEffect(() => {
    if (!renaming) setRenameValue(folder.name)
  }, [folder.name, renaming])

  const startRename = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setRenaming(true)
    setTimeout(() => renameRef.current?.select(), 0)
  }

  const commitRename = async () => {
    setRenaming(false)
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== folder.name) {
      await db.folders.update(folder.id, { name: trimmed })
    }
  }

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const ok = window.confirm(t('deleteConfirm', { name: folder.name }))
    if (!ok) return
    await deleteFolderCascade(folder.id)
  }
  // 3 格缩略图槽：不足 3 张的剩余槽位显示占位
  const slots = [0, 1, 2]

  const handleCardClick = () => {
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
      onClick={renaming ? undefined : handleCardClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && !renaming && handleCardClick()}
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
      {renaming ? (
        <input
          ref={renameRef}
          className="input folder-rename-input"
          value={renameValue}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitRename()
            if (e.key === 'Escape') setRenaming(false)
          }}
        />
      ) : (
        <div className="folder-meta">
          <span className="folder-name-row">
            <span className="folder-glyph" style={folder.color ? { color: folder.color } : undefined}>
              <FolderIconGlyph icon={folder.icon} size={14} />
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
      )}
      {!renaming && !batchMode && (
        <div className="folder-actions">
          <button type="button" className="folder-act-btn" title={t('renameTitle')} onClick={startRename}>
            <PencilIcon />
          </button>
          <button type="button" className="folder-act-btn danger" title={t('deleteTitle')} onClick={handleDelete}>
            <TrashIcon />
          </button>
        </div>
      )}
    </div>
  )
}
