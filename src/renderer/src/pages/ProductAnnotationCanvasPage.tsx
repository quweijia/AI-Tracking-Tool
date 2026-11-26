import { useLiveQuery } from 'dexie-react-hooks'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useEffect, useMemo, useRef, useState, type MouseEvent, type DragEvent, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { productDb, ProductAnnotation, ProductPage, genId, bySort, PRODUCT_THUMB_MAX, recordProductVisit } from '../db/product'
import { CATEGORY_UNSET, Category, IssueAttachment, Severity } from '../db'
import AnnotationCanvas, { NormalizedRect } from '../components/AnnotationCanvas'
import IssueDrawer from '../components/IssueDrawer'
import IssueEditorModal from '../components/IssueEditorModal'
import DevBrowser, { type DevBrowserHandle } from '../components/DevBrowser'
import { confirmDialog } from '../components/ConfirmDialog'
import { showScreenPermissionGuide } from '../components/ScreenPermissionGuide'
import { showToast } from '../components/Toast'
import type { Issue, IssueStatus, TargetImage, AnnotationShape } from '../db'
import { ToolIcon, ExportIcon } from './CompareWorkbench'

/** ───────────── 类型定义 ───────────── */
type ProductToolValue = AnnotationShape | 'hand'

/** 画布缩放范围 */
const ZOOM_MIN = 0.25
const ZOOM_MAX = 3

/** 标注历史操作（可逆）：add=新增 delete=删除 update=编辑/移动位置，用于撤销与重做 */
type HistoryOp =
  | { type: 'add'; annotations: ProductAnnotation[] }
  | { type: 'delete'; annotations: ProductAnnotation[] }
  | { type: 'update'; before: ProductAnnotation; after: ProductAnnotation }

/** 测量数值只保留整数：自动舍弃小数点，精确到个位，禁止出现小数（画布显示与报告/文档导出共用同一口径） */
export function toIntMeasureValue(v: string): string {
  const m = v.match(/^(\d+(?:\.\d+)?)(.*)$/)
  if (!m) return v
  return `${Math.round(Number(m[1]))}${m[2]}`
}

/** 产品标注 → Issue 视图映射（仅用于复用走查组件） */
function annotationToIssue(a: ProductAnnotation): Issue {
  return {
    id: a.id,
    pageId: a.pageId,
    targetImage: 'design' as TargetImage,
    x: a.x,
    y: a.y,
    width: a.width,
    height: a.height,
    description: a.description,
    severity: (a.severity ?? 'minor') as Severity,
    category: a.category ?? CATEGORY_UNSET,
    status: (a.status ?? 'pending') as IssueStatus,
    shape: a.type as AnnotationShape,
    color: a.color,
    measureValue: a.measureValue ? toIntMeasureValue(a.measureValue) : undefined,
    sampleA: a.sampleColor,
    attachments: a.attachments as IssueAttachment[] | undefined,
    createdAt: a.createdAt,
  }
}

/** 1×1 透明 GIF：拖拽排序时替换浏览器默认拖影 */
const TRANSPARENT_DRAG_IMG = (() => {
  const img = new Image(1, 1)
  img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  return img
})()

/** 顶部导航栏「标注清单」按钮 icon（与手动走查页清单按钮同款线性图标） */
function ListIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </svg>
  )
}

/** 缩略图占位底色 */
const THUMB_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f43f5e', '#14b8a6', '#0ea5e9', '#f97316', '#22c55e']
const thumbColorOf = (id: string) => {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return THUMB_COLORS[h % THUMB_COLORS.length]
}

/** 生成缩略图 webp dataURL（最长边 ≤ PRODUCT_THUMB_MAX） */
async function generateThumbnailFromBlob(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const maxDim = PRODUCT_THUMB_MAX
      const scale = Math.min(maxDim / img.naturalWidth, maxDim / img.naturalHeight, 1)
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth * scale
      canvas.height = img.naturalHeight * scale
      const ctx = canvas.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/webp', 0.85))
    }
    img.onerror = () => resolve('')
    img.src = URL.createObjectURL(blob)
  })
}

/** 待撤回的页面删除恢复函数：轻提示存续期间（6 秒）Cmd+Z 优先撤销页面删除而非标注操作 */
let pendingPageUndo: (() => void) | null = null

