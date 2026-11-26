import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  permanentlyDeleteWalkFolders,
  permanentlyDeleteWalkPages,
  permanentlyDeleteWalkProjects,
  permanentlyDeleteReports,
  getWalkTrashRows,
  getWalkTrashReports,
  restoreWalkFolders,
  restoreWalkPages,
  restoreWalkProjects,
  restoreWalkReports,
  type TrashKind,
  type TrashRow
} from '../db'
import { purgeExpiredTrash, readTrashRetentionDays } from '../db/trashCleanup'
import {
  permanentlyDeleteProductFolders,
  permanentlyDeleteProductProjects,
  permanentlyDeleteProductSets,
  getProductTrashRows,
  getProductTrashReports,
  restoreProductFolders,
  restoreProductProjects,
  restoreProductSets,
  restoreProductReports
} from '../db/product'
import { confirmDialog } from '../components/ConfirmDialog'
import { showToast } from '../components/Toast'
import { useProductModeStore } from '../stores/productMode'
import heroBannerArtUrl from '../assets/hero-banner-hsz.png'
import heroBannerArtDarkUrl from '../assets/hero-banner-hsz-dark.png'

type TrashFilter = 'all' | TrashKind

/** 「全部」/「报告」tab 树节点：回收站软删记录按 项目 → 文件夹 → 页面 层级组织（与项目列表一致）；
 *  同一页面软删的多份报告折叠为一个组节点（groupRows 携带组内全部报告行） */
interface TrashNode {
  row: TrashRow
  children: TrashNode[]
  groupRows?: TrashRow[]
}

