import { useLiveQuery } from 'dexie-react-hooks'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import {
  db,
  genId,
  touchPage,
  Category,
  Issue,
  ISSUE_STATUS_LABELS,
  CATEGORY_LABELS,
  SEVERITY_LABELS,
  Severity,
  IssueStatus,
  TargetImage
} from '../db'
import USelect from '../components/USelect'
import ReverifyModal from '../components/ReverifyModal'

export default function IssueList() {
  const { projectId, pageId } = useParams<{ projectId: string; pageId: string }>()
  const navigate = useNavigate()
  const issues = useLiveQuery(
    () => db.issues.where('pageId').equals(pageId!).toArray(),
    [pageId]
  )

  const [showAdd, setShowAdd] = useState(false)
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<Severity>('minor')
  const [category, setCategory] = useState<Category>('spacing')
  const [targetImage, setTargetImage] = useState<TargetImage>('screenshot')
  const [reverifyIssue, setReverifyIssue] = useState<Issue | null>(null)
  const [oldScreenshotUrl, setOldScreenshotUrl] = useState<string | null>(null)

  const openReverify = async (issue: Issue) => {
    setReverifyIssue(issue)
    setOldScreenshotUrl(null)
    const page = await db.pages.get(pageId!)
    if (page?.screenshotPath) {
      const url = await window.electronAPI.readImage(page.screenshotPath)
      setOldScreenshotUrl(url)
    }
  }

  const addIssue = async () => {
    const trimmed = description.trim()
    if (!trimmed || !pageId) return
    const issue: Issue = {
      id: genId(),
      pageId,
      targetImage,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      description: trimmed,
      severity,
      category,
      status: 'pending',
      createdAt: Date.now()
    }
    await db.issues.add(issue)
    void touchPage(pageId)
    setDescription('')
    setShowAdd(false)
  }

  const updateStatus = async (issue: Issue, status: IssueStatus) => {
    await db.issues.update(issue.id, { status })
    void touchPage(issue.pageId)
  }

  const sorted = [...(issues ?? [])].sort((a, b) => a.createdAt - b.createdAt)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <Link to={`/project/${projectId}/page/${pageId}`} className="back-link">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
            返回对比
          </Link>
          <h1>问题清单与复验</h1>
        </div>
        <button className="btn-primary" onClick={() => setShowAdd(!showAdd)}>
          添加问题
        </button>
      </div>

      {showAdd && (
        <div className="card form-row">
          <input
            className="input grow"
            placeholder="问题描述"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
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
          <button className="btn-primary" onClick={addIssue} disabled={!description.trim()}>
            添加
          </button>
          <button className="btn-secondary" onClick={() => setShowAdd(false)}>
            取消
          </button>
        </div>
      )}

      <div className="issue-table card">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>分类</th>
              <th>严重度</th>
              <th>描述</th>
              <th>标注图</th>
              <th>状态</th>
              <th>复验</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((issue, idx) => (
              <tr key={issue.id}>
                <td>{idx + 1}</td>
                <td>{CATEGORY_LABELS[issue.category]}</td>
                <td>
                  <span className={`severity-badge severity-${issue.severity}`}>
                    {SEVERITY_LABELS[issue.severity]}
                  </span>
                </td>
                <td className="issue-desc">{issue.description}</td>
                <td>{issue.targetImage === 'design' ? '设计稿' : '截图'}</td>
                <td>
                  <USelect
                    className={`status-select status-${issue.status}`}
                    value={issue.status}
                    onChange={(v) => updateStatus(issue, v as IssueStatus)}
                    options={(Object.keys(ISSUE_STATUS_LABELS) as IssueStatus[]).map((k) => ({
                      value: k,
                      label: ISSUE_STATUS_LABELS[k]
                    }))}
                  />
                </td>
                <td>
                  {issue.fixStatus === 'passed' && <span className="fix-badge pass">已通过</span>}
                  {issue.fixStatus === 'failed' && (
                    <span className="fix-badge fail">
                      未通过
                      {(issue.reverifyCount ?? 0) > 1 ? ` ×${issue.reverifyCount}` : ''}
                    </span>
                  )}
                  <button className="btn-text" onClick={() => openReverify(issue)}>
                    复验
                  </button>
                  <button
                    className="btn-text"
                    onClick={() => navigate(`/project/${projectId}/page/${pageId}?issue=${issue.id}`)}
                    title="跳转到对比页查看标注框"
                  >
                    定位
                  </button>
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={7} className="table-empty">
                  {issues === undefined ? '加载中...' : '还没有问题记录，可在对比页框选标注或点击右上角「添加问题」'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {reverifyIssue && (
        <ReverifyModal
          issue={reverifyIssue}
          oldScreenshotUrl={oldScreenshotUrl}
          onClose={() => setReverifyIssue(null)}
        />
      )}
    </div>
  )
}
