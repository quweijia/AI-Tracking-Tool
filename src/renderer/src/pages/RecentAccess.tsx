import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { db, Visit, Project } from '../db'
import { tr } from '../i18n'
import { PlatformBadge } from '../components/PlatformBadge'
import { ProjectLogo, timeAgo } from '../components/ProjectCard'
import heroBannerArtUrl from '../assets/hero-banner-art.png'
import heroBannerArtDarkUrl from '../assets/hero-banner-art-dark.png'

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

/** 统计卡迷你趋势图（折线 / 柱状），基于最近 7 天每日访问次数 */
function MiniTrend({ daily, kind }: { daily: number[]; kind: 'line' | 'bar' }) {
  const max = Math.max(1, ...daily)
  if (kind === 'bar') {
    return (
      <svg className="stat-spark" width="72" height="28" viewBox="0 0 72 28" aria-hidden>
        {daily.map((n, i) => {
          const h = Math.max(3, (n / max) * 22)
          return <rect key={i} x={i * 10 + 2} y={26 - h} width={6} height={h} rx={2} className="stat-spark-bar" />
        })}
      </svg>
    )
  }
  const pts = daily
    .map((n, i) => `${(i / 6) * 68 + 2},${26 - Math.max(2, (n / max) * 22)}`)
    .join(' ')
  return (
    <svg className="stat-spark" width="72" height="28" viewBox="0 0 72 28" aria-hidden>
      <polyline points={pts} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 欢迎横幅 AI 插图：浅色主题用参考设计稿裁切版（含烘焙辉光），深色主题用深色版（左缘羽化，与深色背景融合） */

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
    return tr('yesterday', 'recentAccess', {
      time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    })
  }
  if (d.getFullYear() === new Date().getFullYear()) {
    return tr('monthDay', 'recentAccess', { month: d.getMonth() + 1, day: d.getDate() })
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

type ListTab = 'all' | 'project' | 'page'

/** 表格时间分组（今天 / 最近 7 天 / 最近 1 个月 / 更早），组可折叠 */
type TimeBucket = 'today' | 'week' | 'month' | 'earlier'
const GROUP_BUCKETS: { key: TimeBucket; labelKey: string }[] = [
  { key: 'today', labelKey: 'groupToday' },
  { key: 'week', labelKey: 'groupWeek' },
  { key: 'month', labelKey: 'groupMonth' },
  { key: 'earlier', labelKey: 'groupEarlier' }
]

/** 常用工具入口配置 */
const QUICK_TOOLS: { key: string; nameKey: string; subKey: string; icon: JSX.Element }[] = [
  {
    key: 'detect',
    nameKey: 'toolDetect',
    subKey: 'toolDetectSub',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
    )
  },
  {
    key: 'compare',
    nameKey: 'toolCompare',
    subKey: 'toolCompareSub',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="5" width="8" height="14" rx="1.5" />
        <rect x="13" y="5" width="8" height="14" rx="1.5" />
      </svg>
    )
  },
  {
    key: 'report',
    nameKey: 'toolReport',
    subKey: 'toolReportSub',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M6 3h9l4 4v14H6z" />
        <path d="M9 12h7M9 16h5" />
      </svg>
    )
  },
  {
    key: 'config',
    nameKey: 'toolConfig',
    subKey: 'toolConfigSub',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    )
  }
]

