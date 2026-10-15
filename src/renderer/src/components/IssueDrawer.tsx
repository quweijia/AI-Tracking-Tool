import { useState } from 'react'
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

interface Props {
  issues: Issue[]
  /** 点击卡片：在标注图上高亮闪烁对应标注（不弹详情） */
  onHighlight: (issue: Issue) => void
  /** 点击画布上的标注 / 候选「编辑」：打开详情 */
  onEdit: (issue: Issue) => void
  onReverify: (issue: Issue) => void
  onAdd: (fields: { description: string; severity: Severity; category: Category; targetImage: TargetImage }) => void
  onClose: () => void
}

type DrawerFilter = 'all' | 'open' | 'done'

const DONE_STATUSES: IssueStatus[] = ['fixed', 'ignored', 'design-confirmed']

const FILTER_TABS: { value: DrawerFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'open', label: '待处理' },
  { value: 'done', label: '已解决' }
]

/** 对比页右侧的问题标注面板，可与双图对比同时查看 */
export default function IssueDrawer({ issues, onHighlight, onEdit, onReverify, onAdd, onClose }: Props) {
  const [filter, setFilter] = useState<DrawerFilter>('all')
  const [showAdd, setShowAdd] = useState(false)
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<Severity>('minor')
  const [category, setCategory] = useState<Category>('spacing')
  const [targetImage, setTargetImage] = useState<TargetImage>('screenshot')

  const submitAdd = () => {
    const trimmed = description.trim()
    if (!trimmed) return
    onAdd({ description: trimmed, severity, category, targetImage })
    setDescription('')
    setShowAdd(false)
  }

  const updateStatus = async (issue: Issue, status: IssueStatus) => {
    await db.issues.update(issue.id, { status })
    void touchPage(issue.pageId)
  }

  /** 一键清除本页全部标注（二次确认） */
  const handleClearAll = async () => {
    const pageId = issues[0]?.pageId
    if (!pageId || issues.length === 0) return
    if (!window.confirm(`确定要清除本页全部 ${issues.length} 个标注吗？删除后不可恢复。`)) return
    await db.issues.where('pageId').equals(pageId).delete()
    void touchPage(pageId)
  }

  /** AI 候选：采纳（计入正式清单） */
  const confirmCandidate = async (issue: Issue) => {
    await db.issues.update(issue.id, { aiConfirmed: true })
    void touchPage(issue.pageId)
  }

  /** AI 候选：忽略（删除该候选） */
  const dismissCandidate = async (issue: Issue) => {
    if (!window.confirm('确定忽略这条 AI 候选标注吗？')) return
    await db.issues.delete(issue.id)
    void touchPage(issue.pageId)
  }

  /** 删除单条标注（二次确认） */
  const handleDeleteOne = async (issue: Issue) => {
    const short = issue.description.length > 24 ? `${issue.description.slice(0, 24)}…` : issue.description
    if (!window.confirm(`确定删除标注「${short}」吗？删除后不可恢复。`)) return
    await db.issues.delete(issue.id)
    void touchPage(issue.pageId)
  }

  const sorted = [...issues].sort((a, b) => a.createdAt - b.createdAt)
  const numbered = sorted.map((issue, idx) => ({ issue, no: idx + 1 }))
  const filtered = numbered.filter(({ issue }) =>
    filter === 'all' ? true : filter === 'open' ? !DONE_STATUSES.includes(issue.status) : DONE_STATUSES.includes(issue.status)
  )

  return (
    <aside className="issue-drawer">
      <div className="drawer-header">
        <h3>
          标注 <span className="drawer-count">{filtered.length}</span>
        </h3>
        <div className="drawer-header-actions">
          <button
            className="btn-text danger"
            onClick={handleClearAll}
            disabled={issues.length === 0}
            title="清除本页全部标注"
          >
            清除全部
          </button>
          <button className="btn-text" onClick={() => setShowAdd(!showAdd)}>
            {showAdd ? '收起表单' : '添加'}
          </button>
          <button className="drawer-close" onClick={onClose} title="收起面板">
            ×
          </button>
        </div>
      </div>

      <div className="drawer-tabs">
        {FILTER_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            className={`drawer-tab ${filter === t.value ? 'active' : ''}`}
            onClick={() => setFilter(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {showAdd && (
        <div className="drawer-add-form">
          <input
            className="input"
            placeholder="问题描述"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitAdd()}
          />
          <div className="drawer-add-row">
            <USelect
              value={category}
              onChange={(v) => setCategory(v as Category)}
              options={(Object.keys(CATEGORY_LABELS) as Category[]).map((k) => ({ value: k, label: CATEGORY_LABELS[k] }))}
            />
            <USelect
              value={severity}
              onChange={(v) => setSeverity(v as Severity)}
              options={(Object.keys(SEVERITY_LABELS) as Severity[]).map((k) => ({ value: k, label: SEVERITY_LABELS[k] }))}
            />
            <USelect
              value={targetImage}
              onChange={(v) => setTargetImage(v as TargetImage)}
              options={[
                { value: 'screenshot', label: '开发截图' },
                { value: 'design', label: '设计稿' }
              ]}
            />
          </div>
          <div className="drawer-add-row">
            <button className="btn-primary" onClick={submitAdd} disabled={!description.trim()}>
              添加
            </button>
            <button className="btn-secondary" onClick={() => setShowAdd(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      <div className="drawer-list">
        {filtered.map(({ issue, no }) => {
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
              title="点击在标注图上高亮定位该问题"
            >
              {/* 序号独立列 + 问题描述同行，状态选择器固定右上角 */}
              <div className="drawer-item-head">
                <span className={`anno-circle severity-${issue.severity}`}>{no}</span>
                <div className="drawer-item-main">
                  <p className="drawer-desc">{issue.description}</p>
                  <div className="drawer-item-tags">
                    <span className={`severity-badge severity-${issue.severity}`}>
                      {SEVERITY_LABELS[issue.severity]}
                    </span>
                    <span className="drawer-cat">{CATEGORY_LABELS[issue.category]}</span>
                    {issue.isAISuggested && (
                      <span className={`ai-badge${isCandidate ? ' pending' : ''}`}>
                        {isCandidate ? 'AI 候选' : 'AI'}
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
                      label: ISSUE_STATUS_LABELS[k]
                    }))}
                  />
                )}
              </div>
              {isCandidate ? (
                <div className="drawer-item-foot" onClick={(e) => e.stopPropagation()}>
                  <span className="ai-hint">待人工审核，采纳后计入报告</span>
                  <div className="drawer-actions">
                    <button className="btn-text" onClick={() => confirmCandidate(issue)}>
                      采纳
                    </button>
                    <button className="btn-text" onClick={() => onEdit(issue)} title="编辑后保存即采纳">
                      编辑
                    </button>
                    <button className="btn-text danger" onClick={() => dismissCandidate(issue)}>
                      忽略
                    </button>
                  </div>
                </div>
              ) : (
                <div className="drawer-item-foot end" onClick={(e) => e.stopPropagation()}>
                  <div className="drawer-actions">
                    {issue.fixStatus === 'passed' && <span className="fix-badge pass">已通过</span>}
                    {issue.fixStatus === 'failed' && (
                      <span className="fix-badge fail">
                        未通过
                        {(issue.reverifyCount ?? 0) > 1 ? ` ×${issue.reverifyCount}` : ''}
                      </span>
                    )}
                    <button className="btn-text" onClick={() => onReverify(issue)}>
                      复验
                    </button>
                    <button className="btn-text danger" onClick={() => handleDeleteOne(issue)} title="删除该标注">
                      删除
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {filtered.length === 0 && (
          <p className="drawer-empty">
            {filter === 'all' ? '还没有标注，可在图上框选或点击「添加」' : '该分类下暂无标注'}
          </p>
        )}
      </div>
    </aside>
  )
}
