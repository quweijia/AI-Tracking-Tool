import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { db, ReportRecord, Project, WalkthroughPage } from '../db'
import { productDb, ProductProject, ProductAnnotationSet } from '../db/product'
import { useProductModeStore } from '../stores/productMode'
import USelect from '../components/USelect'
import heroBannerArtUrl from '../assets/hero-banner-re.png'
import heroBannerArtDarkUrl from '../assets/hero-banner-re-dark.png'

/** 报告记录打开提示（按打开方式给出结果反馈） */
type OpenMsg = { type: 'ok' | 'error'; text: string } | null

/** 报告版本分组：同一页面的多次导出聚合为一组，旧→新编号 V1..Vn */
interface ReportGroup {
  key: string
  projectId: string
  pageId: string
  pageName: string
  /** 版本列表（新→旧排列，ver = 1 为最早导出） */
  versions: (ReportRecord & { ver: number })[]
  latestAt: number
  totalIssues: number
}

type ViewMode = 'list' | 'grid'
/** 分页每页条数选项 */
const PAGE_SIZES = [8, 16, 32]

/** 横幅功能点图标（圆形渐变底，线性白色图形） */
function HeroFeatIcon({ kind }: { kind: 'analyze' | 'locate' | 'advice' }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  switch (kind) {
    case 'analyze':
      return (
        <svg {...common}>
          <path d="M12 3a9 9 0 1 0 9 9h-9V3Z" />
          <path d="M15 3.5A9 9 0 0 1 20.5 9H15V3.5Z" />
        </svg>
      )
    case 'locate':
      return (
        <svg {...common}>
          <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z" />
          <circle cx="12" cy="10" r="2.5" />
        </svg>
      )
    case 'advice':
      return (
        <svg {...common}>
          <path d="M14.5 6.5a4 4 0 0 0-5.6 5L3 17.4V21h3.6l5.9-5.9a4 4 0 0 0 5-5.6L14 13l-3-3 3.5-3.5Z" />
        </svg>
      )
  }
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

const fmtTime = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false })

/**
 * 分析报告页：顶部横幅 + 报告列表（原型样式）。
 * 同一页面的多次导出按版本归组：列表视图组行展示最新版本摘要、可展开历史版本行；网格视图展示组卡片。
 * 支持项目筛选、关键词搜索（页面/项目/文件名）、列表与网格双视图、分页。
 * 打开方式跟随浏览器管理页「AI 任务默认浏览器」的设置。
 */
