import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { db, IssueStatus, Project, platformList } from '../db'
import { tr } from '../i18n'
import { PlatformBadge } from './PlatformBadge'

/** 已解决问题状态（与问题清单「已解决」筛选口径一致） */
const RESOLVED_STATUSES: IssueStatus[] = ['fixed', 'ignored', 'design-confirmed']

/** 相对时间（非组件环境，经 tr 取文案） */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const m = 60e3
  const h = 36e5
  const d = 864e5
  if (diff < m) return tr('justNow', 'projectCard')
  if (diff < h) return tr('minutesAgo', 'projectCard', { n: Math.floor(diff / m) })
  if (diff < d) return tr('hoursAgo', 'projectCard', { n: Math.floor(diff / h) })
  if (diff < 30 * d) return tr('daysAgo', 'projectCard', { n: Math.floor(diff / d) })
  return tr('monthsAgo', 'projectCard', { n: Math.floor(diff / (30 * d)) })
}

/** 无 Logo 占位底色：默认按项目 id 稳定散列取色，各项目颜色错开（用户自选 logoColor 优先） */
export const LOGO_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f43f5e', '#14b8a6', '#0ea5e9', '#f97316', '#22c55e']
export const logoColorOf = (id: string) => {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return LOGO_COLORS[h % LOGO_COLORS.length]
}
/** 文字 Logo 实际底色：自选色优先，否则按 id 散列 */
export const logoBgOf = (p: Pick<Project, 'id' | 'logoColor'>) => p.logoColor || logoColorOf(p.id)

/** 项目 Logo 头像：有图显示图片，无图显示名称首字符（与项目详情页样式一致） */
export function ProjectLogo({
  project,
  size = 36
}: {
  project: Project
  size?: number
}) {
  const [url, setUrl] = useState('')

  useEffect(() => {
    if (!project.logoPath) {
      setUrl('')
      return
    }
    let alive = true
    window.electronAPI
      .readImage(project.logoPath)
      .then((d) => {
        if (alive) setUrl(d ?? '')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [project.logoPath])

  return (
    <span
      className="project-logo"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        ...(url ? {} : { background: logoBgOf(project) })
      }}
      title={project.name}
    >
      {url ? <img src={url} alt="" draggable={false} /> : project.name.slice(0, 1)}
    </span>
  )
}

/** 项目聚合统计：文件夹数 / 页面数 / 标注解决进度 / 最近更新 */
export function useProjectStats(projectId: string) {
  return useLiveQuery(async () => {
    const folders = await db.folders.where('projectId').equals(projectId).toArray()
    const pages = await db.pages.filter((p) => p.projectId === projectId).toArray()
    const issues = pages.length
      ? await db.issues.where('pageId').anyOf(pages.map((p) => p.id)).toArray()
      : []
    const reportable = issues.filter((i) => !(i.isAISuggested && !i.aiConfirmed))
    const resolved = reportable.filter((i) => RESOLVED_STATUSES.includes(i.status)).length
    const proj = await db.projects.get(projectId)
    const latest = pages.reduce((m, p) => Math.max(m, p.createdAt), proj?.updatedAt ?? 0)
    return {
      folderCount: folders.length,
      pageCount: pages.length,
      total: reportable.length,
      resolved,
      latest
    }
  }, [projectId])
}

function ProgressBlock({ stats }: { stats: ReturnType<typeof useProjectStats> }) {
  const { t } = useTranslation('projectCard')
  // 统计未加载时保持 0%：进入页面后进度条从 0 平滑涨到当前进度（而不是从 100% 缩回）
  const pct = !stats ? 0 : stats.total === 0 ? 100 : Math.round((stats.resolved / stats.total) * 100)
  return (
    <div className="card-progress">
      <div className="progress-text">
        <span>
          {stats
            ? t('resolvedAnnotations', { resolved: stats.resolved, total: stats.total })
            : t('loading')}
        </span>
        <span>{stats ? `${pct}%` : ''}</span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** 项目卡片拖拽注入 props：handlers 透传到卡片根节点，dragging/dropPos 控制高亮样式 */
export interface CardDnd {
  dragging?: boolean
  dropPos?: 'before' | 'after' | null
  handlers?: React.HTMLAttributes<HTMLAnchorElement>
}

/** 项目卡片（平铺视图）：平台标签 + 标注解决进度 + 版本/页面统计 + 更新时间；可拖动排序 */
export function ProjectCard({ project, dnd }: { project: Project; dnd?: CardDnd }) {
  const { t } = useTranslation('projectCard')
  const stats = useProjectStats(project.id)

  return (
    <Link
      to={`/project/${project.id}`}
      className={`project-card card${dnd?.dragging ? ' dragging' : ''}${dnd?.dropPos ? ` drop-${dnd.dropPos}` : ''}`}
      {...dnd?.handlers}
    >
      <div className="card-top">
        <ProjectLogo project={project} size={40} />
        <h3>{project.name}</h3>
      </div>
      <div className="card-tags">
        {platformList(project.platform).map((p) => (
          <PlatformBadge key={p} platform={p} />
        ))}
      </div>
      <ProgressBlock stats={stats} />
      <div className="card-foot">
        <span>{stats ? t('folderPageCount', { folders: stats.folderCount, pages: stats.pageCount }) : ''}</span>
        <span>{stats ? t('updatedAt', { time: timeAgo(stats.latest) }) : ''}</span>
      </div>
    </Link>
  )
}

/** 项目行（列表视图）：端类型列固定宽，右侧明细对齐不随端数量偏移；可拖动排序 */
export function ProjectRow({ project, dnd }: { project: Project; dnd?: CardDnd }) {
  const { t } = useTranslation('projectCard')
  const stats = useProjectStats(project.id)
  const pct = !stats ? 0 : stats.total === 0 ? 100 : Math.round((stats.resolved / stats.total) * 100)

  return (
    <Link
      to={`/project/${project.id}`}
      className={`project-row${dnd?.dragging ? ' dragging' : ''}${dnd?.dropPos ? ` drop-${dnd.dropPos}` : ''}`}
      {...dnd?.handlers}
    >
      <ProjectLogo project={project} size={32} />
      <span className="row-name">{project.name}</span>
      <span className="row-platforms">
        {platformList(project.platform).map((p) => (
          <PlatformBadge key={p} platform={p} />
        ))}
      </span>
      <span className="row-progress">
        <span className="row-progress-bar" title={t('resolveProgress', { pct })}>
          <span className="row-progress-fill" style={{ width: `${pct}%` }} />
        </span>
        {stats
          ? t('resolvedWithPct', { resolved: stats.resolved, total: stats.total, pct })
          : t('loading')}
      </span>
      <span className="row-counts">
        {stats ? t('folderPageCountRow', { folders: stats.folderCount, pages: stats.pageCount }) : ''}
      </span>
      <span className="row-time">{stats ? t('updatedAt', { time: timeAgo(stats.latest) }) : ''}</span>
      <svg className="row-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m9 18 6-6-6-6" />
      </svg>
    </Link>
  )
}
