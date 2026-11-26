import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  db,
  touchPage,
  deleteIssuesCascade,
  CATEGORY_UNSET,
  Category,
  Issue,
  IssueStatus,
  ISSUE_STATUS_LABELS,
  CATEGORY_LABELS,
  SEVERITY_LABELS,
  Severity,
  TargetImage
} from '../db'
import USelect from './USelect'
import SourceBadge from './SourceBadge'
import { confirmDialog } from './ConfirmDialog'

interface Props {
  issues: Issue[]
  /** 点击卡片：在标注图上高亮闪烁对应标注（不弹详情） */
  onHighlight: (issue: Issue) => void
  /** 点击画布上的标注 / 候选「编辑」：打开详情 */
  onEdit: (issue: Issue) => void
  /** 复验（可选：产品模式不提供复验，不传则隐藏复验按钮） */
  onReverify?: (issue: Issue) => void
  /** 快捷添加（自动走查模式不提供：新增的手动标注不会出现在走查清单中） */
  onAdd?: (fields: { description: string; severity: Severity; category: Category; targetImage: TargetImage }) => void
  onClose: () => void
  /** 状态变更回调覆盖（默认使用 db.issues.update + touchPage；传入则使用覆盖逻辑） */
  onStatusChange?: (issue: Issue, status: IssueStatus) => Promise<void> | void
  /** 删除单条回调覆盖（默认使用 deleteIssuesCascade + touchPage；传入则使用覆盖逻辑） */
  onDeleteOne?: (issue: Issue) => Promise<void> | void
  /** 清除回调覆盖（默认使用来源/分类弹窗 + deleteIssuesCascade；传入则使用覆盖逻辑，不传则隐藏清除按钮） */
  onClearByType?: () => Promise<void> | void
  /** 产品标注模式：来源筛选 tab 替换为标注分类筛选 tab */
  showCategoryTabs?: boolean
  /** 设计规范功能开关（设置页控制，默认开启）：关闭时隐藏「Token」来源筛选 tab */
  specMenuOn?: boolean
}

type DrawerFilter = 'all' | 'open' | 'done'

const DONE_STATUSES: IssueStatus[] = ['fixed', 'ignored', 'design-confirmed']

/** 枚举值转语言包 key 后缀（'in-progress' → 'in_progress'） */
const enumKey = (v: string) => v.replace(/-/g, '_')

/** 清单宽度边界与默认值（拖拽左缘调整，超出自动截断） */
const DRAWER_MIN_W = 300
const DRAWER_MAX_W = 760
const DRAWER_DEFAULT_W = 400

/** 宽度持久化 key：走查问题清单 / 产品标注清单分开记忆，互不影响 */
const drawerWidthKey = (product: boolean) => `ui-check.drawer-width.${product ? 'product' : 'walk'}`

