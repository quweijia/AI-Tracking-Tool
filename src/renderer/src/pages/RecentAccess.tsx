import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { db, Visit, Project } from '../db'
import { PlatformBadge } from '../components/PlatformBadge'
import { ProjectLogo, timeAgo } from '../components/ProjectCard'

/** 统计卡图标（线性风格） */
function StatGlyph({ name }: { name: 'today' | 'week' | 'project' | 'total' }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  switch (name) {
    case 'today':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      )
    case 'week':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M8 3v4M16 3v4M3 10h18" />
        </svg>
      )
    case 'project':
      return (
        <svg {...common}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
      )
    case 'total':
      return (
        <svg {...common}>
          <path d="M12 2 2 7l10 5 10-5-10-5Z" />
          <path d="m2 17 10 5 10-5M2 12l10 5 10-5" />
        </svg>
      )
  }
}

const DAY = 24 * 60 * 60 * 1000

const startOfDay = (ts: number) => {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 访问时间展示：今天用相对时间，昨天精确到时分，更早显示日期 */
const fmtVisitTime = (ts: number) => {
  const d = new Date(ts)
  const t0 = startOfDay(Date.now())
  if (ts >= t0) return timeAgo(ts)
  if (ts >= t0 - DAY) {
    return `昨天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  if (d.getFullYear() === new Date().getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

export default function RecentAccess() {
  const visits = useLiveQuery(() => db.visits.toArray(), []) ?? []
  const pages = useLiveQuery(() => db.pages.toArray(), []) ?? []
  const projects = useLiveQuery(() => db.projects.toArray(), []) ?? []
  const versions = useLiveQuery(() => db.versions.toArray(), []) ?? []

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? '未知项目'
  const versionName = (id: string) => versions.find((v) => v.id === id)?.name ?? ''

  /** 项目 Logo：项目被删除时用页面名首字符占位（不影响展示） */
  const projOf = (projectId: string, fallbackName: string, platform: Project['platform']): Project =>
    projects.find((p) => p.id === projectId) ?? {
      id: projectId,
      name: fallbackName,
      platform,
      createdAt: 0,
      updatedAt: 0
    }

  const pageMap = new Map(pages.map((p) => [p.id, p]))

  /**
   * 排序口径 = 最近活跃时间：页面 updatedAt（标注/状态修改）与最近访问时间的较大值，
   * 刚修改过的页面会实时排到最前。
   */
  const latestByPage = new Map<string, number>()
  visits.forEach((v: Visit) => {
    if (!pageMap.has(v.pageId)) return
    const cur = latestByPage.get(v.pageId) ?? 0
    if (v.visitedAt > cur) latestByPage.set(v.pageId, v.visitedAt)
  })
  const entries = [...latestByPage.entries()].map(([pageId, ts]) => {
    const activity = Math.max(pageMap.get(pageId)?.updatedAt ?? 0, ts)
    return [pageId, activity] as [string, number]
  })
  entries.sort((a, b) => b[1] - a[1])

  // 时间分桶：今天 / 昨天 / 最近一周 / 最近一个月 / 更早
  const today0 = startOfDay(Date.now())
  const yesterday0 = today0 - DAY
  const week0 = today0 - 6 * DAY
  const month0 = today0 - 29 * DAY
  const bucketOf = (ts: number): number => {
    if (ts >= today0) return 0
    if (ts >= yesterday0) return 1
    if (ts >= week0) return 2
    if (ts >= month0) return 3
    return 4
  }
  const GROUP_LABELS = ['今天', '昨天', '最近一周', '最近一个月', '更早']
  const buckets: [string, number][][] = [[], [], [], [], []]
  entries.forEach((e) => buckets[bucketOf(e[1])].push(e))

  const todayCount = visits.filter((v) => v.visitedAt >= today0).length
  const weekCount = visits.filter((v) => v.visitedAt >= week0).length
  const projectCount = new Set(visits.map((v) => v.projectId)).size

  /** 继续上次工作：最近一次访问且页面仍存在 */
  const lastEntry = entries[0]
  const lastPage = lastEntry ? pageMap.get(lastEntry[0]) : undefined

  const handleClear = async () => {
    if (!visits.length) return
    const ok = window.confirm(
      `确定清空全部 ${visits.length} 条访问记录吗？\n仅清空访问足迹，不影响走查页面与标注数据。`
    )
    if (!ok) return
    await db.visits.clear()
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>最近访问</h1>
          <p className="list-sub">按访问时间排序的走查页面足迹，点击直接进入标注工作台</p>
        </div>
        {visits.length > 0 && (
          <button type="button" className="btn-secondary recent-clear" onClick={handleClear}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <path d="M10 11v6M14 11v6" />
            </svg>
            清空记录
          </button>
        )}
      </div>

      {/* 数据统计 */}
      <div className="stats-row four">
        <div className="stat-card">
          <span className="stat-icon blue">
            <StatGlyph name="today" />
          </span>
          <span className="stat-body">
            <span className="stat-label">今日访问</span>
            <span className="stat-num">
              {todayCount}
              <small>次</small>
            </span>
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-icon green">
            <StatGlyph name="week" />
          </span>
          <span className="stat-body">
            <span className="stat-label">最近 7 天</span>
            <span className="stat-num">
              {weekCount}
              <small>次</small>
            </span>
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-icon orange">
            <StatGlyph name="project" />
          </span>
          <span className="stat-body">
            <span className="stat-label">涉及项目</span>
            <span className="stat-num">
              {projectCount}
              <small>个</small>
            </span>
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-icon purple">
            <StatGlyph name="total" />
          </span>
          <span className="stat-body">
            <span className="stat-label">累计访问</span>
            <span className="stat-num">
              {visits.length}
              <small>次</small>
            </span>
          </span>
        </div>
      </div>

      {/* 继续上次工作 */}
      {lastPage && lastEntry && (
        <Link className="recent-continue" to={`/project/${lastPage.projectId}/page/${lastPage.id}`}>
          <span className="recent-continue-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
              <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
              <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
              <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
            </svg>
          </span>
          <span className="recent-continue-body">
            <span className="recent-continue-tag">继续上次工作</span>
            <span className="recent-continue-name">{lastPage.pageName}</span>
            <span className="recent-continue-sub">
              {projectName(lastPage.projectId)}
              {versionName(lastPage.versionId) ? ` / ${versionName(lastPage.versionId)}` : ''} ·{' '}
              {timeAgo(lastEntry[1])}访问
            </span>
          </span>
          <span className="recent-continue-btn">
            继续查看
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m9 18 6-6-6-6" />
            </svg>
          </span>
        </Link>
      )}

      {/* 分组记录列表 */}
      {entries.length > 0 ? (
        <>
          {buckets.map((items, idx) =>
            items.length > 0 ? (
              <div key={idx} className="recent-group">
                <div className="recent-group-title">
                  {GROUP_LABELS[idx]}
                  <span className="recent-group-count">{items.length}</span>
                </div>
                <div className="recent-list">
                  {items.map(([pageId, ts]) => {
                    const pg = pageMap.get(pageId)!
                    const sub = versionName(pg.versionId)
                      ? `${projectName(pg.projectId)} / ${versionName(pg.versionId)}`
                      : projectName(pg.projectId)
                    return (
                      <Link
                        key={pageId}
                        to={`/project/${pg.projectId}/page/${pg.id}`}
                        className="recent-item"
                      >
                        <ProjectLogo project={projOf(pg.projectId, pg.pageName, [pg.platform])} size={38} />
                        <span className="recent-item-main">
                          <span className="recent-item-name">{pg.pageName}</span>
                          <span className="recent-item-sub">{sub}</span>
                        </span>
                        <span className="recent-item-side">
                          <PlatformBadge platform={pg.platform} />
                          <span className="recent-item-time">{fmtVisitTime(ts)}</span>
                        </span>
                      </Link>
                    )
                  })}
                </div>
              </div>
            ) : null
          )}
          <p className="recent-foot">共 {visits.length} 条访问记录</p>
        </>
      ) : (
        <div className="empty-state">
          <p>{visits.length > 0 ? '访问过的页面已全部删除' : '暂无访问记录，进入任意标注页面后这里会展示你的足迹'}</p>
        </div>
      )}
    </div>
  )
}
