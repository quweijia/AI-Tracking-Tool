import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams, Link, useSearchParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { db, deleteProjectCascade, platformList, bySort } from '../db'
import { VersionSection } from '../components/VersionSection'
import { PlatformBadge } from '../components/PlatformBadge'
import { ProjectLogo } from '../components/ProjectCard'
import ProjectModal from '../components/ProjectModal'

/** 标题/按钮 icon（线性风格，随文字颜色继承） */
function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export default function ProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [showNewVersion, setShowNewVersion] = useState(false)
  const [versionName, setVersionName] = useState('')
  const [editing, setEditing] = useState(false)

  const project = useLiveQuery(() => db.projects.get(projectId!), [projectId])
  // 与侧边栏树排序保持一致：手动 sortNo 优先，未拖过的按创建时间
  const versions = useLiveQuery(
    async () => (await db.versions.where('projectId').equals(projectId!).toArray()).sort(bySort),
    [projectId]
  )

  // 切换项目（侧边栏跳转其它项目）时关闭新建菜单/编辑弹窗，避免残留到新项目页
  useEffect(() => {
    setShowNewVersion(false)
    setVersionName('')
    setEditing(false)
  }, [projectId])

  // 侧边栏点击版本名跳转 ?v=<id>：滚动到对应版本区块
  const [searchParams, setSearchParams] = useSearchParams()
  const anchorVersion = searchParams.get('v')
  useEffect(() => {
    if (!anchorVersion || !versions) return
    document.getElementById(`version-${anchorVersion}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setSearchParams({}, { replace: true })
  }, [anchorVersion, versions, setSearchParams])

  const createVersion = async () => {
    const trimmed = versionName.trim()
    if (!trimmed || !projectId) return
    await db.versions.add({
      id: crypto.randomUUID(),
      projectId,
      name: trimmed,
      createdAt: Date.now()
    })
    setVersionName('')
    setShowNewVersion(false)
  }

  const handleDeleteProject = async () => {
    if (!project) return
    const ok = window.confirm(
      `确定删除项目「${project.name}」吗？\n将同时删除其下所有版本、页面、问题记录与图片文件，删除后不可恢复。`
    )
    if (!ok) return
    await deleteProjectCascade(project.id)
    navigate('/')
  }

  return (
    <div className="page page-sticky">
      <div className="page-header">
        <div>
          <Link to="/" className="back-link">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
            返回项目列表
          </Link>
          <h1 className="project-detail-head">
            {project && <ProjectLogo project={project} size={40} />}
            {project?.name ?? '...'}
            {project && (
              <button className="title-edit-btn" onClick={() => setEditing(true)} title="编辑项目">
                <PencilIcon />
              </button>
            )}
          </h1>
          {project && (
            <div className="project-detail-meta">
              {platformList(project.platform).map((p) => (
                <PlatformBadge key={p} platform={p} />
              ))}
            </div>
          )}
        </div>
        <div className="header-actions">
          <button className="btn-danger" onClick={handleDeleteProject} disabled={!project}>
            <TrashIcon />
            删除项目
          </button>
          <button className="btn-primary" onClick={() => setShowNewVersion(!showNewVersion)}>
            <PlusIcon />
            新建菜单
          </button>
        </div>
      </div>

      {showNewVersion && (
        <div className="card form-row">
          <input
            className="input grow"
            placeholder="版本/迭代名称（如 v1.2、2026-10 迭代）"
            value={versionName}
            onChange={(e) => setVersionName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createVersion()}
          />
          <div className="form-actions">
            <button className="btn-secondary" onClick={() => setShowNewVersion(false)}>
              取消
            </button>
            <button className="btn-primary" onClick={createVersion} disabled={!versionName.trim()}>
              确认
            </button>
          </div>
        </div>
      )}

      {versions?.map((v) => (
        <div key={v.id} id={`version-${v.id}`}>
          <VersionSection version={v} projectId={projectId!} />
        </div>
      ))}

      {versions?.length === 0 && !showNewVersion && (
        <div className="empty-state">
          <p>还没有版本，点击右上角「新建菜单」</p>
        </div>
      )}

      {editing && project && (
        <ProjectModal
          project={project}
          onDone={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  )
}
