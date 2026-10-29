import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  db,
  touchPage,
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

interface Props {
  issues: Issue[]
  /** 点击卡片：在标注图上高亮闪烁对应标注（不弹详情） */
  onHighlight: (issue: Issue) => void
  /** 点击画布上的标注 / 候选「编辑」：打开详情 */
  onEdit: (issue: Issue) => void
  onReverify: (issue: Issue) => void
  /** 快捷添加（自动走查模式不提供：新增的手动标注不会出现在走查清单中） */
  onAdd?: (fields: { description: string; severity: Severity; category: Category; targetImage: TargetImage }) => void
  onClose: () => void
}

type DrawerFilter = 'all' | 'open' | 'done'

const DONE_STATUSES: IssueStatus[] = ['fixed', 'ignored', 'design-confirmed']

/** 枚举值转语言包 key 后缀（'in-progress' → 'in_progress'） */
const enumKey = (v: string) => v.replace(/-/g, '_')

/** 对比页右侧的问题标注面板，可与双图对比同时查看 */
export default function IssueDrawer({ issues, onHighlight, onEdit, onReverify, onAdd, onClose }: Props) {
  const { t } = useTranslation('issueDrawer')
  const [filter, setFilter] = useState<DrawerFilter>('all')
  const [showAdd, setShowAdd] = useState(false)
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<Severity>('minor')
  const [category, setCategory] = useState<Category>('spacing')
  const [targetImage, setTargetImage] = useState<TargetImage>('screenshot')
  /** 来源筛选（结构化/视觉/规范/清单/无障碍/手动）与折叠的分类组 */
  const [sourceFilter, setSourceFilter] = useState<'all' | 'structured' | 'visual' | 'spec' | 'element' | 'a11y' | 'manual'>('all')
  const [collapsed, setCollapsed] = useState<Set<Category>>(new Set())
  /** 清除类型弹窗：勾选要清除的来源/分类 */
  const [clearOpen, setClearOpen] = useState(false)
  const [clearSel, setClearSel] = useState<Set<string>>(new Set())

  /** 展示映射：存库值为枚举 key，展示文案经语言包转换 */
  const catLabel = (c: Category) => t(`cat_${enumKey(c)}`)
  const sevLabel = (s: Severity) => t(`sev_${enumKey(s)}`)
  const statusLabel = (s: IssueStatus) => t(`status_${enumKey(s)}`)

  /** 状态筛选 tab */
  const filterTabs: { value: DrawerFilter; label: string }[] = [
    { value: 'all', label: t('filterAll') },
    { value: 'open', label: t('filterOpen') },
    { value: 'done', label: t('filterDone') }
  ]

  /** 来源筛选（结构化 / 视觉 / 规范 / 清单 / 无障碍 / 手动，旧数据缺省 source 视为手动） */
  const sourceTabs: { value: 'all' | 'structured' | 'visual' | 'spec' | 'element' | 'a11y' | 'manual'; label: string }[] = [
    { value: 'all', label: t('sourceAll') },
    { value: 'visual', label: t('sourceVisual') },
    { value: 'spec', label: t('sourceSpec') },
    { value: 'element', label: t('sourceElement') },
    { value: 'a11y', label: t('sourceA11y') },
    { value: 'structured', label: t('sourceStructured') },
    { value: 'manual', label: t('sourceManual') }
  ]

  /** 清除类型弹窗用的来源标签（旧数据缺省 source 视为手动） */
  const sourceLabels: Record<'structured' | 'visual' | 'spec' | 'element' | 'a11y' | 'manual', string> = {
    structured: t('sourceStructuredFull'),
    visual: t('sourceVisualAI'),
    spec: t('sourceSpecFull'),
    element: t('sourceElementFull'),
    a11y: t('sourceA11yFull'),
    manual: t('sourceManualFull')
  }

  const submitAdd = () => {
    const trimmed = description.trim()
    if (!trimmed || !onAdd) return
    onAdd({ description: trimmed, severity, category, targetImage })
    setDescription('')
    setShowAdd(false)
  }

  const updateStatus = async (issue: Issue, status: IssueStatus) => {
    await db.issues.update(issue.id, { status })
    void touchPage(issue.pageId)
  }

  /** 本页实际出现的来源与分类（清除弹窗只列出这些） */
  const presentSources = Array.from(
    new Set(issues.map((i) => i.source ?? 'manual'))
  ) as ('structured' | 'visual' | 'spec' | 'element' | 'a11y' | 'manual')[]
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
    if (!window.confirm(t('clearSelectedConfirm', { count: targets.length }))) return
    await db.issues.bulkDelete(targets.map((i) => i.id))
    void touchPage(pageId)
    setClearOpen(false)
    setClearSel(new Set())
  }

  /** AI 候选：采纳（计入正式清单） */
  const confirmCandidate = async (issue: Issue) => {
    await db.issues.update(issue.id, { aiConfirmed: true })
    void touchPage(issue.pageId)
  }

  /** AI 候选：忽略（删除该候选） */
  const dismissCandidate = async (issue: Issue) => {
    if (!window.confirm(t('ignoreCandidateConfirm'))) return
    await db.issues.delete(issue.id)
    void touchPage(issue.pageId)
  }

  /** 删除单条标注（二次确认） */
  const handleDeleteOne = async (issue: Issue) => {
    const short = issue.description.length > 24 ? `${issue.description.slice(0, 24)}…` : issue.description
    if (!window.confirm(t('deleteOneConfirm', { name: short }))) return
    await db.issues.delete(issue.id)
    void touchPage(issue.pageId)
  }

  const sorted = [...issues].sort((a, b) => a.createdAt - b.createdAt)
  const numbered = sorted.map((issue, idx) => ({ issue, no: idx + 1 }))
  const filtered = numbered.filter(({ issue }) => {
    if (filter === 'open' && DONE_STATUSES.includes(issue.status)) return false
    if (filter === 'done' && !DONE_STATUSES.includes(issue.status)) return false
    if (sourceFilter !== 'all' && (issue.source ?? 'manual') !== sourceFilter) return false
    return true
  })

  /** 按分类分组展示（编号保持全列表连续，与画布标注一致），组可折叠，只出现有标注的分类组 */
  const groups = (Object.keys(CATEGORY_LABELS) as Category[])
    .map((cat) => ({ cat, items: filtered.filter(({ issue }) => issue.category === cat) }))
    .filter((g) => g.items.length > 0)

  const toggleCollapse = (cat: Category) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })

  return (
    <aside className="issue-drawer">
      <div className="drawer-header">
        <h3>
          {t('annotations')} <span className="drawer-count">{filtered.length}</span>
        </h3>
        <div className="drawer-header-actions">
          <button
            className="btn-text danger"
            onClick={() => {
              setClearSel(new Set())
              setClearOpen(true)
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

      <div className="drawer-tabs">
        {filterTabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            className={`drawer-tab ${filter === tab.value ? 'active' : ''}`}
            onClick={() => setFilter(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 来源筛选：结构化 / 视觉 / 手动 */}
      <div className="drawer-tabs drawer-source-tabs">
        {sourceTabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            className={`drawer-tab sm ${sourceFilter === tab.value ? 'active' : ''}`}
            onClick={() => setSourceFilter(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

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
              <span className="drawer-group-count">{g.items.length}</span>
            </button>
            {!collapsed.has(g.cat) &&
              g.items.map(({ issue, no }) => {
          const isCandidate = !!issue.isAISuggested && !issue.aiConfirmed
          return (
            <div
              key={issue.id}
              className={`drawer-item${isCandidate ? ' ai-candidate-item' : ''}`}
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
                  <p className="drawer-desc">{issue.description}</p>
                  <div className="drawer-item-tags">
                    <span className={`severity-badge severity-${issue.severity}`}>
                      {sevLabel(issue.severity)}
                    </span>
                    <span className="drawer-cat">{catLabel(issue.category)}</span>
                    {(issue.source === 'structured' || issue.source === 'visual' || issue.source === 'spec') && (
                      <SourceBadge source={issue.source} />
                    )}
                    {issue.isAISuggested && (
                      <span className={`ai-badge${isCandidate ? ' pending' : ''}`}>
                        {isCandidate ? t('aiCandidate') : 'AI'}
                      </span>
                    )}
                  </div>
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
                    {issue.fixStatus === 'passed' && <span className="fix-badge pass">{t('passed')}</span>}
                    {issue.fixStatus === 'failed' && (
                      <span className="fix-badge fail">
                        {t('failed')}
                        {(issue.reverifyCount ?? 0) > 1 ? ` ×${issue.reverifyCount}` : ''}
                      </span>
                    )}
                    <button className="btn-text" onClick={() => onReverify(issue)}>
                      {t('reverify')}
                    </button>
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
            {filter === 'all' && sourceFilter === 'all' ? t('emptyAll') : t('emptyFiltered')}
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
