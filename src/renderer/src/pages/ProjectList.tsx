import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { db, Platform, PLATFORM_LABELS, platformList, bySort } from '../db'
import ProjectModal from '../components/ProjectModal'
import { ProjectCard, ProjectRow, type CardDnd } from '../components/ProjectCard'
import heroBannerArtUrl from '../assets/hero-banner-xm.png'
import heroBannerArtDarkUrl from '../assets/hero-banner-xm-dark.png'

const PLATFORM_KEYS = Object.keys(PLATFORM_LABELS) as Platform[]

/** 首页统计：口径与报告一致，排除未审核 AI 候选 */
function useGlobalStats() {
  return useLiveQuery(async () => {
    const [projects, pages, issues] = await Promise.all([
      db.projects.toArray(),
      db.pages.toArray(),
      db.issues.toArray()
    ])
    const reportable = issues.filter((i) => !(i.isAISuggested && !i.aiConfirmed))
    const pending = reportable.filter((i) => i.status === 'pending')
    const resolved = reportable.filter((i) =>
      ['fixed', 'ignored', 'design-confirmed'].includes(i.status)
    )
    return {
      projectCount: projects.length,
      platformCount: new Set(projects.flatMap((p) => platformList(p.platform))).size,
      pendingCount: pending.length,
      resolvedTotal: resolved.length,
      pageCount: pages.length
    }
  }, [])
}

function StatIcon({ kind }: { kind: 'projects' | 'pending' | 'resolved' | 'pages' }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  if (kind === 'projects') {
    return (
      <svg {...common}>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </svg>
    )
  }
  if (kind === 'pending') {
    return (
      <svg {...common}>
        <path d="M3 12h4l2-6 4 12 2-6h6" />
      </svg>
    )
  }
  if (kind === 'resolved') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12 2.5 2.5 4.5-5" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="m12 3 9 5-9 5-9-5Z" />
      <path d="m3 14 9 5 9-5" />
    </svg>
  )
}

export default function ProjectList() {
  const { t } = useTranslation('projectList')
  // 与侧边栏树排序保持一致：手动 sortNo 优先，未拖过的按创建时间
  const projects = useLiveQuery(async () => (await db.projects.toArray()).sort(bySort), [])
  const stats = useGlobalStats()
  const [showNew, setShowNew] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [platformFilter, setPlatformFilter] = useState<Platform | 'all'>('all')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return (projects ?? []).filter(
      (p) =>
        (platformFilter === 'all' || platformList(p.platform).includes(platformFilter)) &&
        (!kw || p.name.toLowerCase().includes(kw))
    )
  }, [projects, keyword, platformFilter])

  // ===== 拖拽排序：仅在未筛选时启用（避免筛选子集重排污染整体顺序） =====
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ id: string; pos: 'before' | 'after' } | null>(null)
  const reorderable = !keyword.trim() && platformFilter === 'all'

  /** 拖动换位：整列重排 sortNo（步长 10），与侧边栏树排序口径一致 */
  const reorderProjects = async (fromId: string, toId: string, pos: 'before' | 'after') => {
    if (fromId === toId) return
    const ids = (projects ?? []).map((p) => p.id).filter((x) => x !== fromId)
    const i = ids.indexOf(toId)
    if (i < 0) return
    ids.splice(pos === 'before' ? i : i + 1, 0, fromId)
    for (let k = 0; k < ids.length; k++) {
      await db.projects.update(ids[k], { sortNo: (k + 1) * 10 })
    }
  }

  /** 卡片/行拖拽 props：axis 决定插入位置按横向（网格）还是纵向（列表）中点判断 */
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

  return (
    <div className="page project-list-page">
      {/* 顶部横幅（原型样式）：标题 + 副标题 + 右上新建按钮 + AI 插图 + 底部统计卡 */}
      <div className="rv2-hero projects-hero">
        <div className="rv2-hero-main">
          <h1 className="rv2-title">{t('title')}</h1>
          <p className="rv2-desc">{t('desc')}</p>
        </div>
        <button className="btn-primary projects-new-btn" onClick={() => setShowNew(true)}>
          {t('newProject')}
        </button>
        {/* AI 插图：浅色 / 深色双版本，absolute 贴右缘、尺寸固定不随窗口缩放 */}
        <img className="rv2-hero-art" src={heroBannerArtUrl} alt={t('artAlt')} draggable={false} />
        <img className="rv2-hero-art-dark" src={heroBannerArtDarkUrl} alt="" draggable={false} />
        <div className="projects-stat-row">
          <div className="projects-stat-card">
            <span className="stat-icon blue">
              <StatIcon kind="projects" />
            </span>
            <div className="projects-stat-body">
              <i>{t('allProjects')}</i>
              <b>
                {stats?.projectCount ?? 0}
                <small>{t('unitCount')}</small>
              </b>
            </div>
          </div>
          <div className="projects-stat-card">
            <span className="stat-icon orange">
              <StatIcon kind="pending" />
            </span>
            <div className="projects-stat-body">
              <i>{t('pendingAnnotations')}</i>
              <b>
                {stats?.pendingCount ?? 0}
                <small>{t('unitCount')}</small>
              </b>
            </div>
          </div>
          <div className="projects-stat-card">
            <span className="stat-icon green">
              <StatIcon kind="resolved" />
            </span>
            <div className="projects-stat-body">
              <i>{t('resolvedAnnotations')}</i>
              <b>
                {stats?.resolvedTotal ?? 0}
                <small>{t('unitCount')}</small>
              </b>
            </div>
          </div>
          <div className="projects-stat-card">
            <span className="stat-icon purple">
              <StatIcon kind="pages" />
            </span>
            <div className="projects-stat-body">
              <i>{t('pagesIncluded')}</i>
              <b>
                {stats?.pageCount ?? 0}
                <small>{t('unitCount')}</small>
              </b>
            </div>
          </div>
        </div>
      </div>

      <div className="filter-row">
        <div className="plat-tabs">
          <button
            type="button"
            className={`plat-tab ${platformFilter === 'all' ? 'active' : ''}`}
            onClick={() => setPlatformFilter('all')}
          >
            {t('allPlatforms')}
          </button>
          {PLATFORM_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              className={`plat-tab ${platformFilter === k ? 'active' : ''}`}
              onClick={() => setPlatformFilter(k)}
            >
              {t(`platform_${k}`)}
            </button>
          ))}
        </div>
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
          <div className="view-toggle">
            <button
              type="button"
              className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}
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
              className={`view-btn ${viewMode === 'list' ? 'active' : ''}`}
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
            <ProjectCard key={p.id} project={p} dnd={cardDnd(p.id, 'x')} />
          ))}
        </div>
      ) : (
        <div className="project-rows">
          {filtered.map((p) => (
            <ProjectRow key={p.id} project={p} dnd={cardDnd(p.id, 'y')} />
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

      {showNew && <ProjectModal onDone={() => setShowNew(false)} onCancel={() => setShowNew(false)} />}
    </div>
  )
}