/** 类型图标（项目 / 文件夹 / 页面 / 报告），与现有列表内联 SVG 风格一致 */
function KindIcon({ kind }: { kind: TrashKind }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true
  } as const
  if (kind === 'project') {
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7 9h10M7 13h6" />
      </svg>
    )
  }
  if (kind === 'folder') {
    return (
      <svg {...common}>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      </svg>
    )
  }
  if (kind === 'report') {
    return (
      <svg {...common}>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5M9 13h6M9 17h4" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  )
}

/** 按模式分发还原操作（走查/产品两库严格隔离，还原前再次校验 deletedInMode） */
async function restoreByMode(productMode: boolean, kind: TrashKind, id: string) {
  if (productMode) {
    if (kind === 'project') return restoreProductProjects([id])
    if (kind === 'folder') return restoreProductFolders([id])
    if (kind === 'report') return restoreProductReports([id])
    return restoreProductSets([id])
  }
  if (kind === 'project') return restoreWalkProjects([id])
  if (kind === 'folder') return restoreWalkFolders([id])
  if (kind === 'report') return restoreWalkReports([id])
  return restoreWalkPages([id])
}

/** 按模式分发彻底删除操作（仅处理已软删记录） */
async function purgeByMode(productMode: boolean, rows: TrashRow[]) {
  const idsOf = (kind: TrashKind) => rows.filter((r) => r.kind === kind).map((r) => r.id)
  let ok = 0
  let failed = 0
  const merge = (r: { ok: number; failed: number }) => {
    ok += r.ok
    failed += r.failed
  }
  // 报告存于 walk 库 reportRecords 表（两模式共用），彻底删除不分模式
  const rep = idsOf('report')
  if (rep.length) merge(await permanentlyDeleteReports(rep))
  if (productMode) {
    const p = idsOf('project')
    const f = idsOf('folder')
    const s = idsOf('page')
    if (p.length) merge(await permanentlyDeleteProductProjects(p))
    if (f.length) merge(await permanentlyDeleteProductFolders(f))
    if (s.length) merge(await permanentlyDeleteProductSets(s))
  } else {
    const p = idsOf('project')
    const f = idsOf('folder')
    const g = idsOf('page')
    if (p.length) merge(await permanentlyDeleteWalkProjects(p))
    if (f.length) merge(await permanentlyDeleteWalkFolders(f))
    if (g.length) merge(await permanentlyDeleteWalkPages(g))
  }
  return { ok, failed }
}

/** 横幅功能点图标（圆形渐变底，线性白色图形），与分析报告页 HeroFeatIcon 同款规格 */
function TrashHeroFeatIcon({ kind }: { kind: 'restore' | 'retention' | 'purge' }) {
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
  if (kind === 'restore') {
    return (
      <svg {...common}>
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5" />
      </svg>
    )
  }
  if (kind === 'retention') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

export default function TrashPage() {
  const { t } = useTranslation('trashPage')
  const productMode = useProductModeStore((s) => s.enabled)
  const [rows, setRows] = useState<TrashRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<TrashFilter>('all')
  const [busy, setBusy] = useState(false)
  /** 保留天数（config.trashRetentionDays，未配置回退 30），剩余天数展示与过期判定同源 */
  const [retentionDays, setRetentionDays] = useState(30)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // 打开回收站即触发保留期扫描：过期项静默彻底删除（含孤儿文件回收），失败仅日志不打扰
      setRetentionDays(await readTrashRetentionDays())
      await purgeExpiredTrash()
      const data = productMode
        ? [...(await getProductTrashRows()), ...(await getProductTrashReports())]
        : [...(await getWalkTrashRows()), ...(await getWalkTrashReports())]
      setRows(data.sort((a, b) => b.deletedAt - a.deletedAt))
    } catch (err) {
      console.warn('[TRASH] 读取回收站失败:', err)
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [productMode])

  useEffect(() => {
    void load()
  }, [load])

  const visible = useMemo(
    () => (filter === 'all' ? rows : rows.filter((r) => r.kind === filter)),
    [rows, filter]
  )
  const totals = useMemo(
    () => ({
      count: rows.length,
      objects: rows.reduce((s, r) => s + r.objects, 0),
      attachments: rows.reduce((s, r) => s + r.attachments, 0)
    }),
    [rows]
  )

  /** 同一页面软删的多份报告折叠为一组（≥2 条才成组，按 parentId=页面/标注集 id 分组）；
   *  组内按删除时间倒序，组代表行显示页面名 */
  const reportGroups = useMemo(() => {
    const byParent = new Map<string, TrashRow[]>()
    for (const r of rows) {
      if (r.kind !== 'report' || !r.parentId) continue
      const arr = byParent.get(r.parentId)
      if (arr) arr.push(r)
      else byParent.set(r.parentId, [r])
    }
    const groups = new Map<string, TrashRow[]>()
    for (const [pid, rs] of byParent) {
      if (rs.length > 1) groups.set(pid, rs.sort((a, b) => b.deletedAt - a.deletedAt))
    }
    return groups
  }, [rows])
  const groupedReportIds = useMemo(
    () => new Set([...reportGroups.values()].flat().map((r) => r.id)),
    [reportGroups]
  )
  /** 组代表行（显示用）：名称取原位置末段（页面名/标注集名），时间与剩余天数取组内最新删除记录 */
  const groupHeadOf = useCallback(
    (pid: string): TrashRow => {
      const rs = reportGroups.get(pid)!
      const head = rs[0]
      const lastLoc = head.locationPath[head.locationPath.length - 1]
      return { ...head, id: `grp-${pid}`, name: lastLoc || head.name }
    },
    [reportGroups]
  )

  const handleRestore = async (targets: TrashRow[]) => {
    if (busy || targets.length === 0) return
    setBusy(true)
    try {
      let ok = 0
      let toRoot = 0
      let failed = 0
      for (const row of targets) {
        const res = await restoreByMode(productMode, row.kind, row.id)
        ok += res.ok
        toRoot += res.toRoot
        failed += res.failed
      }
      if (ok > 0) {
        showToast(toRoot > 0 ? t('restoredToRoot') : t('restored'), { tone: 'success' })
      } else if (failed > 0) {
        showToast(t('restoreFailed'), { tone: 'danger' })
      }
      await load()
    } catch (err) {
      console.warn('[TRASH] 还原操作失败:', err)
      showToast(t('restoreFailed'), { tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const handlePurge = async (targets: TrashRow[]) => {
    if (busy || targets.length === 0) return
    const objects = targets.reduce((s, r) => s + r.objects, 0)
    const attachments = targets.reduce((s, r) => s + r.attachments, 0)
    const single = targets.length === 1
    const ok = await confirmDialog({
      title: single ? t('confirmHardTitle') : t('confirmEmptyTitle'),
      message: single
        ? t('confirmHardMsg', { objects, attachments })
        : t('confirmEmptyMsg', { count: targets.length, objects, attachments }),
      tone: 'danger'
    })
    if (!ok) return
    setBusy(true)
    try {
      const res = await purgeByMode(productMode, targets)
      if (res.failed > 0) {
        showToast(t('purgeFailed'), { tone: 'danger' })
      } else {
        showToast(single ? t('purged') : t('purgedAll'), { tone: 'success' })
      }
      await load()
    } catch (err) {
      console.warn('[TRASH] 彻底删除操作失败:', err)
      showToast(t('purgeFailed'), { tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const now = Date.now()
  const fmtDate = (ts: number) => new Date(ts).toLocaleString()

  /** 折叠的节点 key（默认全部展开，与项目列表展开态一致；key = `${kind}-${id}`） */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleCollapse = (k: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  /** 「全部」tab：项目 → 文件夹 → 页面 →（报告组）树形层级。父级也在回收站 → 挂其下
   *  （报告的 parentId 为所属页面 id，页面在回收站时挂为页面子级）；
   *  父级未删/已彻底删除 → 上浮到所属项目；项目也不在 → 顶层散件（行内保留原位置路径）。
   *  同一页面多份报告折叠为一个组节点整体参与挂树 */
  const tree = useMemo<TrashNode[] | null>(() => {
    if (filter !== 'all') return null
    const roots: TrashNode[] = []
    const nodeOf = new Map<string, TrashNode>(rows.map((r) => [`${r.kind}-${r.id}`, { row: r, children: [] }]))
    for (const [pid, rs] of reportGroups) {
      nodeOf.set(`report-grp-${pid}`, {
        row: groupHeadOf(pid),
        children: rs.map((r) => ({ row: r, children: [] as TrashNode[] })),
        groupRows: rs
      })
    }
    const attach = (node: TrashNode, parentId: string | null | undefined, projectId: string | null | undefined) => {
      const parent =
        (parentId
          ? (nodeOf.get(`folder-${parentId}`) ?? nodeOf.get(`page-${parentId}`))
          : undefined) ?? (projectId ? nodeOf.get(`project-${projectId}`) : undefined)
      if (parent) parent.children.push(node)
      else roots.push(node)
    }
    for (const r of rows) {
      if (r.kind === 'project') continue
      if (r.kind === 'report' && groupedReportIds.has(r.id)) continue // 已折叠进组节点
      attach(nodeOf.get(`${r.kind}-${r.id}`)!, r.parentId, r.projectId)
    }
    for (const [pid, rs] of reportGroups) attach(nodeOf.get(`report-grp-${pid}`)!, pid, rs[0].projectId)
    for (const r of rows) if (r.kind === 'project') roots.push(nodeOf.get(`project-${r.id}`)!)
    const byDeleted = (a: TrashNode, b: TrashNode) => a.row.deletedAt - b.row.deletedAt || a.row.name.localeCompare(b.row.name)
    const sortRec = (list: TrashNode[]) => {
      list.sort(byDeleted)
      list.forEach((n) => sortRec(n.children))
    }
    sortRec(roots)
    return roots
  }, [rows, filter, reportGroups, groupedReportIds, groupHeadOf])

  /** 「文件夹」tab：上级文件夹也在回收站时挂为其子级（按层级展示，可展开折叠），
   *  上级未删/已彻底删除 → 顶层散件（行内保留原位置路径） */
  const folderTree = useMemo<TrashNode[] | null>(() => {
    if (filter !== 'folder') return null
    const nodeOf = new Map<string, TrashNode>(
      rows.filter((r) => r.kind === 'folder').map((r) => [`${r.kind}-${r.id}`, { row: r, children: [] as TrashNode[] }])
    )
    const roots: TrashNode[] = []
    for (const r of rows) {
      if (r.kind !== 'folder') continue
      const node = nodeOf.get(`folder-${r.id}`)!
      const parent = r.parentId ? nodeOf.get(`folder-${r.parentId}`) : undefined
      if (parent) parent.children.push(node)
      else roots.push(node)
    }
    const byDeletedDesc = (a: TrashNode, b: TrashNode) => b.row.deletedAt - a.row.deletedAt
    const sortRec = (list: TrashNode[]) => {
      list.sort(byDeletedDesc)
      list.forEach((n) => sortRec(n.children))
    }
    sortRec(roots)
    return roots
  }, [filter, rows])

  /** 「报告」tab：同一页面多份报告折叠为组节点（可展开查看各份报告），单份报告正常一行 */
  const reportTree = useMemo<TrashNode[] | null>(() => {
    if (filter !== 'report') return null
    const singles = rows
      .filter((r) => r.kind === 'report' && !groupedReportIds.has(r.id))
      .map((r) => ({ row: r, children: [] as TrashNode[] }))
    const groupNodes = [...reportGroups.entries()].map(([pid, rs]) => ({
      row: groupHeadOf(pid),
      children: rs.map((r) => ({ row: r, children: [] as TrashNode[] })),
      groupRows: rs
    }))
    return [...groupNodes, ...singles].sort((a, b) => b.row.deletedAt - a.row.deletedAt)
  }, [filter, rows, reportGroups, groupedReportIds, groupHeadOf])

  const filters: { key: TrashFilter; label: string }[] = [
    { key: 'all', label: t('filterAll') },
    { key: 'project', label: t('typeProject') },
    { key: 'folder', label: t('typeFolder') },
    { key: 'page', label: t('typePage') },
    { key: 'report', label: t('typeReport') }
  ]

  /** 行内容（扁平与树形共用）：caret 有值时行首渲染展开/折叠箭头（树形父节点）；
   *  groupRows 有值时为报告组行——路径行显示「共 N 份报告」，还原/彻底删除作用于整组 */
  const renderRow = (
    row: TrashRow,
    caret?: { open: boolean; onToggle: () => void },
    showPath = true,
    groupRows?: TrashRow[]
  ) => {
    const daysLeft = Math.max(0, retentionDays - Math.floor((now - row.deletedAt) / 86400000))
    return (
      <>
        {caret ? (
          <button
            type="button"
            className={`trash-caret${caret.open ? ' open' : ''}`}
            onClick={caret.onToggle}
            aria-expanded={caret.open}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        ) : (
          <span className="trash-caret-spacer" />
        )}
        <span className={`trash-kind trash-kind-${row.kind}`}>
          <KindIcon kind={row.kind} />
        </span>
        <div className="trash-info">
          <div className="trash-name">{row.name}</div>
          {showPath && (
            <div className="trash-path">
              {groupRows
                ? t('reportGroupSummary', { n: groupRows.length })
                : row.locationPath.length > 0
                  ? row.locationPath.join(' / ')
                  : t('locationRoot')}
            </div>
          )}
        </div>
        <span className={`badge badge-warning ${daysLeft <= 3 ? 'badge-danger' : ''}`}>
          {daysLeft > 0 ? t('daysLeft', { n: daysLeft }) : t('expiringToday')}
        </span>
        <span className="trash-time">{fmtDate(row.deletedAt)}</span>
        {/* 行操作：icon 按钮（hover 行时淡入显示），title 复用现有 restore/hardDelete 文案 */}
        <div className="trash-actions">
          <button
            type="button"
            className="trash-icon-btn"
            disabled={busy}
            onClick={() => void handleRestore(groupRows ?? [row])}
            title={t('restore')}
            aria-label={t('restore')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
          <button
            type="button"
            className="trash-icon-btn danger"
            disabled={busy}
            onClick={() => void handlePurge(groupRows ?? [row])}
            title={t('hardDelete')}
            aria-label={t('hardDelete')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
            </svg>
          </button>
        </div>
      </>
    )
  }

  /** 树形渲染：「全部」tab 项目行展开后显示子文件夹/页面/报告组，「报告」tab 组行展开后
   *  显示各份报告；子级始终挂载，靠 grid 0fr→1fr 过渡实现展开/折叠动画 */
  const renderNode = (node: TrashNode, depth: number) => {
    const k = `${node.row.kind}-${node.row.id}`
    const hasChildren = node.children.length > 0
    const open = !collapsed.has(k)
    return (
      <div key={k} className={depth > 0 ? 'trash-tree-child' : undefined}>
        <div className="trash-row">
          {renderRow(node.row, hasChildren ? { open, onToggle: () => toggleCollapse(k) } : undefined, true, node.groupRows)}
        </div>
        {hasChildren && (
          <div className={`trash-tree-children${open ? '' : ' closed'}`}>
            <div className="trash-tree-children-inner">
              {node.children.map((c) => renderNode(c, depth + 1))}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="page trash-page">
      {/* ===== 顶部横幅（与最近访问 / 分析报告横幅同风格） ===== */}
      <div className="rv2-hero reports-hero">
        <div className="rv2-hero-main">
          <h1 className="rv2-title">{t('title')}</h1>
          <p className="rv2-desc">{t('heroDesc')}</p>
          <div className="rv2-feats">
            <span className="rv2-feat">
              <span className="rv2-feat-icon blue">
                <TrashHeroFeatIcon kind="restore" />
              </span>
              <span>
                <b>{t('featRestoreTitle')}</b>
                <i>{t('featRestoreDesc')}</i>
              </span>
            </span>
            <span className="rv2-feat">
              <span className="rv2-feat-icon purple">
                <TrashHeroFeatIcon kind="retention" />
              </span>
              <span>
                <b>{t('featRetentionTitle')}</b>
                <i>{t('featRetentionDesc')}</i>
              </span>
            </span>
            <span className="rv2-feat">
              <span className="rv2-feat-icon cyan">
                <TrashHeroFeatIcon kind="purge" />
              </span>
              <span>
                <b>{t('featPurgeTitle')}</b>
                <i>{t('featPurgeDesc')}</i>
              </span>
            </span>
          </div>
        </div>
        {/* AI 插图：与分析报告页共用素材，深浅色主题各一版 */}
        <img className="rv2-hero-art" src={heroBannerArtUrl} alt="" draggable={false} />
        <img className="rv2-hero-art-dark" src={heroBannerArtDarkUrl} alt="" draggable={false} />
      </div>

      <div className="page-header trash-header">
        <div className="trash-toolbar">
          {/* 全部 / 项目 / 文件夹 / 页面 / 报告：与应用通用 Segmented 组件样式统一 */}
          <span className="segmented" role="group" aria-label={t('filterAriaLabel')}>
            {filters.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`segment-item${filter === f.key ? ' active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </span>
          {/* 全部清空：复用最近访问「清空记录」按钮样式（rv2-clear-btn），灰字 hover 变红 */}
          {rows.length > 0 && (
            <button
              type="button"
              className="rv2-clear-btn"
              disabled={busy}
              onClick={() => void handlePurge(rows)}
              title={t('hardDeleteAllTitle')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
              </svg>
              {t('hardDeleteAll')}
            </button>
          )}
        </div>
      </div>
      {loading ? (
        <div className="empty-state">{t('loading')}</div>
      ) : filter === 'all' ? (
        tree && tree.length > 0 ? (
          <div className="trash-list">{tree.map((n) => renderNode(n, 0))}</div>
        ) : (
          <div className="empty-state">{t('empty')}</div>
        )
      ) : filter === 'folder' ? (
        folderTree && folderTree.length > 0 ? (
          <div className="trash-list">{folderTree.map((n) => renderNode(n, 0))}</div>
        ) : (
          <div className="empty-state">{t('empty')}</div>
        )
      ) : filter === 'report' ? (
        reportTree && reportTree.length > 0 ? (
          <div className="trash-list">{reportTree.map((n) => renderNode(n, 0))}</div>
        ) : (
          <div className="empty-state">{t('empty')}</div>
        )
      ) : visible.length === 0 ? (
        <div className="empty-state">{t('empty')}</div>
      ) : (
        <div className="trash-list">
          {visible.map((row) => (
            <div className="trash-row" key={`${row.kind}-${row.id}`}>
              {renderRow(row)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