export default function RecentAccess() {
  const { t } = useTranslation('recentAccess')
  const visits = useLiveQuery(() => db.visits.toArray(), []) ?? []
  const pages = useLiveQuery(() => db.pages.toArray(), []) ?? []
  const projects = useLiveQuery(() => db.projects.toArray(), []) ?? []
  const folders = useLiveQuery(() => db.folders.toArray(), []) ?? []

  const [listTab, setListTab] = useState<ListTab>('all')
  /** 表格时间分组折叠状态（默认全部展开） */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<TimeBucket>>(new Set())
  /** 继续上次工作的设计稿缩略图（page.designImagePath） */
  const [designThumb, setDesignThumb] = useState<string>('')

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? t('unknownProject')
  const folderName = (id: string | undefined) => folders.find((v) => v.id === id)?.name ?? ''

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
  const visitCountByPage = useMemo(() => {
    const m = new Map<string, number>()
    visits.forEach((v) => m.set(v.pageId, (m.get(v.pageId) ?? 0) + 1))
    return m
  }, [visits])
  const entries = [...latestByPage.entries()].map(([pageId, ts]) => {
    const activity = Math.max(pageMap.get(pageId)?.updatedAt ?? 0, ts)
    return [pageId, activity] as [string, number]
  })
  entries.sort((a, b) => b[1] - a[1])

  const today0 = startOfDay(Date.now())
  const yesterday0 = today0 - DAY
  const week0 = today0 - 6 * DAY

  /** 时间分桶：今天 / 最近 7 天（不含今天）/ 最近 1 个月（不含近 7 天）/ 更早 */
  const bucketOf = (ts: number): TimeBucket => {
    if (ts >= today0) return 'today'
    if (ts >= week0) return 'week'
    if (ts >= today0 - 29 * DAY) return 'month'
    return 'earlier'
  }

  /** 切换分组折叠 */
  const toggleGroup = (key: TimeBucket) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  /** 分组头（折叠箭头 + 标签 + 条数） */
  const renderGroupHead = (bucket: TimeBucket, count: number) => {
    const collapsed = collapsedGroups.has(bucket)
    const meta = GROUP_BUCKETS.find((b) => b.key === bucket)!
    return (
      <button
        type="button"
        className={`rv2-group-head${collapsed ? ' collapsed' : ''}`}
        onClick={() => toggleGroup(bucket)}
        title={collapsed ? t('expandGroup') : t('collapseGroup')}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
        {t(meta.labelKey)}
        <span className="rv2-group-count">{t('itemCount', { count })}</span>
      </button>
    )
  }

  const todayCount = visits.filter((v) => v.visitedAt >= today0).length
  const yesterdayCount = visits.filter((v) => v.visitedAt >= yesterday0 && v.visitedAt < today0).length
  const weekCount = visits.filter((v) => v.visitedAt >= week0).length
  const prevWeekCount = visits.filter((v) => v.visitedAt >= week0 - 7 * DAY && v.visitedAt < week0).length
  const projectCount = new Set(visits.map((v) => v.projectId)).size

  /** 最近 7 天每日访问次数（趋势图 + 环比） */
  const daily7 = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const s = today0 - (6 - i) * DAY
        return visits.filter((v) => v.visitedAt >= s && v.visitedAt < s + DAY).length
      }),
    [visits, today0]
  )
  const pct = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : 0)

  /** 项目维度聚合（「项目」tab） */
  const projectGroups = useMemo(() => {
    const m = new Map<string, { projectId: string; latest: number; pageCount: number; visitCount: number }>()
    visits.forEach((v) => {
      if (!pages.some((p) => p.id === v.pageId)) return
      const cur = m.get(v.projectId)
      if (cur) {
        cur.latest = Math.max(cur.latest, v.visitedAt)
        cur.visitCount += 1
      } else {
        m.set(v.projectId, { projectId: v.projectId, latest: v.visitedAt, pageCount: 1, visitCount: 1 })
      }
    })
    m.forEach((g) => {
      g.pageCount = new Set(visits.filter((v) => v.projectId === g.projectId).map((v) => v.pageId)).size
    })
    return [...m.values()].sort((a, b) => b.latest - a.latest)
  }, [visits, pages])

  /** 继续上次工作：最近一次访问且页面仍存在 */
  const lastEntry = entries[0]
  const lastPage = lastEntry ? pageMap.get(lastEntry[0]) : undefined
  const lastVisitCount = lastPage ? (visitCountByPage.get(lastPage.id) ?? 0) : 0

  /** 最近活动时间线：全部最近访问记录（页面仍存在的），超出部分卡片内滚动 */
  const activityItems = useMemo(
    () =>
      [...visits]
        .filter((v) => pageMap.has(v.pageId))
        .sort((a, b) => b.visitedAt - a.visitedAt),
    [visits, pageMap]
  )

  useEffect(() => {
    let alive = true
    const path = lastPage?.designImagePath
    if (!path) {
      setDesignThumb('')
      return
    }
    window.electronAPI.readImage(path).then((url) => {
      if (alive) setDesignThumb(url ?? '')
    })
    return () => {
      alive = false
    }
  }, [lastPage?.designImagePath])

  const handleClear = async () => {
    if (!visits.length) return
    const ok = window.confirm(t('clearConfirm', { count: visits.length }))
    if (!ok) return
    await db.visits.clear()
  }

  /** 删除单个页面的全部访问记录（仅清足迹，不影响页面与标注数据） */
  const handleDeleteVisits = async (pageId: string, pageName: string) => {
    const count = visits.filter((v) => v.pageId === pageId).length
    if (!count) return
    const ok = window.confirm(t('deleteVisitConfirm', { name: pageName, count }))
    if (!ok) return
    await db.visits.where('pageId').equals(pageId).delete()
  }

  return (
    <div className="page recent-v2">
      {/* ===== 欢迎横幅：欢迎词 + 工具介绍 + AI 插图 + 快速开始 ===== */}
      <div className="rv2-hero">
        <div className="rv2-hero-main">
          <p className="rv2-hello">{t('hello')}</p>
          <h1 className="rv2-title">{t('pageTitle')}</h1>
          <p className="rv2-desc">
            {t('pageDesc')}
            <br />
            {t('pageDescSub')}
          </p>
          <div className="rv2-feats">
            <span className="rv2-feat">
              <span className="rv2-feat-icon blue">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
              </span>
              <span>
                <b>{t('featDetect')}</b>
                <i>{t('featDetectSub')}</i>
              </span>
            </span>
            <span className="rv2-feat">
              <span className="rv2-feat-icon purple">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="3" />
                  <circle cx="12" cy="12" r="9" />
                </svg>
              </span>
              <span>
                <b>{t('featIdentify')}</b>
                <i>{t('featIdentifySub')}</i>
              </span>
            </span>
            <span className="rv2-feat">
              <span className="rv2-feat-icon green">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M9 12l2 2 4-5" />
                  <circle cx="12" cy="12" r="9" />
                </svg>
              </span>
              <span>
                <b>{t('featAdvice')}</b>
                <i>{t('featAdviceSub')}</i>
              </span>
            </span>
          </div>
        </div>
        {/* AI 插图：absolute 贴横幅右缘，高度上下填满横幅、尺寸固定（缩窗不缩放）；深色模式换深色版 */}
        <img className="rv2-hero-art" src={heroBannerArtUrl} alt={t('artAlt')} draggable={false} />
        <img className="rv2-hero-art-dark" src={heroBannerArtDarkUrl} alt="" draggable={false} />
        {/* 快速开始卡：absolute 定位叠加在 AI 插图上方（横幅右侧） */}
        <div className="rv2-quick">
          <div className="rv2-quick-head">
            <span className="rv2-quick-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M13 2 4.5 13.5H11L9.5 22 19 9.5h-6.5L13 2z" />
              </svg>
            </span>
            {t('quickStart')}
          </div>
          <Link className="rv2-quick-link" to="/new">
            {t('quickStartNew')}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m9 18 6-6-6-6" />
            </svg>
          </Link>
          <Link className="btn-primary rv2-quick-btn" to="/new">
            {t('quickStartBtn')}
          </Link>
        </div>
      </div>

      {/* ===== 数据统计（含迷你趋势与环比） ===== */}
      <div className="stats-row four">
        <div className="stat-card">
          <span className="stat-icon blue">
            <StatGlyph name="today" />
          </span>
          <span className="stat-body">
            <span className="stat-label">{t('todayVisits')}</span>
            <span className="stat-num">
              {todayCount}
              <small>{t('unitTimes')}</small>
              <em className={`stat-trend ${pct(todayCount, yesterdayCount) >= 0 ? 'up' : 'down'}`}>
                {pct(todayCount, yesterdayCount) >= 0 ? '↑' : '↓'}
                {Math.abs(pct(todayCount, yesterdayCount))}%
              </em>
            </span>
          </span>
          <MiniTrend daily={daily7} kind="line" />
        </div>
        <div className="stat-card">
          <span className="stat-icon green">
            <StatGlyph name="week" />
          </span>
          <span className="stat-body">
            <span className="stat-label">{t('last7Days')}</span>
            <span className="stat-num">
              {weekCount}
              <small>{t('unitTimes')}</small>
              <em className={`stat-trend ${pct(weekCount, prevWeekCount) >= 0 ? 'up' : 'down'}`}>
                {pct(weekCount, prevWeekCount) >= 0 ? '↑' : '↓'}
                {Math.abs(pct(weekCount, prevWeekCount))}%
              </em>
            </span>
          </span>
          <MiniTrend daily={daily7} kind="line" />
        </div>
        <div className="stat-card">
          <span className="stat-icon orange">
            <StatGlyph name="project" />
          </span>
          <span className="stat-body">
            <span className="stat-label">{t('involvedProjects')}</span>
            <span className="stat-num">
              {projectCount}
              <small>{t('unitProjects')}</small>
              <em className="stat-trend up">↑0%</em>
            </span>
          </span>
          <MiniTrend daily={daily7} kind="bar" />
        </div>
        <div className="stat-card">
          <span className="stat-icon purple">
            <StatGlyph name="total" />
          </span>
          <span className="stat-body">
            <span className="stat-label">{t('totalVisits')}</span>
            <span className="stat-num">
              {visits.length}
              <small>{t('unitTimes')}</small>
              <em className="stat-trend up">↑0%</em>
            </span>
          </span>
          <MiniTrend daily={daily7} kind="line" />
        </div>
      </div>

      <div className="rv2-layout">
        {/* ===== 主栏：继续上次工作 + 访问记录 ===== */}
        <div className="rv2-main">
          {lastPage && lastEntry && (
            <div className="rv2-card rv2-continue">
              <div className="rv2-card-head">
                <span className="rv2-card-title">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                  {t('resumeWork')}
                </span>
                <span className="rv2-card-sub">{t('resumeDesc')}</span>
              </div>
              <Link className="rv2-continue-body" to={`/project/${lastPage.projectId}/page/${lastPage.id}`}>
                <span className="rv2-continue-thumb">
                  {designThumb ? (
                    <img src={designThumb} alt={lastPage.pageName} draggable={false} />
                  ) : (
                    <span className="rv2-thumb-placeholder">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <rect x="3" y="4" width="18" height="16" rx="2" />
                        <path d="m3 15 5-5 4 4 3-3 6 6" />
                      </svg>
                    </span>
                  )}
                  <span className="rv2-thumb-badge">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 7v5l3 2" />
                    </svg>
                    {t('lastVisit')}
                  </span>
                </span>
                <span className="rv2-continue-info">
                  <span className="rv2-continue-name">
                    {lastPage.pageName}
                    <i>·</i>
                    {projectName(lastPage.projectId)} / {folderName(lastPage.folderId) || t('ungrouped')}
                  </span>
                  <span className="rv2-continue-desc">
                    {lastPage.figmaUrl ? t('descWithFigma') : t('descWithoutFigma')}
                  </span>
                  <span className="rv2-continue-tags">
                    <PlatformBadge platform={lastPage.platform} />
                  </span>
                  <span className="rv2-continue-meta">
                    <span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7v5l3 2" />
                      </svg>
                      {t('lastVisit')} {timeAgo(lastEntry[1])}
                    </span>
                    <span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M3 6h18M3 12h18M3 18h12" />
                      </svg>
                      {t('visitRecordsCount', { count: lastVisitCount })}
                    </span>
                  </span>
                </span>
                <span className="rv2-continue-btn">
                  {t('continueView')}
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </span>
              </Link>
            </div>
          )}

          <div className="rv2-card">
            <div className="rv2-card-head">
              <span className="rv2-card-title">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
                {t('recentVisits')}
              </span>
              {/* 清空记录：紧跟标题右侧 */}
              <button
                type="button"
                className="rv2-clear-btn"
                onClick={() => void handleClear()}
                disabled={!visits.length}
                title={t('clearAllTitle')}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
                </svg>
                {t('clearVisits')}
              </button>
              <span className="rv2-card-sub">{t('totalCount', { count: visits.length })}</span>
              {/* 全部 / 项目 / 页面：与应用通用 Segmented 组件样式统一 */}
              <span className="segmented rv2-segment" role="group" aria-label={t('filterAriaLabel')}>
                {(
                  [
                    { key: 'all', label: t('tabAll') },
                    { key: 'project', label: t('tabProject') },
                    { key: 'page', label: t('tabPage') }
                  ] as { key: ListTab; label: string }[]
                ).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    className={`segment-item${listTab === tab.key ? ' active' : ''}`}
                    onClick={() => setListTab(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </span>
            </div>

            {listTab !== 'project' ? (
              <div className="rv2-table">
                <div className="rv2-table-head">
                  <span>{t('colProjectPage')}</span>
                  <span>{t('colPathDesc')}</span>
                  <span>{t('colDevice')}</span>
                  <span>{t('colTime')}</span>
                </div>
                {(() => {
                  const groups = GROUP_BUCKETS.map((b) => ({
                    ...b,
                    items: entries.filter(([, ts]) => bucketOf(ts) === b.key)
                  })).filter((g) => g.items.length > 0)
                  if (groups.length === 0) {
                    return (
                      <p className="rv2-empty">
                        {visits.length > 0 ? t('emptyDeleted') : t('emptyNoVisits')}
                      </p>
                    )
                  }
                  return groups.map((g) => (
                    <div key={g.key} className="rv2-group">
                      {renderGroupHead(g.key, g.items.length)}
                      {!collapsedGroups.has(g.key) &&
                        g.items.map(([pageId, ts]) => {
                          const pg = pageMap.get(pageId)!
                          const path = folderName(pg.folderId)
                            ? `${projectName(pg.projectId)} / ${folderName(pg.folderId)}`
                            : projectName(pg.projectId)
                          return (
                            <Link
                              key={pageId}
                              to={`/project/${pg.projectId}/page/${pg.id}`}
                              className="rv2-table-row"
                              title={pg.pageName}
                            >
                              <span className="rv2-cell-page">
                                <ProjectLogo project={projOf(pg.projectId, pg.pageName, [pg.platform])} size={34} />
                                <span className="rv2-cell-page-text">
                                  <b>{pg.pageName}</b>
                                </span>
                              </span>
                              <span className="rv2-cell-path">
                                <b>{path}</b>
                                <i>{pg.devUrl || pg.figmaUrl || '—'}</i>
                              </span>
                              <span className="rv2-cell-device">
                                <PlatformBadge platform={pg.platform} />
                              </span>
                              <span className="rv2-cell-time">{fmtVisitTime(ts)}</span>
                              {/* 删除记录：无独立操作列，悬停行时显示 */}
                              <span
                                role="button"
                                className="rv2-row-del"
                                title={t('deletePageVisit')}
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  void handleDeleteVisits(pg.id, pg.pageName)
                                }}
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                  <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
                                </svg>
                              </span>
                            </Link>
                          )
                        })}
                    </div>
                  ))
                })()}
              </div>
            ) : (
              <div className="rv2-table">
                <div className="rv2-table-head">
                  <span>{t('colProject')}</span>
                  <span>{t('colPageCount')}</span>
                  <span>{t('colVisitCount')}</span>
                  <span>{t('colLastVisit')}</span>
                </div>
                {(() => {
                  const groups = GROUP_BUCKETS.map((b) => ({
                    ...b,
                    items: projectGroups.filter((g) => bucketOf(g.latest) === b.key)
                  })).filter((g) => g.items.length > 0)
                  if (groups.length === 0) return <p className="rv2-empty">{t('emptyNoProjectVisits')}</p>
                  return groups.map((g) => (
                    <div key={g.key} className="rv2-group">
                      {renderGroupHead(g.key, g.items.length)}
                      {!collapsedGroups.has(g.key) &&
                        g.items.map((grp) => (
                          <Link key={grp.projectId} to={`/project/${grp.projectId}`} className="rv2-table-row">
                            <span className="rv2-cell-page">
                              <ProjectLogo project={projOf(grp.projectId, projectName(grp.projectId), ['pc'])} size={34} />
                              <span className="rv2-cell-page-text">
                                <b>{projectName(grp.projectId)}</b>
                              </span>
                            </span>
                            <span className="rv2-cell-path">
                              <b>{t('pageInCount', { count: grp.pageCount })}</b>
                            </span>
                            <span className="rv2-cell-device">{t('visitInCount', { count: grp.visitCount })}</span>
                            <span className="rv2-cell-time">{fmtVisitTime(grp.latest)}</span>
                          </Link>
                        ))}
                    </div>
                  ))
                })()}
              </div>
            )}
          </div>
        </div>

        {/* ===== 侧栏：常用工具 + 最近活动 ===== */}
        <aside className="rv2-side">
          <div className="rv2-card">
            <div className="rv2-card-head">
              <span className="rv2-card-title">{t('toolBox')}</span>
              <span className="rv2-card-more rv2-more-end" title={t('moreComingSoon')}>
                {t('more')}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </span>
            </div>
            <div className="rv2-tools">
              {QUICK_TOOLS.map((tool) => (
                <div key={tool.key} className="rv2-tool" title={t('featureComingSoon')}>
                  <span className={`rv2-tool-icon ${tool.key}`}>{tool.icon}</span>
                  <span className="rv2-tool-text">
                    <b>{t(tool.nameKey)}</b>
                    <i>{t(tool.subKey)}</i>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="rv2-card">
            <div className="rv2-card-head">
              <span className="rv2-card-title">{t('recentActivity')}</span>
            </div>
            {activityItems.length > 0 ? (
              <div className="rv2-activity">
                {activityItems.map((v) => {
                  const pg = pageMap.get(v.pageId)
                  if (!pg) return null
                  return (
                    <Link
                      key={v.id}
                      to={`/project/${v.projectId}/page/${v.pageId}`}
                      className="rv2-activity-item"
                    >
                      <span className={`rv2-activity-dot ${pg.platform}`} />
                      <span className="rv2-activity-body">
                        <b>{t('visitedPage', { name: pg.pageName })}</b>
                        <i>
                          {timeAgo(v.visitedAt)} · {t(`platform_${pg.platform}`)}
                        </i>
                      </span>
                    </Link>
                  )
                })}
              </div>
            ) : (
              <p className="rv2-empty">{t('noActivity')}</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
