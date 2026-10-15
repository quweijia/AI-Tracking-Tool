import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import type { MouseEvent } from 'react'
import { db, deletePagesCascade, PLATFORM_LABELS, Version, WalkthroughPage } from '../db'
import { PlatformIcon } from './PlatformBadge'

/** 标题编辑 icon（线性风格，随文字颜色继承） */
function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </svg>
  )
}

/** 页面卡片顶部的设计稿缩略图 */
function PageThumb({ path }: { path?: string }) {
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
    return <div className="page-thumb page-thumb-empty">暂无设计稿</div>
  }
  return <img className="page-thumb" src={url} alt="" draggable={false} loading="lazy" />
}

/** 删除单个页面（级联删除其标注与图片文件） */
async function removePage(pg: WalkthroughPage): Promise<void> {
  const ok = window.confirm(`确定删除页面「${pg.pageName}」吗？\n其下所有标注与图片文件将一并删除，删除后不可恢复。`)
  if (!ok) return
  await deletePagesCascade([pg.id])
}

export function VersionSection({ version, projectId }: { version: Version; projectId: string }) {
  const pages = useLiveQuery(
    () => db.pages.where('versionId').equals(version.id).toArray(),
    [version.id]
  )
  const [batchMode, setBatchMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // 菜单标题重命名
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(version.name)
  const renameRef = useRef<HTMLInputElement>(null)

  const startRename = () => {
    setRenameValue(version.name)
    setRenaming(true)
  }

  const commitRename = async () => {
    setRenaming(false)
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== version.name) {
      await db.versions.update(version.id, { name: trimmed })
    }
  }

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
    const ok = window.confirm(
      `确定删除选中的 ${selected.size} 个页面吗？\n其下所有标注与图片文件将一并删除，删除后不可恢复。`
    )
    if (!ok) return
    await deletePagesCascade([...selected])
    setSelected(new Set())
    setBatchMode(false)
  }

  const handleDeleteVersion = async () => {
    const ok = window.confirm(
      `确定删除菜单「${version.name}」吗？\n该菜单下所有页面、标注与图片文件将一并删除，删除后不可恢复。`
    )
    if (!ok) return
    await deletePagesCascade((pages ?? []).map((p) => p.id))
    await db.versions.delete(version.id)
  }

  const allSelected = pages !== undefined && pages.length > 0 && selected.size === pages.length

  return (
    <div className="version-section card">
      <div className="version-head">
        {renaming ? (
          <input
            ref={renameRef}
            className="input version-rename-input"
            value={renameValue}
            autoFocus
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <div className="version-title-row">
            <h2>{version.name}</h2>
            <button type="button" className="title-edit-btn" title="重命名菜单" onClick={startRename}>
              <PencilIcon />
            </button>
          </div>
        )}
        <div className={`version-head-actions${batchMode ? ' visible' : ''}`}>
          <button
            className="btn-text"
            onClick={() => {
              setBatchMode(!batchMode)
              setSelected(new Set())
            }}
            disabled={!pages?.length}
          >
            {batchMode ? '退出批量管理' : '批量管理'}
          </button>
          <button className="btn-text danger" onClick={handleDeleteVersion} title="删除该版本">
            删除菜单
          </button>
        </div>
      </div>

      <div className="page-grid">
        {pages?.map((pg) => (
          <Link
            key={pg.id}
            to={`/project/${projectId}/page/${pg.id}`}
            className={`page-card${batchMode && selected.has(pg.id) ? ' selected' : ''}`}
            onClick={(e) => handleCardClick(e, pg)}
          >
            {batchMode && (
              <span className={`page-check${selected.has(pg.id) ? ' checked' : ''}`}>
                {selected.has(pg.id) ? '✓' : ''}
              </span>
            )}
            <PageThumb path={pg.designImagePath} />
            <span className="page-name">{pg.pageName}</span>
            <span className="page-type">
              <PlatformIcon platform={pg.platform} size={12} />
              {PLATFORM_LABELS[pg.platform]}
            </span>
            {!batchMode && (
              <button
                className="page-del"
                title="删除该页面"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  removePage(pg)
                }}
              >
                ×
              </button>
            )}
          </Link>
        ))}
        {pages !== undefined && (
          <Link
            to={`/project/${projectId}/new?versionId=${version.id}`}
            className="page-card add-page"
          >
            {pages.length === 0 ? '+ 添加走查页面' : '+ 继续添加'}
          </Link>
        )}
      </div>

      {batchMode && (
        <div className="batch-bar">
          <label className="inline-label">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) =>
                setSelected(e.target.checked ? new Set((pages ?? []).map((p) => p.id)) : new Set())
              }
            />
            全选
          </label>
          <span className="batch-count">已选 {selected.size} 个页面</span>
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={() => setBatchMode(false)}>
            取消
          </button>
          <button className="btn-danger" onClick={handleBatchDelete} disabled={!selected.size}>
            删除所选
          </button>
        </div>
      )}
    </div>
  )
}