/** 对比页右侧的问题标注面板，可与双图对比同时查看 */
export default function IssueDrawer({ issues, onHighlight, onEdit, onReverify, onAdd, onClose, onStatusChange, onDeleteOne, onClearByType, showCategoryTabs, specMenuOn = true }: Props) {
  const { t } = useTranslation('issueDrawer')
  const [filter, setFilter] = useState<DrawerFilter>('all')
  const [showAdd, setShowAdd] = useState(false)
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<Severity>('minor')
  const [category, setCategory] = useState<Category>('spacing')
  const [targetImage, setTargetImage] = useState<TargetImage>('screenshot')
  /** 来源筛选（结构化/视觉/Token/清单/无障碍/手动）与折叠的分类组 */
  const [sourceFilter, setSourceFilter] = useState<'all' | 'structured' | 'visual' | 'spec' | 'element' | 'a11y' | 'manual'>('all')
  /** 标注分类筛选（产品标注模式：替代来源筛选 tab） */
  const [categoryFilter, setCategoryFilter] = useState<'all' | Category>('all')
  const [collapsed, setCollapsed] = useState<Set<Category>>(new Set())
  /** 清除类型弹窗：勾选要清除的来源/分类 */
  const [clearOpen, setClearOpen] = useState(false)
  const [clearSel, setClearSel] = useState<Set<string>>(new Set())

  // 设计规范功能关闭时回退来源筛选：当前停留在「Token」tab 的话切回「全部来源」（设置页实时切换生效）
  useEffect(() => {
    if (!specMenuOn && sourceFilter === 'spec') setSourceFilter('all')
  }, [specMenuOn, sourceFilter])

  // 当前筛选的来源已无标注，或仅剩单一来源（tab 已隐藏）时回落到「全部来源」
  useEffect(() => {
    if (sourceFilter === 'all') return
    const visible = new Set(issues.map((i) => i.source ?? 'manual').filter((s) => s !== 'spec' || specMenuOn))
    if (visible.size < 2 || !visible.has(sourceFilter)) {
      setSourceFilter('all')
    }
  }, [issues, sourceFilter, specMenuOn])

  /** 清单宽度（px）：左缘拖拽调整，按模式持久化 localStorage（undefined = CSS 默认 400px） */
  const [width, setWidth] = useState<number | undefined>(() => {
    const v = Number(localStorage.getItem(drawerWidthKey(!!showCategoryTabs)))
    return Number.isFinite(v) && v >= DRAWER_MIN_W && v <= DRAWER_MAX_W ? v : undefined
  })
  /** 拖拽中（手柄显示常亮线 + 左缘光标稳定） */
  const [resizing, setResizing] = useState(false)
  /** 拖拽起点：起始鼠标 X 与起始宽度 */
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  /** 左缘拖拽：向左拖增宽、向右拖收窄（setPointerCapture 保证拖出手柄仍持续响应） */
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: width ?? DRAWER_DEFAULT_W }
    setResizing(true)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onResizeMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    // 右侧至少给画板留 360px，同时受 300~760px 边界约束
    const max = Math.min(DRAWER_MAX_W, Math.max(DRAWER_MIN_W, window.innerWidth - 360))
    setWidth(Math.round(Math.min(max, Math.max(DRAWER_MIN_W, d.startW - (e.clientX - d.startX)))))
  }
  const onResizeEnd = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    dragRef.current = null
    setResizing(false)
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    if (width !== undefined) localStorage.setItem(drawerWidthKey(!!showCategoryTabs), String(width))
  }
  /** 双击手柄：恢复默认宽度并清除记忆 */
  const onResizeReset = () => {
    localStorage.removeItem(drawerWidthKey(!!showCategoryTabs))
    setWidth(undefined)
  }

  /** 展示映射：存库值为枚举 key，展示文案经语言包转换；未选择分类（CATEGORY_UNSET）显示「未分类」 */
  const catLabel = (c: Category) => (c ? t(`cat_${enumKey(c)}`) : t('uncategorized'))
  const sevLabel = (s: Severity) => t(`sev_${enumKey(s)}`)
  const statusLabel = (s: IssueStatus) => t(`status_${enumKey(s)}`)

  /** 状态筛选 tab */
  const filterTabs: { value: DrawerFilter; label: string }[] = [
    { value: 'all', label: t('filterAll') },
    { value: 'open', label: t('filterOpen') },
    { value: 'done', label: t('filterDone') }
  ]

  /** 本页实际出现的来源（来源 tab 与清除弹窗共用；旧数据缺省 source 视为手动） */
  const presentSources = Array.from(
    new Set(issues.map((i) => i.source ?? 'manual'))
  ) as ('structured' | 'visual' | 'spec' | 'element' | 'a11y' | 'manual')[]

  /** 来源筛选 tab：出现 ≥2 个来源时才显示（全部来源 + 各来源 tab），单来源不显示；设计规范功能关闭时隐藏 Token tab */
  const visibleSources = (
    [
      ['visual', 'sourceVisual'],
      ['spec', 'sourceSpec'],
      ['element', 'sourceElement'],
      ['a11y', 'sourceA11y'],
      ['structured', 'sourceStructured'],
      ['manual', 'sourceManual']
    ] as const
  ).filter(([s]) => presentSources.includes(s) && (s !== 'spec' || specMenuOn))
  const sourceTabs: { value: 'all' | 'structured' | 'visual' | 'spec' | 'element' | 'a11y' | 'manual'; label: string }[] =
    visibleSources.length >= 2
      ? [{ value: 'all', label: t('sourceAll') }, ...visibleSources.map(([s, key]) => ({ value: s, label: t(key) }))]
      : []

  /** 清除类型弹窗用的来源标签（旧数据缺省 source 视为手动） */
  const sourceLabels: Record<'structured' | 'visual' | 'spec' | 'element' | 'a11y' | 'manual', string> = {
    structured: t('sourceStructuredFull'),
    visual: t('sourceVisualAI'),
    spec: t('sourceSpecFull'),
    element: t('sourceElementFull'),
    a11y: t('sourceA11yFull'),
    manual: t('sourceManualFull')
  }

  /** 标注分类筛选 tab（产品标注模式：出现 ≥2 个分类时显示「全部 + 各分类」，单分类不显示 tab；未分类也成 tab） */
  const catList = Array.from(new Set(issues.map((i) => i.category)))
  const categoryTabs: { value: 'all' | Category; label: string }[] =
    catList.length >= 2
      ? [{ value: 'all', label: t('categoryAll') }, ...catList.map((c) => ({ value: c, label: catLabel(c) }))]
      : []

  const submitAdd = () => {
    const trimmed = description.trim()
    if (!trimmed || !onAdd) return
    onAdd({ description: trimmed, severity, category, targetImage })
    setDescription('')
    setShowAdd(false)
  }

  const updateStatus = async (issue: Issue, status: IssueStatus) => {
    if (onStatusChange) {
      await onStatusChange(issue, status)
    } else {
      await db.issues.update(issue.id, { status })
      void touchPage(issue.pageId)
    }
  }

  /** 本页实际出现的分类（清除弹窗只列出这些） */
  const presentCats = Array.from(new Set(issues.map((i) => i.category))) as Category[]

  /** 当前勾选命中的待清除标注（来源或分类任一命中即算） */
  const clearTargets = issues.filter(
    (i) => clearSel.has(`src:${i.source ?? 'manual'}`) || clearSel.has(`cat:${i.category}`)
  )

  /** 按勾选的类型清除：必须选择类型（清除按钮未选时置灰），不支持一键全清 */
  const handleClearSelected = async () => {
    if (clearSel.size === 0) return
    const pageId = issues[0]?.pageId
    if (!pageId) return
    const targets = clearTargets
    if (targets.length === 0) return
    if (!(await confirmDialog({ message: t('clearSelectedConfirm', { count: targets.length }), tone: 'danger' }))) return
    await deleteIssuesCascade(targets)
    void touchPage(pageId)
    setClearOpen(false)
    setClearSel(new Set())
  }

  /** AI 候选 / 备选问题：单条采纳（计入正式清单；备选同时生成画布标注） */
  const confirmCandidate = async (issue: Issue) => {
    await db.issues.update(issue.id, {
      aiConfirmed: true,
      ...(issue.level === 'optional' ? { optionalChecked: true } : {})
    })
    void touchPage(issue.pageId)
  }

  /** AI 候选：忽略（删除该候选） */
  const dismissCandidate = async (issue: Issue) => {
    if (!(await confirmDialog({ message: t('ignoreCandidateConfirm'), tone: 'danger' }))) return
    await deleteIssuesCascade([issue])
    void touchPage(issue.pageId)
  }

  /** 删除单条标注（二次确认） */
  const handleDeleteOne = async (issue: Issue) => {
    if (onDeleteOne) {
      await onDeleteOne(issue)
    } else {
      const short = issue.description.length > 24 ? `${issue.description.slice(0, 24)}…` : issue.description
      if (!(await confirmDialog({ message: t('deleteOneConfirm', { name: short }), tone: 'danger' }))) return
      await deleteIssuesCascade([issue])
      void touchPage(issue.pageId)
    }
  }

  const sorted = [...issues].sort((a, b) => a.createdAt - b.createdAt)
  const numbered = sorted.map((issue, idx) => ({ issue, no: idx + 1 }))
  const filtered = numbered.filter(({ issue }) => {
    if (filter === 'open' && DONE_STATUSES.includes(issue.status)) return false
    if (filter === 'done' && !DONE_STATUSES.includes(issue.status)) return false
    if (sourceFilter !== 'all' && (issue.source ?? 'manual') !== sourceFilter) return false
    if (showCategoryTabs && categoryFilter !== 'all' && issue.category !== categoryFilter) return false
    return true
  })

  /** 按分类分组展示（编号保持全列表连续，与画布标注一致），组可折叠，只出现有标注的分类组 */
  const groups = (Object.keys(CATEGORY_LABELS) as Category[])
    .map((cat) => ({ cat, items: filtered.filter(({ issue }) => issue.category === cat) }))
    .filter((g) => g.items.length > 0)
  // 分类未选择（创建后尚未确认）的标注单独成组，置于末尾，避免漏显
  const unsetGroup = { cat: CATEGORY_UNSET, items: filtered.filter(({ issue }) => issue.category === CATEGORY_UNSET) }
  if (unsetGroup.items.length > 0) groups.push(unsetGroup)

  const toggleCollapse = (cat: Category) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })

  return (
    <aside className={`issue-drawer${resizing ? ' resizing' : ''}`} style={width ? { width } : undefined}>
      {/* 左缘拖拽手柄：调整清单宽度（双击恢复默认 400px） */}
      <div
        className="drawer-resizer"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onDoubleClick={onResizeReset}
      />
      <div className="drawer-header">
        <h3>
          {t('annotations')} <span className="count">{filtered.length}</span>
        </h3>
        <div className="drawer-header-actions">
          <button
            className="btn-text danger"
            onClick={() => {
              if (onClearByType) {
                void onClearByType()
              } else {
                setClearSel(new Set())
                setClearOpen(true)
              }
            }}
            disabled={issues.length === 0}
            title={t('clearTip')}
          >
            {t('clear')}
          </button>
          {onAdd && (
            <button className="btn-text" onClick={() => setShowAdd(!showAdd)}>
              {showAdd ? t('collapseForm') : t('add')}
            </button>
          )}
          <button className="drawer-close" onClick={onClose} title={t('closeTip')}>
            ×
          </button>
        </div>
      </div>

      <div className="tabs tabs--fill drawer-tabs">
        {filterTabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            className={`tabs-item ${filter === tab.value ? 'active' : ''}`}
            onClick={() => setFilter(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 筛选 tab：走查模式显示来源筛选（只显示本页出现过的来源）；产品标注模式替换为标注分类筛选 */}
      {(showCategoryTabs ? categoryTabs.length > 0 : sourceTabs.length > 0) && (
        <div className="tabs tabs--fill drawer-source-tabs">
          {showCategoryTabs
            ? categoryTabs.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  className={`tabs-item sm ${categoryFilter === tab.value ? 'active' : ''}`}
                  onClick={() => setCategoryFilter(tab.value)}
                >
                  {tab.label}
                </button>
              ))
            : sourceTabs.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  className={`tabs-item sm ${sourceFilter === tab.value ? 'active' : ''}`}
                  onClick={() => setSourceFilter(tab.value)}
                >
                  {tab.label}
                </button>
              ))}
        </div>
      )}

      {showAdd && onAdd && (
        <div className="drawer-add-form">
          <input
            className="input"
            placeholder={t('descriptionPlaceholder')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitAdd()}
          />
          <div className="drawer-add-row">
            <USelect
              value={category}
              onChange={(v) => setCategory(v as Category)}
              options={(Object.keys(CATEGORY_LABELS) as Category[]).map((k) => ({ value: k, label: catLabel(k) }))}
            />
            <USelect
              value={severity}
              onChange={(v) => setSeverity(v as Severity)}
              options={(Object.keys(SEVERITY_LABELS) as Severity[]).map((k) => ({ value: k, label: sevLabel(k) }))}
            />
            <USelect
              value={targetImage}
              onChange={(v) => setTargetImage(v as TargetImage)}
              options={[
                { value: 'screenshot', label: t('devScreenshot') },
                { value: 'design', label: t('design') }
              ]}
            />
          </div>
          <div className="drawer-add-row">
            <button className="btn-primary" onClick={submitAdd} disabled={!description.trim()}>
              {t('add')}
            </button>
            <button className="btn-secondary" onClick={() => setShowAdd(false)}>
              {t('cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="drawer-list">
        {groups.map((g) => (
          <div key={g.cat} className="drawer-group">
            <button
              type="button"
              className="drawer-group-title"
              onClick={() => toggleCollapse(g.cat)}
              title={collapsed.has(g.cat) ? t('expandGroup') : t('collapseGroup')}
            >
              <svg
                className={`drawer-group-chevron${collapsed.has(g.cat) ? ' collapsed' : ''}`}
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
              {catLabel(g.cat)}
              <span className="count count-sm">{g.items.length}</span>
            </button>
            {!collapsed.has(g.cat) &&
              g.items.map(({ issue, no }) => {
          const isCandidate = !!issue.isAISuggested && !issue.aiConfirmed
          return (
            <div
              key={issue.id}
              className={`drawer-item${isCandidate ? ' ai-candidate-item' : ''}${
                issue.level === 'optional' && !issue.optionalChecked ? ' optional-unchecked' : ''
              }`}
              onClick={(e) => {
                // 状态选择器等控件点击不触发画布定位
                if ((e.target as HTMLElement).closest('.u-select-wrap')) return
                onHighlight(issue)
              }}
              title={t('highlightTip')}
            >
              {/* 序号独立列 + 问题描述同行，状态选择器固定右上角 */}
              <div className="drawer-item-head">
                <span className={`anno-circle severity-${issue.severity}`}>{no}</span>
                <div className="drawer-item-main">
                  {issue.shape === 'picker' && !issue.description && (issue.sampleA || issue.sampleB) ? (
                    /* 吸色标注：色块 + 色值文本（无描述时的标题回退） */
                    <p className="drawer-desc drawer-desc-picker">
                      {issue.sampleA && <span className="drawer-color-chip" style={{ background: issue.sampleA }} />}
                      <span className="drawer-color-text">{[issue.sampleA, issue.sampleB].filter(Boolean).join(' → ')}</span>
                    </p>
                  ) : issue.shape === 'measure' && !issue.description && issue.measureValue ? (
                    /* 测距标注：测量尺寸文本（无描述时的标题回退） */
                    <p className="drawer-desc drawer-desc-measure">{issue.measureValue}</p>
                  ) : (
                    <p className="drawer-desc">{issue.description}</p>
                  )}
                  <div className="drawer-item-tags">
                    {issue.level === 'optional' && (
                      <span className="badge badge-neutral">{t('levelOptional')}</span>
                    )}
                    <span className={`badge ${issue.severity === 'major' ? 'badge-danger' : issue.severity === 'minor' ? 'badge-warning' : 'badge-neutral'}`}>
                      {sevLabel(issue.severity)}
                    </span>
                    <span className="drawer-cat">{catLabel(issue.category)}</span>
                    {(issue.source === 'structured' || issue.source === 'visual' || issue.source === 'spec') && (
                      <SourceBadge source={issue.source} />
                    )}
                    {issue.isAISuggested && (
                      <span className={`badge ${isCandidate ? 'badge-warning ai-badge--pending' : 'badge-primary'}`}>
                        {isCandidate ? t('aiCandidate') : 'AI'}
                      </span>
                    )}
                  </div>
                  {issue.level === 'optional' && issue.levelReason && (
                    <p className="drawer-level-reason">{issue.levelReason}</p>
                  )}
                </div>
                {!isCandidate && (
                  <USelect
                    className={`status-select status-${issue.status}`}
                    value={issue.status}
                    onChange={(v) => updateStatus(issue, v as IssueStatus)}
                    options={(Object.keys(ISSUE_STATUS_LABELS) as IssueStatus[]).map((k) => ({
                      value: k,
                      label: statusLabel(k)
                    }))}
                  />
                )}
              </div>
              {isCandidate ? (
                <div className="drawer-item-foot" onClick={(e) => e.stopPropagation()}>
                  <span className="ai-hint">{t('aiHint')}</span>
                  <div className="drawer-actions">
                    <button className="btn-text" onClick={() => confirmCandidate(issue)}>
                      {t('approve')}
                    </button>
                    <button className="btn-text" onClick={() => onEdit(issue)} title={t('editTip')}>
                      {t('edit')}
                    </button>
                    <button className="btn-text danger" onClick={() => dismissCandidate(issue)}>
                      {t('ignore')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="drawer-item-foot end" onClick={(e) => e.stopPropagation()}>
                  <div className="drawer-actions">
                    {issue.fixStatus === 'passed' && <span className="badge badge-success fix-badge">{t('passed')}</span>}
                    {issue.fixStatus === 'failed' && (
                      <span className="badge badge-danger fix-badge">
                        {t('failed')}
                        {(issue.reverifyCount ?? 0) > 1 ? ` ×${issue.reverifyCount}` : ''}
                      </span>
                    )}
                    {onReverify && (
                      <button className="btn-text" onClick={() => onReverify(issue)}>
                        {t('reverify')}
                      </button>
                    )}
                    {/* 备选问题未采纳：提供单条采纳入口（采纳后画布生成标注并计入清单） */}
                    {issue.level === 'optional' && !issue.optionalChecked && (
                      <button className="btn-text" onClick={() => confirmCandidate(issue)}>
                        {t('approve')}
                      </button>
                    )}
                    <button className="btn-text danger" onClick={() => handleDeleteOne(issue)} title={t('deleteTip')}>
                      {t('delete')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
            })}
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="drawer-empty">
            {filter === 'all' && sourceFilter === 'all' && (!showCategoryTabs || categoryFilter === 'all') ? t('emptyAll') : t('emptyFiltered')}
          </p>
        )}
      </div>

      {clearOpen && (
        <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && setClearOpen(false)}>
          <div className="modal clear-type-modal">
            <h3>{t('clearTitle')}</h3>
            <p className="settings-desc">{t('clearDesc')}</p>

            {presentSources.length > 0 && (
              <>
                <label className="field-label">{t('bySource')}</label>
                <div className="clear-type-grid">
                  {presentSources.map((s) => (
                    <label key={s} className="inline-label">
                      <input
                        type="checkbox"
                        checked={clearSel.has(`src:${s}`)}
                        onChange={(e) => {
                          const next = new Set(clearSel)
                          if (e.target.checked) next.add(`src:${s}`)
                          else next.delete(`src:${s}`)
                          setClearSel(next)
                        }}
                      />
                      {sourceLabels[s]}
                    </label>
                  ))}
                </div>
              </>
            )}

            {presentCats.length > 0 && (
              <>
                <label className="field-label">{t('byCategory')}</label>
                <div className="clear-type-grid">
                  {presentCats.map((c) => (
                    <label key={c} className="inline-label">
                      <input
                        type="checkbox"
                        checked={clearSel.has(`cat:${c}`)}
                        onChange={(e) => {
                          const next = new Set(clearSel)
                          if (e.target.checked) next.add(`cat:${c}`)
                          else next.delete(`cat:${c}`)
                          setClearSel(next)
                        }}
                      />
                      {catLabel(c)}
                    </label>
                  ))}
                </div>
              </>
            )}

            <div className="drawer-clear-summary">
              {clearSel.size === 0 ? t('clearSummaryNone') : t('clearSummaryCount', { n: clearTargets.length })}
            </div>

            <div className="modal-actions">
              <span className="modal-spacer" />
              <button className="btn-secondary" onClick={() => setClearOpen(false)}>
                {t('cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={handleClearSelected}
                disabled={clearSel.size === 0 || clearTargets.length === 0}
              >
                {t('clear')}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