/** ───────────── 缩略导航栏组件 ───────────── */
function ThumbnailSidebar({
  pages,
  currentPageId,
  onSelect,
  collapsed,
  onToggleCollapse,
  onAddPage,
}: {
  pages: ProductPage[]
  currentPageId: string
  onSelect: (pageId: string) => void
  collapsed: boolean
  onToggleCollapse: () => void
  onAddPage: () => void
}) {
  const { t } = useTranslation('productCanvas')
  const [dragPageId, setDragPageId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ id: string; pos: 'before' | 'after' } | null>(null)
  /** 内联编辑重命名 */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  /** Blob → thumbnail ObjectURL（避免每次渲染都创建） */
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({})
  useEffect(() => {
    const cleanup: Array<() => void> = []
    pages.forEach((p) => {
      if (p.thumbDataUrl) {
        setThumbUrls((prev) => ({ ...prev, [p.id]: p.thumbDataUrl }))
        return
      }
      // 从 Blob 生成缩略图
      generateThumbnailFromBlob(p.image).then((thumb) => {
        productDb.pages.update(p.id, { thumbDataUrl: thumb, thumbMax: PRODUCT_THUMB_MAX }).catch(() => undefined)
        setThumbUrls((prev) => ({ ...prev, [p.id]: thumb }))
      })
    })
    return () => {
      cleanup.forEach((fn) => fn())
    }
  }, [pages])

  /** 拖拽排序 */
  const reorderPages = async (fromId: string, toId: string, pos: 'before' | 'after') => {
    if (fromId === toId) return
    const ids = pages.map((p) => p.id).filter((x) => x !== fromId)
    const i = ids.indexOf(toId)
    if (i < 0) return
    ids.splice(pos === 'before' ? i : i + 1, 0, fromId)
    for (let k = 0; k < ids.length; k++) {
      await productDb.pages.update(ids[k], { sortNo: (k + 1) * 10 })
    }
  }

  const pageDnd = (id: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      setDragPageId(id)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', id)
      e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMG, 0, 0)
    },
    onDragEnd: () => { setDragPageId(null); setDropHint(null) },
    onDragOver: (e: DragEvent) => {
      if (dragPageId === null || dragPageId === id) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
      setDropHint((prev) => (prev?.id === id && prev.pos === pos ? prev : { id, pos }))
    },
    onDragLeave: (e: DragEvent) => {
      if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return
      setDropHint((prev) => (prev?.id === id ? null : prev))
    },
    onDrop: (e: DragEvent) => {
      if (dragPageId === null || dragPageId === id) return
      e.preventDefault()
      const pos = dropHint?.pos ?? 'after'
      const fromId = dragPageId
      setDragPageId(null)
      setDropHint(null)
      void reorderPages(fromId, id, pos)
    },
  })

  /** 列表容器兜底拖拽：条目间 gap、顶部/底部 padding 区不在任何条目内，条目级处理器不响应，
   * 拖到第一个/最后一个时指示线会消失、松手不落位；此处按「最近条目 + 垂直中点」补算插入位置 */
  const listRef = useRef<HTMLDivElement>(null)
  const handleListDragOver = (e: DragEvent) => {
    if (dragPageId === null) return
    const list = listRef.current
    if (!list) return
    const items = Array.from(list.querySelectorAll<HTMLElement>('.thumbnail-item'))
    if (items.length === 0) return
    const over = items.find((el) => {
      const r = el.getBoundingClientRect()
      return e.clientY >= r.top && e.clientY < r.bottom
    })
    if (over) return // 条目自身区域：条目级 onDragOver 已处理
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    // 纵向距离最近的条目 + 其中点，决定插到该条目前/后
    let nearest = items[0]
    let dist = Infinity
    for (const el of items) {
      const r = el.getBoundingClientRect()
      const d = e.clientY < r.top ? r.top - e.clientY : e.clientY > r.bottom ? e.clientY - r.bottom : 0
      if (d < dist) {
        dist = d
        nearest = el
      }
    }
    const nr = nearest.getBoundingClientRect()
    const target = pages[items.indexOf(nearest)].id
    const pos: 'before' | 'after' = e.clientY < nr.top + nr.height / 2 ? 'before' : 'after'
    setDropHint((prev) => (prev?.id === target && prev.pos === pos ? prev : { id: target, pos }))
  }

  /** 列表空隙区落点：坐标不在条目内才执行（条目区域内松手由条目级 onDrop 处理，含拖回原位不动作） */
  const handleListDrop = (e: DragEvent) => {
    if (dragPageId === null || !dropHint) return
    const list = listRef.current
    if (!list) return
    const over = Array.from(list.querySelectorAll<HTMLElement>('.thumbnail-item')).some((el) => {
      const r = el.getBoundingClientRect()
      return e.clientY >= r.top && e.clientY < r.bottom
    })
    if (over) return
    e.preventDefault()
    const { id: toId, pos } = dropHint
    const fromId = dragPageId
    setDragPageId(null)
    setDropHint(null)
    void reorderPages(fromId, toId, pos)
  }

  /** 页面操作 */
  const handleRename = async (e: React.MouseEvent, pageId: string) => {
    e.stopPropagation()
    const page = pages.find((p) => p.id === pageId)
    if (!page) return
    setRenamingId(pageId)
    setRenameValue(page.name)
    setTimeout(() => {
      renameInputRef.current?.focus()
      // 光标移到末尾
      renameInputRef.current!.setSelectionRange(page.name.length, page.name.length)
    }, 0)
  }

  const commitRename = async (pageId: string) => {
    const trimmed = renameValue.trim()
    if (trimmed) {
      await productDb.pages.update(pageId, { name: trimmed })
    }
    setRenamingId(null)
    setRenameValue('')
  }

  const cancelRename = () => {
    setRenamingId(null)
    setRenameValue('')
  }

  const handleDelete = async (e: React.MouseEvent, pageId: string) => {
    e.stopPropagation()
    const page = pages.find((p) => p.id === pageId)
    if (!page) return
    const ok = await confirmDialog({
      message: t('deletePageConfirm', { name: page.name }),
      tone: 'danger',
    })
    if (!ok) return
    // 快照页面及其标注/问题后删除，轻提示内「撤销」可一键恢复
    const [pageAnnos, pageIssues] = await Promise.all([
      productDb.annotations.where('pageId').equals(pageId).toArray(),
      productDb.issues.where('pageId').equals(pageId).toArray()
    ])
    await productDb.annotations.bulkDelete(pageAnnos.map((a) => a.id))
    await productDb.issues.bulkDelete(pageIssues.map((i) => i.id))
    await productDb.pages.delete(pageId)
    // 撤回恢复：提示存续期间点「撤销」或按 Cmd+Z 均可一键恢复（同数据重复恢复为幂等 put，无副作用）
    const restorePage = () => {
      void (async () => {
        // 标注集已被删除时不恢复孤儿页面（setId 缺失视为无归属，同样不恢复）
        if (!page.setId || !(await productDb.sets.get(page.setId))) return
        await productDb.pages.put(page)
        await productDb.annotations.bulkPut(pageAnnos)
        await productDb.issues.bulkPut(pageIssues)
      })()
    }
    pendingPageUndo = restorePage
    // 撤回窗口与轻提示同生命周期，6 秒后 Cmd+Z 恢复为标注撤销
    window.setTimeout(() => {
      if (pendingPageUndo === restorePage) pendingPageUndo = null
    }, 6000)
    showToast(t('pageDeletedToast', { name: page.name }), {
      duration: 6000,
      action: { label: t('undoDelete'), onClick: restorePage },
    })
  }

  return (
    <>
      <div className={`thumbnail-sidebar ${collapsed ? 'collapsed' : ''}`}>
        {/* 头部：折叠按钮 + 添加按钮 */}
        <div className="thumbnail-sidebar-header">
          <span className="thumbnail-sidebar-title">{t('pages')}</span>
          <div className="thumbnail-sidebar-actions">
            <button
              type="button"
              className="thumbnail-sidebar-btn"
              title={collapsed ? t('expandSidebar') : t('collapseSidebar')}
              onClick={onToggleCollapse}
            >
              {collapsed ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m15 18-6-6 6-6" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {!collapsed && (
          <>
            {/* 缩略图列表（容器兜底处理条目间空隙/顶部底部 padding 区的拖拽指示与落点） */}
            <div className="thumbnail-list" ref={listRef} onDragOver={handleListDragOver} onDrop={handleListDrop}>
              {pages.map((page, idx) => {
                const isActive = page.id === currentPageId
                const dnd = pageDnd(page.id)
                return (
                  <div
                    key={page.id}
                    className={`thumbnail-item ${isActive ? 'active' : ''}${dragPageId === page.id ? 'dragging' : ''}${dropHint?.id === page.id && dropHint?.pos === 'before' ? 'drop-before' : ''}${dropHint?.id === page.id && dropHint?.pos === 'after' ? 'drop-after' : ''}`}
                    onClick={() => onSelect(page.id)}
                    {...dnd}
                  >
                    {/* 页码 */}
                    <span className="thumbnail-page-no">{idx + 1}</span>

                    {/* 缩略图固定 16:9：图片以 object-fit contain 在框内显示全景 */}
                    <div className="thumbnail-preview">
                      {thumbUrls[page.id] ? (
                        <img src={thumbUrls[page.id]} alt="" draggable={false} />
                      ) : (
                        <div
                          className="thumbnail-placeholder"
                          style={{ background: thumbColorOf(page.id) }}
                        >
                          {page.name.slice(0, 1)}
                        </div>
                      )}
                      {/* 悬浮操作按钮：编辑 + 删除 */}
                      <div className="thumbnail-actions">
                        <button
                          type="button"
                          className="thumbnail-action-btn"
                          title={t('renamePage')}
                          aria-label={t('renamePage')}
                          onClick={(e) => void handleRename(e, page.id)}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="thumbnail-action-btn danger"
                          title={t('deletePage')}
                          aria-label={t('deletePage')}
                          onClick={(e) => void handleDelete(e, page.id)}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 6h18" />
                            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                            <path d="M10 11v6M14 11v6" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {/* 页面名称 */}
                    {renamingId === page.id ? (
                      <input
                        ref={renameInputRef}
                        className="thumbnail-rename-input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(page.id)
                          if (e.key === 'Escape') cancelRename()
                        }}
                        onBlur={() => void commitRename(page.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <div className="thumbnail-name" title={page.name}>
                        {page.name}
                      </div>
                    )}
                  </div>
                )
              })}

              {/* 添加页面按钮 */}
              <div
                className="thumbnail-item add-page"
                onClick={onAddPage}
                draggable={false}
              >
                <div className="thumbnail-preview add-preview">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </div>
                <div className="thumbnail-name">{t('addPage')}</div>
              </div>
            </div>
          </>
        )}

        {/* 折叠状态下的缩略图条（只显示缩略图，无名称） */}
        {collapsed && (
          <div className="thumbnail-strip">
            {pages.map((page) => (
              <div
                key={page.id}
                className={`thumbnail-strip-item ${page.id === currentPageId ? 'active' : ''}`}
                onClick={() => onSelect(page.id)}
                title={page.name}
              >
                {thumbUrls[page.id] ? (
                  <img src={thumbUrls[page.id]} alt="" draggable={false} />
                ) : (
                  <div
                    className="thumbnail-placeholder"
                    style={{ background: thumbColorOf(page.id) }}
                  >
                    {page.name.slice(0, 1)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

/** ───────────── 添加图片来源弹窗（空状态/缺省页使用） ───────────── */
function AddImageModal({
  projectId,
  onSelect,
  onCancel
}: {
  projectId: string
  onSelect: (source: 'upload' | 'screenshot' | 'url', url?: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation('productCanvas')
  const { t: tFolder } = useTranslation('productProjectList')
  /** URL 采集：展开内嵌 URL 输入框（Electron 不支持 window.prompt） */
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

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" style={{ minWidth: 420 }}>
        <h3 style={{ margin: '0 0 12px' }}>{t('addImage')}</h3>

        <p style={{ fontSize: 13, color: 'var(--fg-2, #6b7280)', marginBottom: 12 }}>{t('selectImageSource')}</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* ① 本地上传截图 */}
          <button
            type="button"
            style={cardStyle}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--primary)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)' }}
            onClick={() => onSelect('upload')}
          >
            <span style={iconStyle}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{tFolder('uploadLocal')}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-3, #9ca3af)', marginTop: 2 }}>{tFolder('uploadLocalDesc')}</div>
            </div>
          </button>

          {/* ② 调用截图功能 */}
          <button
            type="button"
            style={cardStyle}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--primary)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)' }}
            onClick={() => onSelect('screenshot')}
          >
            <span style={iconStyle}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{tFolder('captureScreen')}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-3, #9ca3af)', marginTop: 2 }}>{tFolder('captureScreenDesc')}</div>
            </div>
          </button>

          {/* ③ 输入开发 URL：点击展开内嵌 URL 输入框 */}
          {!showUrlInput ? (
            <button
              type="button"
              style={cardStyle}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--primary)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)' }}
              onClick={() => setShowUrlInput(true)}
            >
              <span style={iconStyle}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.36 1.36" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.36-1.36" />
                </svg>
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{tFolder('urlCapture')}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-3, #9ca3af)', marginTop: 2 }}>{tFolder('urlCaptureDesc')}</div>
              </div>
            </button>
          ) : (
            <div style={{ ...cardStyle, cursor: 'default', borderColor: 'var(--primary)', background: 'var(--surface-inset)' }}>
              <span style={iconStyle}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.36 1.36" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.36-1.36" />
                </svg>
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>{tFolder('urlCapture')}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    autoFocus
                    placeholder={t('urlInputPlaceholder')}
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && urlInput.trim()) onSelect('url', urlInput.trim())
                    }}
                  />
                  <button
                    className="btn-primary"
                    disabled={!urlInput.trim()}
                    onClick={() => urlInput.trim() && onSelect('url', urlInput.trim())}
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

/** 从 URL 提取站点名称用于自动填充页面名称 */
function urlToSiteName(rawUrl: string): string {
  try {
    const url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`)
    let host = url.hostname.replace(/^www\./, '')
    const parts = host.split('.')
    if (parts.length >= 2) host = parts.slice(-2).join('.')
    host = host.replace(/-/g, ' ')
    return host.split('.').join(' ').replace(/\b\w/g, (c) => c.toUpperCase())
  } catch {
    return ''
  }
}

/** 同集内页面重名时自动加序号后缀（xx 2 / xx 3 …）：上传/截图/URL 采集每次都保存为新页 */
function uniquePageName(base: string, existing: { name: string }[]): string {
  const name = base.trim()
  if (!name) return name
  const taken = new Set(existing.map((p) => p.name))
  if (!taken.has(name)) return name
  let n = 2
  while (taken.has(`${name} ${n}`)) n++
  return `${name} ${n}`
}

/** ───────────── 画布页新增页面弹窗 ───────────── */
function CanvasAddPageModal({
  defaultName,
  existingNames,
  onSelect,
  onCancel,
}: {
  defaultName: string
  /** 已有页面名列表（trim 后精确比较），用于重名校验 */
  existingNames: string[]
  onSelect: (source: 'upload' | 'screenshot' | 'url', name: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation('productCanvas')
  const { t: tFolder } = useTranslation('productProjectList')
  /** 自动填充名去重：与已有页面重名时追加序号后缀（xx 2、xx 3…） */
  const uniqueName = (name: string) => {
    if (!existingNames.includes(name)) return name
    let n = 2
    while (existingNames.includes(`${name} ${n}`)) n += 1
    return `${name} ${n}`
  }
  const [pageName, setPageName] = useState(() => uniqueName(defaultName))
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

  const trimmedName = pageName.trim()
  const isDup = trimmedName.length > 0 && existingNames.includes(trimmedName)
  const canSubmit = trimmedName.length > 0 && !isDup

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
          title={t('cancel')}
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
        {isDup && (
          <p style={{ fontSize: 12, color: 'var(--danger)', margin: '6px 0 0' }}>{t('pageNameDuplicate')}</p>
        )}

        <p style={{ fontSize: 13, color: 'var(--fg-2, #6b7280)', marginBottom: 12, marginTop: 16 }}>{t('selectPageSource')}</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* ① 本地上传截图 */}
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
              <div style={{ fontWeight: 600 }}>{tFolder('uploadLocal')}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-3, #9ca3af)', marginTop: 2 }}>{tFolder('uploadLocalDesc')}</div>
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
              </svg>
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{tFolder('captureScreen')}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-3, #9ca3af)', marginTop: 2 }}>{tFolder('captureScreenDesc')}</div>
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
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.36 1.36" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.36-1.36" />
                </svg>
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{tFolder('urlCapture')}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-3, #9ca3af)', marginTop: 2 }}>{tFolder('urlCaptureDesc')}</div>
              </div>
            </button>
          ) : (
            <div style={{ ...cardStyle, cursor: 'default', borderColor: 'var(--primary)', background: 'var(--surface-inset)' }}>
              <span style={iconStyle}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.36 1.36" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.36-1.36" />
                </svg>
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>{tFolder('urlCapture')}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    autoFocus
                    placeholder={t('urlInputPlaceholder')}
                    value={urlInput}
                    onChange={(e) => {
                      const val = e.target.value
                      setUrlInput(val)
                      if (val.trim()) {
                        const siteName = urlToSiteName(val)
                        if (siteName) setPageName(uniqueName(siteName))
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && urlInput.trim() && canSubmit) {
                        const normalized = /^https?:\/\//i.test(urlInput) ? urlInput.trim() : `http://${urlInput.trim()}`
                        window.electronAPI.openBrowserWindow(normalized, { captureMode: true, capturePurpose: 'newPage' })
                        onCancel()
                      }
                    }}
                  />
                  <button
                    className="btn-primary"
                    disabled={!urlInput.trim() || !canSubmit}
                    onClick={() => {
                      if (urlInput.trim() && canSubmit) {
                        const normalized = /^https?:\/\//i.test(urlInput) ? urlInput.trim() : `http://${urlInput.trim()}`
                        window.electronAPI.openBrowserWindow(normalized, { captureMode: true, capturePurpose: 'newPage' })
                        onCancel()
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

/** ───────────── 空状态引导（应用默认缺省图） ───────────── */
function EmptyState({ onAddImage }: { onAddImage: () => void }) {
  const { t } = useTranslation('productCanvas')
  return (
    <div className="empty-state">
      <p>{t('emptyStateUpload')}</p>
      <button className="btn-primary" onClick={onAddImage}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        {t('addImage')}
      </button>
    </div>
  )
}

/** ───────────── 产品标注画布页 ───────────── */
export default function ProductAnnotationCanvasPage() {
  const { t } = useTranslation('productCanvas')
  const { projectId, setId } = useParams<{ projectId: string; setId: string }>()
  const navigate = useNavigate()

  /** 当前标注集 = 项目网格中的「页面」卡片（对等 UI 走查页面），集内多页面以左侧缩略图导航 */
  const annotationSet = useLiveQuery(() => productDb.sets.get(setId!), [setId])

  const project = useLiveQuery(() => productDb.projects.get(projectId!), [projectId])

  /** 集内页面（按 sortNo 排序）——左侧缩略图导航与管理 */
  const setPages = useLiveQuery(
    async () => (await productDb.pages.where('setId').equals(setId!).toArray()).sort(bySort),
    [setId]
  )

  /** 无项目/无标注集时跳转回项目详情 */
  useEffect(() => {
    if (project === null && projectId) navigate('/product')
    if (annotationSet === null && setId) navigate(`/product/${projectId}`)
  }, [project, annotationSet, projectId, setId, navigate])

  /** 记录一次标注集访问（30 分钟去重），供「最近访问」页统计 */
  useEffect(() => {
    if (setId && projectId) recordProductVisit(setId, projectId)
  }, [setId, projectId])

  /** 当前选中页面（本地状态，默认集内第一页；路由只定位到标注集） */
  const [currentPageId, setCurrentPageId] = useState<string | null>(null)
  useEffect(() => {
    if (setPages && setPages.length > 0) {
      if (!currentPageId || !setPages.some((p) => p.id === currentPageId)) {
        setCurrentPageId(setPages[0].id)
      }
    }
  }, [setPages, currentPageId])

  /** 当前页面 */
  const page = useLiveQuery(() => productDb.pages.get(currentPageId ?? ''), [currentPageId])

  /** 图片 Object URL */
  const [imageDataUrl, setImageDataUrl] = useState<string>('')
  const imageBlobUrl = useRef<string | null>(null)
  /** 已创建过 objectURL 的页面 id：liveQuery 重查会返回新 Blob 克隆实例，按页面 id 守卫避免反复重建 URL 导致闪屏 */
  const loadedPageIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!page?.id || !page?.image) return
    // 同一页面重复触发（其他字段更新引起 liveQuery 重发）不重建 objectURL
    if (loadedPageIdRef.current === page.id && imageBlobUrl.current) return
    if (imageBlobUrl.current) URL.revokeObjectURL(imageBlobUrl.current)
    imageBlobUrl.current = URL.createObjectURL(page.image)
    loadedPageIdRef.current = page.id
    setImageDataUrl(imageBlobUrl.current)
  }, [page?.id, page?.image])

  /** 卸载时统一释放 objectURL（重置守卫，兼容 StrictMode 双挂载） */
  useEffect(() => {
    return () => {
      if (imageBlobUrl.current) {
        URL.revokeObjectURL(imageBlobUrl.current)
        imageBlobUrl.current = null
      }
      loadedPageIdRef.current = null
    }
  }, [])

  /** 替换当前页图片（重传/截图/URL 采集路径）：直接展示新 Blob 并同步守卫状态 */
  const showBlobImage = (blob: Blob, pageId: string) => {
    const url = URL.createObjectURL(blob)
    if (imageBlobUrl.current) URL.revokeObjectURL(imageBlobUrl.current)
    imageBlobUrl.current = url
    loadedPageIdRef.current = pageId
    setImageDataUrl(url)
  }

  /** 该页面的标注 */
  const annotations = useLiveQuery(
    () => productDb.annotations.where('pageId').equals(currentPageId ?? '').sortBy('createdAt'),
    [currentPageId]
  )

  const issues: Issue[] = useMemo(() => {
    if (!annotations) return []
    return annotations.map(annotationToIssue)
  }, [annotations])

  const issueNos = useMemo(() => {
    const map = new Map<string, number>()
    issues.forEach((issue, idx) => map.set(issue.id, idx + 1))
    return map
  }, [issues])

  /** 工具 / 画布状态 */
  const [tool, setTool] = useState<ProductToolValue>('hand')
  const [zoom, setZoom] = useState(1)
  /** 步进式缩放（与自动走查画板一致的 −/＋ 0.25 步进，带范围钳制） */
  const setZoomStep = (v: number) => setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v * 20) / 20)))
  const [spacePan, setSpacePan] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [flashId, setFlashId] = useState<string | null>(null)
  const flashTimer = useRef<number | null>(null)
  /** 聚焦查看的问题：画布放大 2x 并滚动居中到该点位，其余标注隐藏（再点一次取消，对齐走查画板交互） */
  const [focusIssue, setFocusIssue] = useState<Issue | null>(null)
  const [editingIssue, setEditingIssue] = useState<Issue | null>(null)
  /** 画布滚动容器（平移/缩放作用对象：底层画布图片） */
  const canvasScrollRef = useRef<HTMLDivElement | null>(null)

  /** 缩略导航栏折叠状态 */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  /** 空状态页：添加图片来源弹窗 */
  const [showAddImage, setShowAddImage] = useState(false)
  const handleAddImageSelect = async (source: 'upload' | 'screenshot' | 'url', url?: string) => {
    setShowAddImage(false)
    if (source === 'upload') {
      fileInputRef.current?.click()
    } else if (source === 'screenshot') {
      window.electronAPI.captureRegion().then(async (res) => {
        if (!res.ok) {
          // macOS 录屏权限未授权：弹出 TRAE CN 风格权限引导
          if (res.reason === 'permission') showScreenPermissionGuide()
          return
        }
        const dataUrl = res.dataUrl
        try {
          const blob = await (await fetch(dataUrl)).blob()
          const thumb = await generateThumbnailFromBlob(blob)
          if (currentPageId) {
            // 有当前页：替换当前页图片
            showBlobImage(blob, currentPageId)
            await productDb.pages.update(currentPageId, { image: blob, thumbDataUrl: thumb, thumbMax: PRODUCT_THUMB_MAX })
          } else if (projectId) {
            // 空状态：新建页面承载截图
            const maxSortNo = setPages?.reduce((m, p) => Math.max(m, p.sortNo ?? p.createdAt), 0) ?? 0
            const newPageId = genId()
            // 自动命名跳号：避开已存在的「页面 N」，保证不重名
            const existingNames = new Set((setPages ?? []).map((p) => p.name))
            let n = (setPages?.length ?? 0) + 1
            while (existingNames.has(`页面 ${n}`)) n += 1
            const pageName = `页面 ${n}`
            await productDb.pages.add({
              id: newPageId,
              projectId,
              setId,
              name: pageName,
              image: blob,
              thumbDataUrl: thumb,
              thumbMax: PRODUCT_THUMB_MAX,
              sortNo: maxSortNo + 1,
              createdAt: Date.now(),
            })
            setCurrentPageId(newPageId)
          }
        } catch (e) {
          console.error('Failed to save screenshot page:', e)
        }
      })
    } else if (source === 'url' && url?.trim()) {
      const normalized = /^https?:\/\//i.test(url) ? url.trim() : `http://${url.trim()}`
      // 空状态（无当前页）走新增页面通道自动建页；有当前页则替换图片
      window.electronAPI.openBrowserWindow(normalized, {
        captureMode: true,
        capturePurpose: currentPageId ? 'replaceImage' : 'newPage',
      })
    }
  }

  /** 侧边栏新增页面弹窗 */
  const [showCanvasAddPage, setShowCanvasAddPage] = useState(false)
  /** 替换当前页图片的 URL 采集弹窗（输入开发 URL） */
  const [showCaptureUrl, setShowCaptureUrl] = useState(false)
  const [captureUrlInput, setCaptureUrlInput] = useState('')
  /** URL 采集用于新增页面时缓存页面名称 */
  const pendingPageNameRef = useRef<string>('')
  const handleCanvasAddPageSelect = async (source: 'upload' | 'screenshot' | 'url', name: string) => {
    setShowCanvasAddPage(false)
    if (source === 'upload') {
      // 上传来源页面名按文件名自动获取（见 handleFileUpload），弹窗输入名不生效
      fileInputRef.current?.click()
    } else if (source === 'screenshot') {
      pendingPageNameRef.current = name
      window.electronAPI.captureRegion().then(async (res) => {
        if (!res.ok) {
          // macOS 录屏权限未授权：弹出 TRAE CN 风格权限引导
          if (res.reason === 'permission') showScreenPermissionGuide()
          return
        }
        if (!projectId) return
        const dataUrl = res.dataUrl
        const blob = await (await fetch(dataUrl)).blob()
        const thumb = await generateThumbnailFromBlob(blob)
        // 重名自动加序号后缀：每次采集都保存为新页
        const pageName = uniquePageName(pendingPageNameRef.current || t('addPage'), setPagesRef.current ?? [])
        const newPageId = genId()
        const maxSortNo = setPages?.reduce((m, p) => Math.max(m, p.sortNo ?? p.createdAt), 0) ?? 0
        const newPage: ProductPage = {
          id: newPageId,
          projectId,
          setId,
          name: pageName,
          image: blob,
          thumbDataUrl: thumb,
          thumbMax: PRODUCT_THUMB_MAX,
          sortNo: maxSortNo + 1,
          createdAt: Date.now(),
        }
        await productDb.pages.add(newPage)
        setCurrentPageId(newPageId)
      })
    } else if (source === 'url') {
      pendingPageNameRef.current = name
    }
  }

  /** 闪烁定位 + 进入/退出聚焦查看（重复点击重置计时；再点同一问题退出聚焦，对齐走查画板） */
  const handleFlash = (issue: Issue) => {
    setFlashId(issue.id)
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlashId(null), 2200)
    setFocusIssue((prev) => (prev?.id === issue.id ? null : issue))
  }

  // 聚焦查看：放大 2x 并滚动居中到问题点位
  // 依赖不含 zoom：聚焦期间点画板放大/缩小应正常生效，不能因 zoom 变化重跑把画布拉回 2x
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!focusIssue) return
    setZoom(2)
    const raf = window.requestAnimationFrame(() => {
      const el = canvasScrollRef.current
      if (!el) return
      const img = el.querySelector('img')
      if (!img) return
      const r = img.getBoundingClientRect()
      if (!r.width || !r.height) return
      el.scrollLeft = (focusIssue.x + focusIssue.width / 2) * r.width - el.clientWidth / 2
      el.scrollTop = (focusIssue.y + focusIssue.height / 2) * r.height - el.clientHeight / 2
    })
    return () => window.cancelAnimationFrame(raf)
  }, [focusIssue])

  /** Space 键抓手平移 */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return
      e.preventDefault()
      setSpacePan(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpacePan(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  /** 抓手工具/空格拖拽平移：位移转成画布滚动，作用于底层画布图片（对齐自动走查画板 handlePanStart） */
  const handlePanStart = (e: React.MouseEvent) => {
    if (!spacePan && tool !== 'hand') return
    const el = canvasScrollRef.current
    if (!el) return
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop }
    const move = (ev: globalThis.MouseEvent) => {
      el.scrollLeft = start.scrollLeft - (ev.clientX - start.x)
      el.scrollTop = start.scrollTop - (ev.clientY - start.y)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /** ===== 标注撤销 / 重做：基于可逆操作栈（新增/删除/编辑/移动/测量），Cmd+Z 撤销、Cmd+Shift+Z 重做 ===== */
  const [undoStack, setUndoStack] = useState<HistoryOp[]>([])
  const [redoStack, setRedoStack] = useState<HistoryOp[]>([])

  /** 记录一步标注操作（入撤销栈并清空重做栈，上限 50 步） */
  const pushHistory = (op: HistoryOp) => {
    setUndoStack((s) => [...s.slice(-49), op])
    setRedoStack([])
  }

  /** 正/反向应用一步操作：add 正向=按原 id 恢复、反向=删除；delete 相反；update 按 before/after 整条还原 */
  const applyHistoryOp = async (op: HistoryOp, dir: 'undo' | 'redo') => {
    const forward = (op.type === 'add' && dir === 'redo') || (op.type === 'delete' && dir === 'undo')
    if (op.type === 'add' || op.type === 'delete') {
      if (forward) await productDb.annotations.bulkPut(op.annotations)
      else await productDb.annotations.bulkDelete(op.annotations.map((a) => a.id))
    } else {
      await productDb.annotations.put(dir === 'undo' ? op.before : op.after)
    }
  }

  const undo = async () => {
    const op = undoStack[undoStack.length - 1]
    if (!op) return
    setUndoStack((s) => s.slice(0, -1))
    setRedoStack((r) => [...r, op])
    await applyHistoryOp(op, 'undo')
  }

  const redo = async () => {
    const op = redoStack[redoStack.length - 1]
    if (!op) return
    setRedoStack((s) => s.slice(0, -1))
    setUndoStack((u) => [...u, op])
    await applyHistoryOp(op, 'redo')
  }

  // 切换页面 / 新增画板进入新页时清空历史（历史操作属于当前页标注，不跨页面撤销）
  useEffect(() => {
    setUndoStack([])
    setRedoStack([])
  }, [currentPageId])

  // 快捷键：Mac Cmd+Z 撤销 / Cmd+Shift+Z 重做（Windows Ctrl 同理；输入框内交给原生撤销）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      e.preventDefault()
      if (e.shiftKey) void redo()
      // 有待撤回的页面删除时，Cmd+Z 优先恢复刚删除的页面（一次消费后恢复标注撤销）
      else if (pendingPageUndo) {
        const restore = pendingPageUndo
        pendingPageUndo = null
        restore()
      } else void undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /** 工具栏选项 */
  const toolOptions: { value: ProductToolValue; label: string }[] = [
    { value: 'hand', label: t('toolHand') },
    { value: 'point', label: t('toolPoint') },
    { value: 'arrow', label: t('toolArrow') },
    { value: 'rect', label: t('toolRect') },
    { value: 'text', label: t('toolText') },
    { value: 'measure', label: t('toolMeasure') },
    { value: 'picker', label: t('toolPicker') },
  ]

  /** 页面切换（本地状态切换 + 重置画布状态） */
  const handleSelectPage = (targetPageId: string) => {
    setCurrentPageId(targetPageId)
    setZoom(1)
    setFlashId(null)
    setFocusIssue(null)
  }

  /** 最新页面列表引用：异步回调（截图回传 / 上传 / URL 采集）中读取，避免闭包旧值 */
  const setPagesRef = useRef(setPages)
  setPagesRef.current = setPages

  /** 上传页面图片 */
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const target = e.target
    const files = target.files
    if (!files || !files.length || !projectId) return

    // 生成缩略图
    const file = files[0]
    // 页面名按文件名自动获取（去扩展名）；重名自动加序号后缀：每次上传都保存为新页
    const pageName = uniquePageName(file.name.replace(/\.[^.]+$/, ''), setPagesRef.current ?? [])
    const thumb = await new Promise<string>((resolve) => {
      const img = new Image()
      img.onload = () => {
        const maxDim = PRODUCT_THUMB_MAX
        const scale = Math.min(maxDim / img.naturalWidth, maxDim / img.naturalHeight, 1)
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth * scale
        canvas.height = img.naturalHeight * scale
        const ctx = canvas.getContext('2d')!
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/webp', 0.85))
      }
      img.src = URL.createObjectURL(file)
    })

    const newPageId = genId()
    const maxSortNo = setPages?.reduce((m, p) => Math.max(m, p.sortNo ?? p.createdAt), 0) ?? 0
    const newPage: ProductPage = {
      id: newPageId,
      projectId,
      setId,
      name: pageName,
      image: file,
      thumbDataUrl: thumb,
      thumbMax: PRODUCT_THUMB_MAX,
      sortNo: maxSortNo + 1,
      createdAt: Date.now(),
    }
    await productDb.pages.add(newPage)
    setCurrentPageId(newPageId)
    pendingPageNameRef.current = ''
    // Reset input
    target.value = ''
  }

  /** 替换当前页图片：先确认清除标注，再替换 */
  const replaceInputRef = useRef<HTMLInputElement | null>(null)
  const handleReplaceImageClick = async () => {
    const ok = await confirmDialog({
      message: t('replaceImageConfirm'),
      tone: 'danger',
    })
    if (!ok) return
    replaceInputRef.current?.click()
  }
  const handleReplaceImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const target = e.target
    const file = target.files?.[0]
    if (!file || !currentPageId) return
    const thumb = await generateThumbnailFromBlob(file)
    showBlobImage(file, currentPageId)
    // 清除当前页面所有标注
    await productDb.annotations.where('pageId').equals(currentPageId).delete()
    await productDb.pages.update(currentPageId, { image: file, thumbDataUrl: thumb, thumbMax: PRODUCT_THUMB_MAX })
    target.value = ''
  }

  /** 输入开发 URL 自动采集：先确认清除标注，再弹 URL 输入框（Electron 不支持 window.prompt） */
  const handleAutoCapture = () => {
    confirmDialog({
      message: t('replaceImageConfirm'),
      tone: 'danger',
    }).then((ok) => {
      if (!ok) return
      setCaptureUrlInput('')
      setShowCaptureUrl(true)
    })
  }

  /** 提交 URL：打开内置浏览器采集（替换当前页图片） */
  const submitCaptureUrl = () => {
    if (!captureUrlInput.trim()) return
    const normalized = /^https?:\/\//i.test(captureUrlInput.trim()) ? captureUrlInput.trim() : `http://${captureUrlInput.trim()}`
    setShowCaptureUrl(false)
    window.electronAPI.openBrowserWindow(normalized, { captureMode: true, capturePurpose: 'replaceImage' })
  }

  /** 处理内置浏览器 URL 采集回传（替换当前页图片，清除标注，同步页面名称） */
  const handleUrlCaptureResult = async (data: { dataUrl: string; name?: string }) => {
    if (!currentPageId) return
    try {
      const blob = await (await fetch(data.dataUrl)).blob()
      const thumb = await generateThumbnailFromBlob(blob)
      showBlobImage(blob, currentPageId)
      // 清除当前页面所有标注
      await productDb.annotations.where('pageId').equals(currentPageId).delete()
      await productDb.pages.update(currentPageId, {
        image: blob,
        thumbDataUrl: thumb,
        thumbMax: PRODUCT_THUMB_MAX,
        ...(data.name ? { name: data.name } : {}),
      })
    } catch (e) {
      console.error('Failed to update page with captured image:', e)
    }
  }

  /** 监听内置浏览器 URL 采集回传（替换当前页图片） */
  useEffect(() => {
    if (!currentPageId) return
    const cleanup = (window.electronAPI as any).onUrlCaptureResult(handleUrlCaptureResult)
    return () => { if (cleanup) cleanup() }
  }, [currentPageId])

  /** 监听 URL 采集新增页面回传 */
  useEffect(() => {
    if (!projectId) return
    const cleanup = (window.electronAPI as any).onNewPageResult(async (data: { dataUrl: string; name?: string }) => {
      console.log('[ProductCanvas] 收到 URL 采集新建页面回传, dataUrl 长度:', data?.dataUrl?.length ?? 0)
      try {
        const blob = await (await fetch(data.dataUrl)).blob()
        const thumb = await generateThumbnailFromBlob(blob)
        // 重名自动加序号后缀：每次采集都保存为新页
        const pageName = uniquePageName(data.name || pendingPageNameRef.current || t('addPage'), setPagesRef.current ?? [])
        const newPageId = genId()
        // 用最新页面列表计算最大 sortNo：useEffect 闭包里的 setPages 是首帧旧值（可能为 undefined），会导致新页排到最前
        const maxSortNo = setPagesRef.current?.reduce((m, p) => Math.max(m, p.sortNo ?? p.createdAt), 0) ?? 0
        const newPage: ProductPage = {
          id: newPageId,
          projectId,
          setId,
          name: pageName,
          image: blob,
          thumbDataUrl: thumb,
          thumbMax: PRODUCT_THUMB_MAX,
          sortNo: maxSortNo + 1,
          createdAt: Date.now(),
        }
        await productDb.pages.add(newPage)
        setCurrentPageId(newPageId)
      } catch (e) {
        console.error('Failed to create page from URL capture:', e)
      }
    })
    return () => { if (cleanup) cleanup() }
  }, [projectId, setId])

  /** 标注操作 */
  const handleCreate = async (rect: NormalizedRect) => {
    const id = genId()
    const annotation: ProductAnnotation = {
      id,
      pageId: currentPageId!,
      type: tool as ProductAnnotation['type'],
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      description: '',
      severity: 'minor',
      status: 'pending',
      createdAt: Date.now(),
    }
    await productDb.annotations.add(annotation)
    pushHistory({ type: 'add', annotations: [annotation] })
    setEditingIssue(annotationToIssue(annotation))
  }

  const handleQuickCreate = async (rect: NormalizedRect, _targetImage: TargetImage, data: { measurePx?: number; colorHex?: string }) => {
    const id = genId()
    const annotation: ProductAnnotation = {
      id,
      pageId: currentPageId!,
      type: tool as ProductAnnotation['type'],
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      description: '',
      severity: 'minor',
      status: 'pending',
      // 吸色默认颜色规范，测量默认间距规范（快速创建不弹窗，直接按工具定分类）
      category: tool === 'picker' ? 'color' : 'spacing',
      measureValue: data.measurePx !== undefined ? `${Math.round(data.measurePx)}px` : undefined,
      sampleColor: data.colorHex,
      createdAt: Date.now(),
    }
    await productDb.annotations.add(annotation)
    pushHistory({ type: 'add', annotations: [annotation] })
    // 测距/吸色标注：创建后不弹编辑弹窗，点击标注时再打开（工具保持不切，支持连续测量）
  }

  const handleMove = async (issue: Issue, rect: NormalizedRect) => {
    const before = await productDb.annotations.get(issue.id)
    if (!before) return
    const after = { ...before, x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    await productDb.annotations.update(issue.id, {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    })
    pushHistory({ type: 'update', before, after })
  }

  const handleSave = async (fields: {
    description: string
    severity: Severity
    category: Category
    status: IssueStatus
    targetImage: TargetImage
    color?: string
    measureValue?: string
    attachments?: IssueAttachment[]
  }) => {
    if (!editingIssue) return
    const before = await productDb.annotations.get(editingIssue.id)
    if (!before) return
    await productDb.annotations.update(editingIssue.id, {
      description: fields.description,
      severity: fields.severity,
      status: fields.status,
      category: fields.category,
      color: fields.color,
      measureValue: fields.measureValue,
      attachments: fields.attachments,
    })
    pushHistory({
      type: 'update',
      before,
      after: {
        ...before,
        description: fields.description,
        severity: fields.severity,
        status: fields.status,
        category: fields.category,
        color: fields.color,
        measureValue: fields.measureValue,
        attachments: fields.attachments,
      },
    })
    setEditingIssue(null)
  }

  const handleDeleteOne = async (issue: Issue) => {
    const raw = await productDb.annotations.get(issue.id)
    if (!raw) return
    await productDb.annotations.delete(issue.id)
    pushHistory({ type: 'delete', annotations: [raw] })
  }

  const handleStatusChange = async (issue: Issue, status: IssueStatus) => {
    const before = await productDb.annotations.get(issue.id)
    if (!before) return
    await productDb.annotations.update(issue.id, { status })
    pushHistory({ type: 'update', before, after: { ...before, status } })
  }

  const handleClearByType = async () => {
    if (!annotations?.length) return
    await productDb.annotations.where('pageId').equals(currentPageId!).delete()
    pushHistory({ type: 'delete', annotations })
  }

  /** 返回项目或当前文件夹 */
  const backTarget = project?.id
    ? `/product/${project.id}${annotationSet?.folderId ? `?f=${annotationSet.folderId}` : ''}`
    : '/product'

  /** 重命名标注集（内联编辑） */
  const [renamingSet, setRenamingSet] = useState(false)
  const [setRenameValue, setSetRenameValue] = useState('')
  const [titleWidth, setTitleWidth] = useState<number>(0)
  const setRenameRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLSpanElement>(null)
  const startRenameSet = () => {
    if (!annotationSet) return
    // 测量原标题宽度，额外加上输入框内边距补偿
    if (titleRef.current) {
      setTitleWidth(titleRef.current.offsetWidth + 20)
    }
    setRenamingSet(true)
    setSetRenameValue(annotationSet.name)
    setTimeout(() => {
      setRenameRef.current?.focus()
      setRenameRef.current!.setSelectionRange(annotationSet.name.length, annotationSet.name.length)
    }, 0)
  }
  const commitRenameSet = async () => {
    setRenamingSet(false)
    setTitleWidth(0)
    const trimmed = setRenameValue.trim()
    if (annotationSet && trimmed && trimmed !== annotationSet.name) {
      await productDb.sets.update(annotationSet.id, { name: trimmed, updatedAt: Date.now() })
    }
  }

  /** 删除标注集 */
  const handleDeleteSet = async () => {
    if (!annotationSet) return
    const ok = await confirmDialog({
      message: t('deletePageConfirm', { name: annotationSet.name }),
      tone: 'danger'
    })
    if (!ok) return
    // 级联删除
    const pages = await productDb.pages.where('setId').equals(annotationSet.id).toArray()
    const pageIds = pages.map((p) => p.id)
    if (pageIds.length) {
      await productDb.annotations.where('pageId').anyOf(pageIds).delete()
      await productDb.issues.where('pageId').anyOf(pageIds).delete()
      await productDb.pages.bulkDelete(pageIds)
    }
    await productDb.sets.delete(annotationSet.id)
    navigate(backTarget)
  }

  return (
    <div className="page product-canvas-page">
      {/* 主内容区：顶部导航栏独立一行（全屏样式），下方为标注画板 */}
      <div className="product-canvas-main">
        {/* 顶部导航栏：左侧 返回 icon + 页面标题；右侧 标注清单 + 导出报告（对齐自动走查全屏头部布局） */}
        <div className="pc-topbar">
          <div className="fs-head-left">
            <Link
              to={backTarget}
              className="seg-icon-btn"
              title={t('backToProject')}
              aria-label={t('backToProject')}
              draggable={false}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </Link>
            {renamingSet ? (
              <input
                ref={setRenameRef}
                className="title-rename-input fs-page-title"
                style={{ width: titleWidth }}
                value={setRenameValue}
                onChange={(e) => setSetRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRenameSet()
                  if (e.key === 'Escape') { setRenamingSet(false); setSetRenameValue('') }
                }}
                onBlur={() => void commitRenameSet()}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <span ref={titleRef} className="fs-page-title">{annotationSet?.name ?? ''}</span>
                {/* 悬停编辑按钮 */}
                {annotationSet && (
                  <button
                    className="title-edit-btn"
                    onClick={startRenameSet}
                    title={t('renamePage')}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
                    </svg>
                  </button>
                )}
              </>
            )}
            {/* 悬停删除按钮 */}
            {annotationSet && (
              <button
                className="title-edit-btn is-danger"
                onClick={handleDeleteSet}
                title={t('deletePage')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 6h18" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                </svg>
              </button>
            )}
          </div>
          <div className="pc-topbar-actions">
            <button type="button" className="btn-secondary" onClick={() => setDrawerOpen(!drawerOpen)}>
              <ListIcon />
              {t('issueList')}
            </button>
            {/* 携带 setId：导出报告只覆盖当前标注集的页面，避免混入项目内其他标注集导致页面不一致 */}
            <Link to={`/product/${projectId}/export?setId=${setId}`} className="btn-secondary" draggable={false}>
              <ExportIcon />
              {t('exportReport')}
            </Link>
          </div>
        </div>

        {/* 空状态引导（标注集内无页面时，弹出添加图片来源选择） */}
        {!page && setPages && setPages.length === 0 && (
          <EmptyState onAddImage={() => setShowAddImage(true)} />
        )}

        {/* 画板主体行：标注画板卡片 + 标注清单抽屉横向并排（抽屉从画板右侧展开，高度与画板对齐） */}
        {page && (
          <div className="pc-body-row">
          <div className="aw-result-panel card">
            {/* 面板标题：页面名 + 标注数，右侧为标注工具条；悬停标题时原位浮现「重新上传截图 / 输入 URL 自动采集」 */}
            <div className="panel-title design-source">
              <span className="aw-title-text">{page.name}</span>
              <span className="count count-accent panel-count pc-annotation-count">已标注 {issues.length} 个问题</span>
              <span className="aw-panel-right">
                <div className="aw-panel-tools">
                  {/* 标注工具切换 */}
                  {toolOptions.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`aw-tool-btn${tool === opt.value ? ' active' : ''}`}
                      title={opt.label}
                      onClick={() => setTool(opt.value)}
                    >
                      <ToolIcon name={opt.value} />
                    </button>
                  ))}
                  <span className="aw-tool-sep" />
                  {/* 撤销 / 重做：仅记录本画板标注操作（新增/删除/修改/测量） */}
                  <span className="panel-hist">
                    <button
                      type="button"
                      className="panel-hist-btn"
                      onClick={() => void undo()}
                      disabled={undoStack.length === 0}
                      title={`${t('undo')} (${navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+'}Z)`}
                      aria-label={t('undo')}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M9 14 4 9l5-5" />
                        <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="panel-hist-btn"
                      onClick={() => void redo()}
                      disabled={redoStack.length === 0}
                      title={`${t('redo')} (${navigator.platform.toLowerCase().includes('mac') ? '⇧⌘' : 'Ctrl+'}Z)`}
                      aria-label={t('redo')}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="m15 14 5-5-5-5" />
                        <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
                      </svg>
                    </button>
                  </span>
                  <span className="aw-tool-sep" />
                  {/* 步进式缩放：作用于底层画布图片 */}
                  <button
                    type="button"
                    className="aw-tool-btn"
                    title={t('zoomOut')}
                    disabled={zoom <= ZOOM_MIN}
                    onClick={() => setZoomStep(zoom - 0.25)}
                  >
                    −
                  </button>
                  <span className="aw-zoom-val">{Math.round(zoom * 100)}%</span>
                  <button
                    type="button"
                    className="aw-tool-btn"
                    title={t('zoomIn')}
                    disabled={zoom >= ZOOM_MAX}
                    onClick={() => setZoomStep(zoom + 0.25)}
                  >
                    ＋
                  </button>
                </div>
              </span>
              {/* 悬停标题时在标题原位（左侧）浮现的来源操作（复用自动走查来源面板交互与样式） */}
              <span className="aw-panel-acts">
                <button
                  type="button"
                  className="aw-panel-act-btn"
                  title={t('reuploadShotTitle')}
                  onClick={() => void handleReplaceImageClick()}
                >
                  {t('reuploadShot')}
                </button>
                <button
                  type="button"
                  className="aw-panel-act-btn"
                  title={t('autoCaptureTitle')}
                  onClick={handleAutoCapture}
                >
                  {t('autoCapture')}
                </button>
              </span>
            </div>

            {/* 聚焦查看提示条：画布只显示当前问题点位，可退出（复用走查画板样式） */}
            {focusIssue && (
              <div className="aw-focus-bar">
                <span>
                  {t('focusingOn', {
                    desc:
                      focusIssue.description.length > 32
                        ? `${focusIssue.description.slice(0, 32)}…`
                        : focusIssue.description
                  })}
                </span>
                <button type="button" onClick={() => setFocusIssue(null)}>
                  {t('exitFocus')}
                </button>
              </div>
            )}

            {/* 画板区域：样式对齐自动走查开发截图画板；页面缩略图导航嵌入画板内左侧 */}
            <div className="aw-result-canvas pc-canvas-row">
              {setPages && setPages.length > 0 && currentPageId && (
                <ThumbnailSidebar
                  pages={setPages}
                  currentPageId={currentPageId}
                  onSelect={handleSelectPage}
                  collapsed={sidebarCollapsed}
                  onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
                  onAddPage={() => setShowCanvasAddPage(true)}
                />
              )}
              {imageDataUrl && (
                <div
                  ref={canvasScrollRef}
                  className={`aw-zoom-scroll pc-zoom-scroll${tool === 'hand' ? ' hand-pan' : ''}${spacePan ? ' space-pan' : ''}`}
                  onMouseDown={handlePanStart}
                >
                  {/* 缩放作用于底层画布图片：内层宽度百分比驱动，标注元素随画布同步变换 */}
                  <div style={{ width: `${zoom * 100}%` }}>
                    <AnnotationCanvas
                      dataUrl={imageDataUrl}
                      alt={page?.name ?? ''}
                      issues={issues}
                      tool={tool === 'hand' ? null : (tool as AnnotationShape)}
                      panMode={tool === 'hand' || spacePan}
                      noOf={(issue) => issueNos.get(issue.id) ?? 0}
                      onCreate={handleCreate}
                      onQuickCreate={handleQuickCreate}
                      onMove={handleMove}
                      onEdit={(issue) => setEditingIssue(issue)}
                      targetImage='design'
                      pickerHexOnly
                      flashId={flashId}
                      focusId={focusIssue?.id ?? null}
                      spacePan={spacePan}
                    />
                  </div>
                </div>
              )}
              {!imageDataUrl && (
                <div className="empty-state" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                  <p>{t('loading')}</p>
                </div>
              )}
            </div>
          </div>
          {/* 标注清单抽屉：画板卡片的横向兄弟节点，从画板右侧展开，高度随画板对齐 */}
          {drawerOpen && (
            <IssueDrawer
              issues={issues}
              onHighlight={handleFlash}
              onEdit={(issue) => setEditingIssue(issue)}
              onAdd={undefined}
              onReverify={undefined}
              onStatusChange={handleStatusChange}
              onDeleteOne={handleDeleteOne}
              onClearByType={handleClearByType}
              showCategoryTabs
              onClose={() => setDrawerOpen(false)}
            />
          )}
          </div>
        )}
      </div>

      {/* 添加图片来源弹窗（空状态页） */}
      {showAddImage && (
        <AddImageModal
          projectId={projectId!}
          onSelect={handleAddImageSelect}
          onCancel={() => setShowAddImage(false)}
        />
      )}

      {/* 侧边栏新增页面弹窗 */}
      {showCanvasAddPage && (
        <CanvasAddPageModal
          defaultName={t('addPage')}
          existingNames={(setPages ?? []).map((p) => p.name)}
          onSelect={handleCanvasAddPageSelect}
          onCancel={() => setShowCanvasAddPage(false)}
        />
      )}

      {/* 悬停标题「输入 URL 自动采集」弹窗：输入开发 URL 后打开内置浏览器采集 */}
      {showCaptureUrl && (
        <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && setShowCaptureUrl(false)}>
          <div className="modal" style={{ minWidth: 460 }}>
            <h3 style={{ margin: '0 0 16px' }}>{t('autoCapture')}</h3>
            <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: '0 0 12px' }}>{t('captureUrlPrompt')}</p>
            <input
              className="input"
              autoFocus
              placeholder={t('urlInputPlaceholder')}
              value={captureUrlInput}
              onChange={(e) => setCaptureUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCaptureUrl()
                if (e.key === 'Escape') setShowCaptureUrl(false)
              }}
            />
            <div className="modal-actions">
              <span className="modal-spacer" />
              <button className="btn-secondary" onClick={() => setShowCaptureUrl(false)}>
                {t('cancel')}
              </button>
              <button className="btn-primary" disabled={!captureUrlInput.trim()} onClick={submitCaptureUrl}>
                {t('openBrowser')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 编辑弹窗 */}
      {editingIssue && (
        <IssueEditorModal
          issue={editingIssue}
          mode="edit"
          hideTargetImage
          onSave={handleSave}
          onDelete={() => {
            // 每个标注都可删除：编辑弹窗内直接删除当前标注
            const target = editingIssue
            setEditingIssue(null)
            if (target) void handleDeleteOne(target)
          }}
          onCancel={() => setEditingIssue(null)}
        />
      )}

      {/* 隐藏的文件选择器 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileUpload}
      />

      {/* 隐藏的替换截图选择器（重新上传当前页截图） */}
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        style={{ display: 'none' }}
        onChange={handleReplaceImage}
      />
    </div>
  )
}
