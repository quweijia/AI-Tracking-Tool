import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams, Link, useSearchParams } from 'react-router-dom'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { db, platformList, bySort, Folder } from '../db'
import PageGrid from '../components/PageGrid'
import { PlatformBadge } from '../components/PlatformBadge'
import { ProjectLogo } from '../components/ProjectCard'
import ProjectModal from '../components/ProjectModal'
import FolderModal from '../components/FolderModal'
import { FolderIconGlyph } from '../components/FolderIcon'
import heroBannerArtUrl from '../assets/hero-banner-xmxq.png'
import heroBannerArtDarkUrl from '../assets/hero-banner-xmxq-dark.png'

/** 标题右侧编辑 icon（悬停卡片时显示） */
function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
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

/** 批量管理 icon（勾选方块） */
function BatchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="m8.5 12.2 2.6 2.6 4.9-5.2" />
    </svg>
  )
}

/** 文件夹 icon（新建文件夹按钮） */
function FolderPlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M12 10v6M9 13h6" />
    </svg>
  )
}

export default function ProjectDetail() {
  const { t } = useTranslation('projectDetail')
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  /** 新建 / 编辑文件夹弹窗（新建文件夹、重命名、换 icon 颜色、删除均收进弹窗） */
  const [folderModal, setFolderModal] = useState<{ mode: 'create' | 'edit'; folder?: Folder } | null>(null)
  /** 批量管理模式（按钮在横幅操作区，与 PageGrid 网格联动） */
  const [batchMode, setBatchMode] = useState(false)

  const project = useLiveQuery(() => db.projects.get(projectId!), [projectId])
  // 项目下全部文件夹（含各层，用于面包屑与子级筛选），手动 sortNo 优先
  const allFolders = useLiveQuery(
    async () => (await db.folders.where('projectId').equals(projectId!).toArray()).sort(bySort),
    [projectId]
  )

  // 切换项目（侧边栏跳转其它项目）时关闭弹窗，避免残留到新项目页
  useEffect(() => {
    setEditing(false)
    setFolderModal(null)
    setBatchMode(false)
  }, [projectId])

  // 路由 ?f=<folderId> 决定当前层级：空为项目根，否则进入文件夹视图
  const [searchParams, setSearchParams] = useSearchParams()
  const activeFolderId = searchParams.get('f')
  const activeFolder = useLiveQuery(
    () => (activeFolderId ? db.folders.get(activeFolderId) : undefined),
    [activeFolderId]
  )

  /** 当前层的子文件夹（根级 = parentId 为空） */
  const subFolders = useMemo(
    () =>
      (allFolders ?? []).filter(
        (f) => (activeFolderId ? f.parentId === activeFolderId : !f.parentId)
      ),
    [allFolders, activeFolderId]
  )
  /** 当前层页面（根级 = 未分组页面） */
  const levelPages = useLiveQuery(
    async () => {
      if (!projectId) return []
      if (activeFolderId) {
        return (await db.pages.where('folderId').equals(activeFolderId).toArray()).sort(bySort)
      }
      return (await db.pages.where('projectId').equals(projectId).toArray())
        .filter((p) => !p.folderId)
        .sort(bySort)
    },
    [projectId, activeFolderId]
  )

  /** 面包屑链：从当前文件夹沿 parentId 回溯到根（根在前） */
  const breadcrumb = useMemo(() => {
    if (!activeFolderId || !allFolders) return []
    const chain: Folder[] = []
    let cur = allFolders.find((f) => f.id === activeFolderId)
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      chain.unshift(cur)
      cur = cur.parentId ? allFolders.find((f) => f.id === cur!.parentId) : undefined
    }
    return chain
  }, [activeFolderId, allFolders])

  /** 文件夹视图时横幅内的路径胶囊：项目根 + 当前层之上的各层（当前层显示在下方大标题，不重复） */
  const crumbTrail = useMemo(
    () => [
      { id: '', name: project?.name ?? t('defaultName') },
      ...(activeFolderId ? breadcrumb.slice(0, -1) : [])
    ],
    [activeFolderId, breadcrumb, project?.name, t]
  )

  const jumpToFolder = (id: string) => {
    setBatchMode(false)
    setSearchParams(id ? { f: id } : {})
  }

  /** 文件夹弹窗关闭：编辑模式若文件夹已被删除且是当前层，退回项目根 */
  const closeFolderModal = async () => {
    const edited = folderModal?.folder
    setFolderModal(null)
    if (edited && edited.id === activeFolderId) {
      const still = await db.folders.get(edited.id)
      if (!still) setSearchParams({}, { replace: true })
    }
  }

  /** 是否处于文件夹视图（activeFolderId 有效且文件夹存在） */
  const inFolderView = Boolean(activeFolderId && activeFolder)

  return (
    <div className="page">
      {/* 顶部横幅：文件夹视图显示路径导航 + 当前文件夹名；根视图显示返回 + 项目名 */}
      <div className="rv2-hero detail-hero">
        <div className="rv2-hero-main">
          {inFolderView && activeFolder ? (
            <>
              {/* 路径胶囊链：与「返回项目列表」同款外观，每层可点击直达；当前层显示在下方大标题 */}
              <div className="hero-crumb">
                {crumbTrail.map((seg, i) => (
                  <button
                    key={seg.id || 'root'}
                    type="button"
                    className="back-link hero-crumb-pill"
                    onClick={() => jumpToFolder(seg.id)}
                    title={seg.name}
                  >
                    {i === 0 && (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M15 18l-6-6 6-6" />
                      </svg>
                    )}
                    <span className="crumb-pill-text">{seg.name}</span>
                  </button>
                ))}
              </div>
              <h1 className="rv2-title detail-title">
                <span
                  className="folder-title-glyph"
                  style={activeFolder.color ? { color: activeFolder.color } : undefined}
                >
                  <FolderIconGlyph icon={activeFolder.icon} size={30} />
                </span>
                <span className="detail-title-text">{activeFolder.name}</span>
                <button
                  className="title-edit-btn"
                  onClick={() => setFolderModal({ mode: 'edit', folder: activeFolder })}
                  title={t('editFolder')}
                >
                  <PencilIcon />
                </button>
              </h1>
            </>
          ) : (
            <>
              <Link to="/" className="back-link">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                {t('backToProjects')}
              </Link>
              <h1 className="rv2-title detail-title">
                {project && <ProjectLogo project={project} size={40} />}
                <span className="detail-title-text">{project?.name ?? '...'}</span>
                {project && (
                  <button className="title-edit-btn" onClick={() => setEditing(true)} title={t('editProject')}>
                    <PencilIcon />
                  </button>
                )}
              </h1>
              {project && (
                <div className="detail-meta">
                  {platformList(project.platform).map((p) => (
                    <PlatformBadge key={p} platform={p} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div className="detail-actions">
          {/* 批量管理：入口统一收进横幅，置于「新建文件夹」左侧；当前层有文件夹或页面即可用 */}
          {(levelPages?.length ?? 0) + subFolders.length > 0 && (
            <button
              className={`btn-secondary batch-toggle${batchMode ? ' active' : ''}`}
              onClick={() => setBatchMode(!batchMode)}
            >
              <BatchIcon />
              {batchMode ? t('exitBatch') : t('batchMode')}
            </button>
          )}
          <button
            className="btn-secondary"
            onClick={() => setFolderModal({ mode: 'create' })}
          >
            <FolderPlusIcon />
            {t('newFolder')}
          </button>
          <button
            className="btn-primary"
            onClick={() => navigate(`/project/${projectId}/new${activeFolderId ? `?folderId=${activeFolderId}` : ''}`)}
          >
            <PlusIcon />
            {t('newPage')}
          </button>
        </div>
        <img className="rv2-hero-art" src={heroBannerArtUrl} alt={t('artAlt')} draggable={false} />
        <img className="rv2-hero-art-dark" src={heroBannerArtDarkUrl} alt="" draggable={false} />
      </div>

      {/* 当前层级：文件夹卡片独立一行在上，页面卡片一行在下；key 含层级，切换层级时重置批量选中 */}
      <PageGrid
        key={`${projectId}-${activeFolderId ?? 'root'}`}
        projectId={projectId!}
        pages={levelPages ?? []}
        folders={subFolders}
        onOpenFolder={(f) => jumpToFolder(f.id)}
        onCreateFolder={() => setFolderModal({ mode: 'create' })}
        addLink={`/project/${projectId}/new${activeFolderId ? `?folderId=${activeFolderId}` : ''}`}
        batchMode={batchMode}
        onToggleBatch={() => setBatchMode(!batchMode)}
      />

      {allFolders !== undefined && levelPages !== undefined && allFolders.length === 0 && levelPages.length === 0 && (
        <div className="empty-state">
          <p>{t('emptyState')}</p>
        </div>
      )}

      {editing && project && (
        <ProjectModal
          project={project}
          onDone={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      )}

      {folderModal && projectId && (
        <FolderModal
          projectId={projectId}
          parentId={activeFolderId || undefined}
          folder={folderModal.folder}
          onDone={closeFolderModal}
          onCancel={() => setFolderModal(null)}
        />
      )}
    </div>
  )
}
