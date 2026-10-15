import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { db, Platform, PLATFORM_LABELS, platformList, bySort } from '../db'
import ProjectModal from '../components/ProjectModal'
import { ProjectCard, ProjectRow } from '../components/ProjectCard'

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

function StatIcon({ kind }: { kind: 'projects' | 'pending' | 'pages' }) {
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
  return (
    <svg {...common}>
      <path d="m12 3 9 5-9 5-9-5Z" />
      <path d="m3 14 9 5 9-5" />
    </svg>
  )
}

export default function ProjectList() {
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

  return (
    <div className="page project-list-page">
      <div className="list-head">
        <div>
          <h1>项目</h1>
          <p className="list-sub">集中管理设计稿、开发截图与 AI 走查标注</p>
        </div>
        <button className="btn-primary" onClick={() => setShowNew(true)}>
          ＋ 新建项目
        </button>
      </div>

      <div className="stats-row">
        <div className="stat-card">
          <span className="stat-icon blue">
            <StatIcon kind="projects" />
          </span>
          <div className="stat-body">
            <span className="stat-label">全部项目</span>
            <p className="stat-num">
              {stats?.projectCount ?? 0}
              <small>{stats ? `覆盖 ${stats.platformCount} 类端平台` : '统计中…'}</small>
            </p>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-icon orange">
            <StatIcon kind="pending" />
          </span>
          <div className="stat-body">
            <span className="stat-label">待处理标注</span>
            <p className="stat-num">
              {stats?.pendingCount ?? 0}
              <small>{stats ? `${stats.resolvedTotal} 个标注已解决` : '统计中…'}</small>
            </p>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-icon green">
            <StatIcon kind="pages" />
          </span>
          <div className="stat-body">
            <span className="stat-label">已纳入页面</span>
            <p className="stat-num">
              {stats?.pageCount ?? 0}
              <small>所有项目累计</small>
            </p>
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
            全部平台
          </button>
          {PLATFORM_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              className={`plat-tab ${platformFilter === k ? 'active' : ''}`}
              onClick={() => setPlatformFilter(k)}
            >
              {PLATFORM_LABELS[k]}
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
              placeholder="搜索项目名称"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <div className="view-toggle">
            <button
              type="button"
              className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
              title="平铺视图"
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
              title="列表视图"
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
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      ) : (
        <div className="project-rows">
          {filtered.map((p) => (
            <ProjectRow key={p.id} project={p} />
          ))}
        </div>
      )}

      {projects?.length === 0 && !showNew && (
        <div className="empty-state">
          <p>还没有项目，点击右上角「新建项目」开始</p>
        </div>
      )}
      {!!projects?.length && filtered.length === 0 && (
        <div className="empty-state">
          <p>没有符合筛选条件的项目</p>
        </div>
      )}

      {showNew && <ProjectModal onDone={() => setShowNew(false)} onCancel={() => setShowNew(false)} />}
    </div>
  )
}
