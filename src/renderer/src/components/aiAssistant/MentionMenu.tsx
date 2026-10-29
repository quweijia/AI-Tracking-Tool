import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { db } from '../../db'
import type { AssistantRef, Issue, ReportRecord, WalkthroughPage, Project } from '../../db'

/**
 * @ 引用弹层：输入框键入 @ 后展示，按 项目/页面/报告/问题 四类列出可引用对象，
 * 顶部类型切换 + 关键字过滤（query 为 @ 后已输入的文字）。
 */
interface MentionMenuProps {
  projectId: string
  pageId: string
  query: string
  onPick: (ref: AssistantRef) => void
  onClose: () => void
}

type MentionTab = AssistantRef['type']

export default function MentionMenu({ projectId, pageId, query, onPick, onClose }: MentionMenuProps) {
  const { t } = useTranslation('aiAssistant')
  const [tab, setTab] = useState<MentionTab>('project')
  const kw = query.trim().toLowerCase()

  // 各类条目（现有表直查；页面/报告/问题依赖当前项目/页面，无则列表为空）
  const projects = useLiveQuery(() => db.projects.toArray(), []) ?? []
  const pages = useLiveQuery<WalkthroughPage[]>(
    () => (projectId ? db.pages.where('projectId').equals(projectId).toArray() : Promise.resolve([])),
    [projectId]
  )
  const reports = useLiveQuery<ReportRecord[]>(
    () =>
      projectId
        ? db.reportRecords.where('projectId').equals(projectId).reverse().sortBy('createdAt')
        : Promise.resolve([]),
    [projectId]
  )
  const issues = useLiveQuery<Issue[]>(
    () => (pageId ? db.issues.where('pageId').equals(pageId).reverse().sortBy('createdAt') : Promise.resolve([])),
    [pageId]
  )

  const tabs: { key: MentionTab; label: string }[] = [
    { key: 'project', label: t('mentionProject') },
    { key: 'page', label: t('mentionPage') },
    { key: 'report', label: t('mentionReport') },
    { key: 'issue', label: t('mentionIssue') }
  ]

  const items = useMemo(() => {
    if (tab === 'project') {
      return projects
        .filter((p) => !kw || p.name.toLowerCase().includes(kw))
        .slice(0, 8)
        .map((p) => ({ id: p.id, label: p.name, hint: p.platform.join('/') || '—' }))
    }
    if (tab === 'page') {
      return (pages ?? [])
        .filter((p) => !kw || p.pageName.toLowerCase().includes(kw))
        .slice(0, 8)
        .map((p) => ({ id: p.id, label: p.pageName, hint: p.platform }))
    }
    if (tab === 'report') {
      return (reports ?? [])
        .filter((r) => !kw || r.name.toLowerCase().includes(kw))
        .slice(0, 8)
        .map((r) => ({ id: r.id, label: r.name, hint: String(r.total) }))
    }
    return (issues ?? [])
      .filter((i) => !kw || i.id.toLowerCase().includes(kw) || i.description.toLowerCase().includes(kw))
      .slice(0, 8)
      .map((i) => ({ id: i.id, label: i.id.length > 14 ? `${i.id.slice(0, 14)}…` : i.id, hint: i.description }))
  }, [tab, kw, projects, pages, reports, issues])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="ai-mention-menu" onMouseDown={(e) => e.preventDefault()}>
      <div className="ai-mention-tabs">
        {tabs.map((x) => (
          <button
            key={x.key}
            type="button"
            className={`ai-mention-tab${tab === x.key ? ' active' : ''}`}
            onClick={() => setTab(x.key)}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div className="ai-mention-list">
        {items.length ? (
          items.map((it) => (
            <button
              key={it.id}
              type="button"
              className="ai-mention-item"
              onClick={() =>
                onPick({
                  type: tab,
                  id: it.id,
                  label: it.label
                })
              }
            >
              <span className="ai-mention-item-label">{it.label}</span>
              <span className="ai-mention-item-hint">{it.hint}</span>
            </button>
          ))
        ) : (
          <div className="ai-mention-empty">{t('mentionEmpty')}</div>
        )}
      </div>
    </div>
  )
}