export default function ReportsPage() {
  const { t } = useTranslation('reportsPage')
  const productMode = useProductModeStore((s) => s.enabled)
  /** 产品项目 ID 集合：产品导出与走查导出共用 reportRecords 表，按模式分离显示（互不泄漏） */
  const productProjectIds =
    useLiveQuery(async () => new Set((await productDb.projects.toArray()).map((p) => p.id)), []) ?? new Set<string>()
  const records = useLiveQuery(
    async () =>
      (
        await db.reportRecords.filter((r) => r.type === 'html' && !r.deletedAt).toArray()
      ).filter((r) => productProjectIds.has(r.projectId) === productMode),
    [productMode, productProjectIds]
  )
  const walkProjects =
    useLiveQuery(() => (productMode ? Promise.resolve<Project[]>([]) : db.projects.toArray()), [productMode]) ?? []
  const productProjects =
    useLiveQuery(() => (productMode ? productDb.projects.toArray() : Promise.resolve<ProductProject[]>([])), [productMode]) ?? []
  // 产品标注集：产品报告为项目级，组行项目名后逐个列出标注集链接（点击进入标注画布）
  const productSets =
    useLiveQuery(
      () => (productMode ? productDb.sets.toArray() : Promise.resolve<ProductAnnotationSet[]>([])),
      [productMode]
    ) ?? []
  const projects = productMode ? productProjects : walkProjects
  const pages =
    useLiveQuery(() => (productMode ? Promise.resolve<WalkthroughPage[]>([]) : db.pages.toArray()), [productMode]) ?? []
  const [browserMode, setBrowserMode] = useState<'builtin' | 'system'>('builtin')
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [msg, setMsg] = useState<OpenMsg>(null)
  /** 项目筛选：all / projectId */
  const [projectFilter, setProjectFilter] = useState<string>('all')
  /** 关键词搜索（页面名 / 项目名 / 报告文件名） */
  const [keyword, setKeyword] = useState('')
  /** 视图模式：列表 / 网格 */
  const [view, setView] = useState<ViewMode>('list')
  /** 展开的分组 key 集合（默认全部收起，仅展示组摘要） */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** 分页 */
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])

  // 读取浏览器管理页的「AI 任务默认浏览器」设置
  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      setBrowserMode((cfg['aiDefaultBrowser'] as string | undefined) === 'system' ? 'system' : 'builtin')
    })
  }, [])

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? t('unknownProject')

  /** 按「项目 + 页面」聚合为版本组；组按最新导出时间倒序 */
  const groups = useMemo<ReportGroup[]>(() => {
    const map = new Map<string, ReportRecord[]>()
    ;[...(records ?? [])]
      .sort((a, b) => a.createdAt - b.createdAt)
      .forEach((r) => {
        const k = `${r.projectId}|${r.pageId}`
        const list = map.get(k)
        if (list) list.push(r)
        else map.set(k, [r])
      })
    return [...map.entries()].map(([key, list]) => {
      const versions = list.map((r, i) => ({ ...r, ver: i + 1 })).reverse()
      return {
        key,
        projectId: list[0].projectId,
        pageId: list[0].pageId,
        // 组名：走查取页面名；产品按记录 pageId 取标注集（页面）名，旧记录无 setId 回退项目名
        pageName: productMode
          ? (list[0].pageId
              ? (productSets.find((s) => s.id === list[0].pageId)?.name ?? t('pageDeleted'))
              : (productProjects.find((p) => p.id === list[0].projectId)?.name ?? t('unknownProject')))
          : (pages.find((p) => p.id === list[0].pageId)?.pageName ?? t('pageDeleted')),
        versions,
        latestAt: list[list.length - 1].createdAt,
        totalIssues: versions.reduce((s, v) => s + v.total, 0)
      }
    }).sort((a, b) => b.latestAt - a.latestAt)
  }, [records, pages, productMode, productProjects, productSets, t])

  /** 项目筛选（有记录的项目才出现在下拉里，按名称排序） */
  const projectOptions = useMemo(() => {
    const ids = new Set((records ?? []).map((r) => r.projectId))
    return projects
      .filter((p) => ids.has(p.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }, [records, projects])

  /** 筛选 + 搜索 */
  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    return groups.filter((g) => {
      if (projectFilter !== 'all' && g.projectId !== projectFilter) return false
      if (k) {
        const hit =
          g.pageName.toLowerCase().includes(k) ||
          projectName(g.projectId).toLowerCase().includes(k) ||
          g.versions.some((v) => (v.name || '').toLowerCase().includes(k))
        if (!hit) return false
      }
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, projectFilter, keyword, projects])

  /** 分页（组维度） */
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageGroups = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)
  const pageNums = Array.from({ length: totalPages }, (_, i) => i + 1)

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  /** 打开报告：内置浏览器（弹窗）或系统浏览器；旧记录无 filePath 时提示重新导出 */
  const openReport = async (rec: ReportRecord) => {
    if (!rec.filePath || openingId) return
    setOpeningId(rec.id)
    setMsg(null)
    try {
      const res =
        browserMode === 'system'
          ? await window.electronAPI.openReportSystem(rec.filePath)
          : await window.electronAPI.openReportBuiltin(rec.filePath)
      setMsg(
        res.ok
          ? { type: 'ok', text: browserMode === 'system' ? t('openedInSystem') : t('openedInBuiltin') }
          : { type: 'error', text: res.message || t('openFailed') }
      )
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setOpeningId(null)
    }
  }

  /** 列表视图单个版本组：组行点击展开/收起历史版本，版本行点击打开报告 */
  const renderGroup = (g: ReportGroup) => {
    const open = expanded.has(g.key)
    const latest = g.versions[0]
    const pg = pages.find((p) => p.id === g.pageId)
    const accepted = !!pg?.accepted
    return (
      <div key={g.key} className="reports-group-wrap">
        <div
          className={`rv2-table-row reports-row group${open ? ' open' : ''}`}
          role="button"
          tabIndex={0}
          title={open ? t('collapseVersionsTip') : t('expandVersionsTip')}
          onClick={() => toggle(g.key)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              toggle(g.key)
            }
          }}
        >
          <span className="reports-cell-name">
            <span className="reports-name-text">
              <b>
                {g.pageName}
                <em className="count count-accent reports-ver-count">{t('versionCount', { n: g.versions.length })}</em>
              </b>
            </span>
          </span>
          <span className="reports-cell-pp">
            {productMode ? (
              // 产品：仅显示页面（标注集）链接
              g.pageId && productSets.some((s) => s.id === g.pageId) ? (
                <Link to={`/product/${g.projectId}/set/${g.pageId}`}>{g.pageName}</Link>
              ) : (
                t('pageDeleted')
              )
            ) : (
              <>
                {projectName(g.projectId)} · {pg ? <Link to={`/project/${g.projectId}/page/${pg.id}`}>{g.pageName}</Link> : t('pageDeleted')}
              </>
            )}
          </span>
          <span className="reports-cell-issues">{latest.total}</span>
          <span className="rv2-cell-time">{fmtTime(latest.createdAt)}</span>
          <span className="reports-cell-status">
            {productMode ? (
              '—'
            ) : (
              <span className={`badge ${accepted ? 'badge-success' : 'badge-accent'} badge-lg`}>
                {accepted ? t('statusDone') : t('statusDoing')}
              </span>
            )}
          </span>
        </div>

        {/* 版本行（展开时显示，新→旧，最新导出在最上；点击整行打开该版本） */}
        {open && (
          <div className="reports-ver-list">
            {g.versions.map((v, vi) => (
              <div
                key={v.id}
                className="rv2-table-row reports-row ver"
                role="button"
                tabIndex={0}
                title={v.filePath ? t('openVersionTip') : t('versionNoPathTip')}
                onClick={() => void openReport(v)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    void openReport(v)
                  }
                }}
              >
                <span className="reports-cell-name">
                  <span className={`badge badge-accent reports-ver-badge${vi === 0 ? ' latest' : ''}`}>
                    {vi === 0 ? t('latest') : `V${v.ver}`}
                  </span>
                  <span className="reports-name-text">
                    <b>{v.name || t('versionNameFallback', { n: v.ver })}</b>
                  </span>
                </span>
                <span className="reports-cell-issues">{v.total}</span>
                <span className="rv2-cell-time">{fmtTime(v.createdAt)}</span>
                <span className="reports-cell-status">
                  {productMode ? (
                    '—'
                  ) : (
                    <span className={`badge ${accepted ? 'badge-success' : 'badge-accent'} badge-lg`}>
                      {accepted ? t('statusDone') : t('statusDoing')}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="page reports-v2">
      {/* ===== 顶部横幅（原型样式，与最近访问横幅同风格） ===== */}
      <div className="rv2-hero reports-hero">
        <div className="rv2-hero-main">
          <h1 className="rv2-title">{t(productMode ? 'heroTitleProduct' : 'heroTitle')}</h1>
          <p className="rv2-desc">{t(productMode ? 'heroDescProduct' : 'heroDesc')}</p>
          <div className="rv2-feats">
            <span className="rv2-feat">
              <span className="rv2-feat-icon blue">
                <HeroFeatIcon kind="analyze" />
              </span>
              <span>
                <b>{t('featAnalyzeTitle')}</b>
                <i>{t('featAnalyzeDesc')}</i>
              </span>
            </span>
            <span className="rv2-feat">
              <span className="rv2-feat-icon purple">
                <HeroFeatIcon kind="locate" />
              </span>
              <span>
                <b>{t('featLocateTitle')}</b>
                <i>{t('featLocateDesc')}</i>
              </span>
            </span>
            <span className="rv2-feat">
              <span className="rv2-feat-icon cyan">
                <HeroFeatIcon kind="advice" />
              </span>
              <span>
                <b>{t('featAdviceTitle')}</b>
                <i>{t('featAdviceDesc')}</i>
              </span>
            </span>
          </div>
        </div>
        {/* AI 插图：absolute 贴横幅右缘，高度上下填满、尺寸固定（缩窗不缩放）；深色模式换深色版 */}
        <img className="rv2-hero-art" src={heroBannerArtUrl} alt={t('heroArtAlt')} draggable={false} />
        <img className="rv2-hero-art-dark" src={heroBannerArtDarkUrl} alt="" draggable={false} />
      </div>

      {/* ===== 报告列表卡片 ===== */}
      <div className="card reports-card">
        {/* 工具栏：项目筛选（与设置页语言下拉同款 USelect）+ 搜索 + 视图切换 */}
        <div className="reports-toolbar">
          <USelect
            className="reports-project-select"
            value={projectFilter}
            onChange={(v) => {
              setProjectFilter(v)
              setPage(1)
            }}
            title={t('filterByProjectTitle')}
            options={[
              { value: 'all', label: t('allProjects') },
              ...projectOptions.map((p) => ({ value: p.id, label: p.name }))
            ]}
          />
          <div className="reports-toolbar-right">
            <label className="reports-search">
              <SearchIcon />
              <input
                type="text"
                value={keyword}
                placeholder={t('searchPlaceholder')}
                onChange={(e) => {
                  setKeyword(e.target.value)
                  setPage(1)
                }}
              />
            </label>
            {/* 网格/列表切换：与项目列表页同款组件 */}
            <div className="tabs tabs--icon" role="group" aria-label={t('toggleView')}>
              <button
                type="button"
                className={`tabs-item ${view === 'grid' ? 'active' : ''}`}
                title={t('gridView')}
                onClick={() => setView('grid')}
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
                className={`tabs-item ${view === 'list' ? 'active' : ''}`}
                title={t('listView')}
                onClick={() => setView('list')}
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

        {view === 'list' ? (
          /* ---- 列表视图：组行（点击整行展开/收起历史版本，版本行点击打开报告） ---- */
          <div className="reports-table">
            <div className="rv2-table-head">
              <span>{t('colName')}</span>
              <span>{productMode ? t('colPage') : t('colProjectPage')}</span>
              <span>{t('colIssueCount')}</span>
              <span>{t('colTime')}</span>
              <span>{t('colStatus')}</span>
            </div>
            {pageGroups.length > 0 ? (
              pageGroups.map(renderGroup)
            ) : (
              <p className="rv2-empty">
                {groups.length === 0
                  ? t('emptyAll')
                  : t('emptyFiltered')}
              </p>
            )}
          </div>
        ) : (
          /* ---- 网格视图：组卡片 ---- */
          pageGroups.length > 0 ? (
            <div className="reports-grid">
              {pageGroups.map((g) => {
                const latest = g.versions[0]
                return (
                  <div key={g.key} className="reports-grid-item">
                    <div className="reports-grid-head">
                      <div className="reports-grid-title">
                        <b title={g.pageName}>{g.pageName}</b>
                        <i>
                          {/* 产品模式仅显示版本数 */}
                          {productMode ? t('versionCount', { n: g.versions.length }) : (
                            <>{projectName(g.projectId)} · {t('versionCount', { n: g.versions.length })}</>
                          )}
                        </i>
                      </div>
                      {productMode ? (
                        <span>—</span>
                      ) : (
                        <span className={`badge ${pages.find((p) => p.id === g.pageId)?.accepted ? 'badge-success' : 'badge-accent'} badge-lg`}>
                          {pages.find((p) => p.id === g.pageId)?.accepted ? t('statusDone') : t('statusDoing')}
                        </span>
                      )}
                    </div>
                    <div className="reports-grid-meta">
                      <span className="reports-cell-issues">
                        {latest.total} <i>{t('issueUnit')}</i>
                      </span>
                      <span className="rv2-cell-time">{fmtTime(latest.createdAt)}</span>
                    </div>
                    <div className="reports-grid-foot">
                      {latest.filePath ? (
                        <button
                          type="button"
                          className="rv2-row-open"
                          disabled={openingId === latest.id}
                          onClick={() => void openReport(latest)}
                        >
                          {openingId === latest.id ? t('opening') : t('view')}
                        </button>
                      ) : (
                        <span className="reports-no-path">{t('pathMissing')}</span>
                      )}
                      <button type="button" className="reports-grid-expand" onClick={() => toggle(g.key)}>
                        {expanded.has(g.key) ? t('collapseVersions') : t('historyVersions', { n: g.versions.length - 1 })}
                      </button>
                    </div>
                    {expanded.has(g.key) && (
                      <div className="reports-grid-vers">
                        {g.versions.map((v, vi) => (
                          <button
                            key={v.id}
                            type="button"
                            className="reports-grid-ver"
                            disabled={!v.filePath || openingId === v.id}
                            title={v.filePath ? t('openVerTip') : t('versionNoPathReexport')}
                            onClick={() => void openReport(v)}
                          >
                            <span className={`badge badge-accent reports-ver-badge${vi === 0 ? ' latest' : ''}`}>
                              {vi === 0 ? t('latest') : `V${v.ver}`}
                            </span>
                            <i>{fmtTime(v.createdAt)}</i>
                            <b>{t('issueCountShort', { n: v.total })}</b>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="rv2-empty">
              {groups.length === 0
                ? t('emptyAll')
                : t('emptyFiltered')}
            </p>
          )
        )}

        {/* 分页 */}
        {filtered.length > 0 && (
          <div className="reports-pagination">
            <span className="reports-page-total">{t('totalGroups', { n: filtered.length })}</span>
            <div className="reports-page-nav">
              <button type="button" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} aria-label={t('prevPage')}>
                ‹
              </button>
              {pageNums.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={n === safePage ? 'active' : ''}
                  onClick={() => setPage(n)}
                >
                  {n}
                </button>
              ))}
              <button
                type="button"
                disabled={safePage >= totalPages}
                onClick={() => setPage(safePage + 1)}
                aria-label={t('nextPage')}
              >
                ›
              </button>
            </div>
            {/* 每页条数：与应用统一下拉组件 USelect 保持一致样式 */}
            <span className="reports-page-size">
              <USelect
                value={String(pageSize)}
                onChange={(v) => {
                  setPageSize(Number(v))
                  setPage(1)
                }}
                title={t('pageSizeLabel')}
                options={PAGE_SIZES.map((n) => ({ value: String(n), label: t('groupsPerPage', { n }) }))}
              />
            </span>
          </div>
        )}
        {msg && <p className={`export-result ${msg.type}`}>{msg.text}</p>}
      </div>
    </div>
  )
}
