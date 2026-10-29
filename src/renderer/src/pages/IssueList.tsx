import { useLiveQuery } from 'dexie-react-hooks'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import SourceBadge from '../components/SourceBadge'
import ReverifyModal from '../components/ReverifyModal'

export default function IssueList() {
  const { t } = useTranslation('issueList')
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

  /** 展示映射：存库值为枚举 key，展示文案经语言包转换 */
  const catLabel = (c: Category) => t(`cat_${c}`)
  const sevLabel = (s: Severity) => t(`sev_${s}`)
  const statusLabel = (s: IssueStatus) => t(`status_${s}`)

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
            {t('backToCompare')}
          </Link>
          <h1>{t('title')}</h1>
        </div>
        <button className="btn-primary" onClick={() => setShowAdd(!showAdd)}>
          {t('addIssue')}
        </button>
      </div>

      {showAdd && (
        <div className="card form-row">
          <input
            className="input grow"
            placeholder={t('descriptionPlaceholder')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
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
          <button className="btn-primary" onClick={addIssue} disabled={!description.trim()}>
            {t('add')}
          </button>
          <button className="btn-secondary" onClick={() => setShowAdd(false)}>
            {t('cancel')}
          </button>
        </div>
      )}

      <div className="issue-table card">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>{t('colCategory')}</th>
              <th>{t('colSeverity')}</th>
              <th>{t('colSource')}</th>
              <th>{t('colDescription')}</th>
              <th>{t('colTargetImage')}</th>
              <th>{t('colStatus')}</th>
              <th>{t('colReverify')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((issue, idx) => (
              <tr key={issue.id}>
                <td>{idx + 1}</td>
                <td>{catLabel(issue.category)}</td>
                <td>
                  <span className={`severity-badge severity-${issue.severity}`}>
                    {sevLabel(issue.severity)}
                  </span>
                </td>
                <td className="issue-source">
                  {(issue.source === 'structured' ||
                    issue.source === 'visual' ||
                    issue.source === 'spec' ||
                    issue.source === 'element' ||
                    issue.source === 'a11y') && (
                    <SourceBadge source={issue.source} />
                  )}
                </td>
                <td className="issue-desc">{issue.description}</td>
                <td>{issue.targetImage === 'design' ? t('design') : t('screenshot')}</td>
                <td>
                  <USelect
                    className={`status-select status-${issue.status}`}
                    value={issue.status}
                    onChange={(v) => updateStatus(issue, v as IssueStatus)}
                    options={(Object.keys(ISSUE_STATUS_LABELS) as IssueStatus[]).map((k) => ({
                      value: k,
                      label: statusLabel(k)
                    }))}
                  />
                </td>
                <td>
                  {issue.fixStatus === 'passed' && <span className="fix-badge pass">{t('passed')}</span>}
                  {issue.fixStatus === 'failed' && (
                    <span className="fix-badge fail">
                      {t('failed')}
                      {(issue.reverifyCount ?? 0) > 1 ? ` ×${issue.reverifyCount}` : ''}
                    </span>
                  )}
                  <button className="btn-text" onClick={() => openReverify(issue)}>
                    {t('reverify')}
                  </button>
                  <button
                    className="btn-text"
                    onClick={() => navigate(`/project/${projectId}/page/${pageId}?issue=${issue.id}`)}
                    title={t('locateTip')}
                  >
                    {t('locate')}
                  </button>
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={8} className="table-empty">
                  {issues === undefined ? t('loading') : t('empty')}
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
