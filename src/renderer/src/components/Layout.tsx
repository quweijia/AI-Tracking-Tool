import { ReactNode, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, bySort } from '../db'
import { useSettingsStore, type SettingsTab } from '../stores/settings'
import appIconUrl from '../assets/app-icon.png'
import appIconLightUrl from '../assets/app-icon-light.png'

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  )
}

/** 自绘 macOS 窗口控制按钮（原生红绿灯失焦重绘会消失，改为渲染层实现；失焦置灰） */
function WindowControls() {
  const [focused, setFocused] = useState(true)
  useEffect(() => {
    const sync = () => setFocused(document.hasFocus())
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
    }
  }, [])
  return (
    <div className={`window-controls${focused ? '' : ' inactive'}`}>
      <button type="button" className="win-btn close" title="关闭" onClick={() => window.electronAPI.closeWindow()}>
        <svg viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" aria-hidden>
          <path d="M1.2 1.2l5.6 5.6M6.8 1.2 1.2 6.8" />
        </svg>
      </button>
      <button type="button" className="win-btn min" title="最小化" onClick={() => window.electronAPI.minimizeWindow()}>
        <svg viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" aria-hidden>
          <path d="M1.2 4h5.6" />
        </svg>
      </button>
      <button type="button" className="win-btn max" title="最大化" onClick={() => window.electronAPI.maximizeWindow()}>
        <svg viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M1.2 5V1.2H5" />
          <path d="M6.8 3v3.8H3" />
        </svg>
      </button>
    </div>
  )
}

/** 侧边栏展开/收起按钮 icon（面板 + 箭头，收起时翻转指向） */
function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ transform: collapsed ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }}
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9.5 4v16" />
      <path d="m16.5 9.5-2.5 2.5 2.5 2.5" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function CaretIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  )
}

function CpuIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="5" y="5" width="14" height="14" rx="2.5" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </svg>
  )
}

function SlidersIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </svg>
  )
}

function PlugIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22v-5" />
      <path d="M9 8V2M15 8V2" />
      <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Z" />
    </svg>
  )
}

function PuzzleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M19.4 12.6c0-.6.5-1.4 1.1-2 .8-.8.5-2.2-.6-2.6-.9-.3-1.9-.7-1.9-.7s-.4-1-.7-1.9c-.4-1.1-1.8-1.4-2.6-.6-.6.6-1.4 1.1-2 1.1s-1.4-.5-2-1.1c-.8-.8-2.2-.5-2.6.6-.3.9-.7 1.9-.7 1.9s-1 .4-1.9.7c-1.1.4-1.4 1.8-.6 2.6.6.6 1.1 1.4 1.1 2s-.5 1.4-1.1 2c-.8.8-.5 2.2.6 2.6.9.3 1.9.7 1.9.7s.4 1 .7 1.9c.4 1.1 1.8 1.4 2.6.6.6-.6 1.4-1.1 2-1.1s1.4.5 2 1.1c.8.8 2.2.5 2.6-.6.3-.9.7-1.9.7-1.9s1-.4 1.9-.7c1.1-.4 1.4-1.8.6-2.6-.6-.6-1.1-1.4-1.1-2Z" />
    </svg>
  )
}

function ShieldIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function GlobeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
    </svg>
  )
}

function InfoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8h.01M12 12v4" />
    </svg>
  )
}

/** 设置中心导航配置（渲染进程侧边栏 + 设置页共用） */
const SETTINGS_TABS: { key: SettingsTab; label: string; icon: ReactNode }[] = [
  { key: 'models', label: 'AI 模型管理', icon: <CpuIcon /> },
  { key: 'general', label: '通用设置', icon: <SlidersIcon /> },
  { key: 'mcp', label: 'MCP 管理', icon: <PlugIcon /> },
  { key: 'skills', label: 'SkillHub', icon: <PuzzleIcon /> },
  { key: 'auth', label: '应用授权', icon: <ShieldIcon /> },
  { key: 'browser', label: '浏览器', icon: <GlobeIcon /> },
  { key: 'about', label: '关于应用', icon: <InfoIcon /> }
]

/** 设置模式下侧边栏替换为设置分区导航（与设置页内容区经 zustand 同步） */
function SettingsNav() {
  const { tab, setTab } = useSettingsStore()
  return (
    <nav className="app-nav">
      <div className="nav-section-label">设置</div>
      {SETTINGS_TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          className={`nav-settings-item ${tab === t.key ? 'active' : ''}`}
          onClick={() => setTab(t.key)}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </nav>
  )
}

/** 顶部通栏搜索：全局检索项目 / 版本 / 页面，⌘K 快捷聚焦 */
function TopbarSearch() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const query = q.trim().toLowerCase()

  const projects = useLiveQuery(() => db.projects.toArray(), []) ?? []
  const pages = useLiveQuery(() => db.pages.toArray(), []) ?? []
  const versions = useLiveQuery(() => db.versions.toArray(), []) ?? []

  // ⌘K / Ctrl+K 聚焦搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const projHits = query ? projects.filter((p) => p.name.toLowerCase().includes(query)).slice(0, 4) : []
  const verHits = query ? versions.filter((v) => v.name.toLowerCase().includes(query)).slice(0, 4) : []
  const pageHits = query ? pages.filter((p) => p.pageName.toLowerCase().includes(query)).slice(0, 6) : []
  const hasHits = projHits.length > 0 || verHits.length > 0 || pageHits.length > 0
  const showPop = focused && query.length > 0

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? '未知项目'
  const versionName = (id: string) => versions.find((v) => v.id === id)?.name ?? ''

  const go = (path: string) => {
    setQ('')
    setFocused(false)
    inputRef.current?.blur()
    navigate(path)
  }

  return (
    <div className="topbar-search">
      <span className="search-icon">
        <SearchIcon />
      </span>
      <input
        ref={inputRef}
        className="topbar-search-input"
        placeholder="搜索项目、版本和页面"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setQ('')
            e.currentTarget.blur()
          }
        }}
      />
      <kbd className="search-kbd">⌘K</kbd>
      {showPop && (
        <div className="search-pop">
          {!hasHits && <p className="search-empty">未找到与「{q.trim()}」相关的内容</p>}
          {projHits.length > 0 && <p className="search-group">项目</p>}
          {projHits.map((p) => (
            <button
              key={p.id}
              type="button"
              className="search-item"
              onMouseDown={(e) => {
                e.preventDefault()
                go(`/project/${p.id}`)
              }}
            >
              <span className="search-item-name">{p.name}</span>
              <span className="search-item-sub">项目</span>
            </button>
          ))}
          {verHits.length > 0 && <p className="search-group">版本</p>}
          {verHits.map((v) => (
            <button
              key={v.id}
              type="button"
              className="search-item"
              onMouseDown={(e) => {
                e.preventDefault()
                go(`/project/${v.projectId}`)
              }}
            >
              <span className="search-item-name">{v.name}</span>
              <span className="search-item-sub">{projectName(v.projectId)}</span>
            </button>
          ))}
          {pageHits.length > 0 && <p className="search-group">页面</p>}
          {pageHits.map((p) => (
            <button
              key={p.id}
              type="button"
              className="search-item"
              onMouseDown={(e) => {
                e.preventDefault()
                go(`/project/${p.projectId}/page/${p.id}`)
              }}
            >
              <span className="search-item-name">{p.pageName}</span>
              <span className="search-item-sub">
                {projectName(p.projectId)}
                {versionName(p.versionId) ? ` / ${versionName(p.versionId)}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 拖拽排序节点信息：kind 决定可放置目标类型，parentId 限定只能在同一父节点内移动 */
type DragInfo = { kind: 'project' | 'version' | 'page'; id: string; parentId: string | null }

/** 拖拽排序落库：把 fromId 移到 toId 前/后，整列重排 sortNo（步长 10） */
async function reorderList(
  which: 'projects' | 'versions' | 'pages',
  list: { id: string }[],
  fromId: string,
  toId: string,
  pos: 'before' | 'after'
) {
  if (fromId === toId) return
  const ids = list.map((x) => x.id).filter((id) => id !== fromId)
  const toIndex = ids.indexOf(toId)
  if (toIndex < 0) return
  ids.splice(pos === 'before' ? toIndex : toIndex + 1, 0, fromId)
  for (let i = 0; i < ids.length; i++) {
    const changes = { sortNo: (i + 1) * 10 }
    if (which === 'projects') await db.projects.update(ids[i], changes)
    else if (which === 'versions') await db.versions.update(ids[i], changes)
    else await db.pages.update(ids[i], changes)
  }
}

/** 侧边栏树状菜单：最近访问入口 + 项目列表（项目 → 版本 → 页面） */
function SidebarTree() {
  const location = useLocation()
  const navigate = useNavigate()
  const projects = useLiveQuery(() => db.projects.toArray(), []) ?? []
  const versions = useLiveQuery(() => db.versions.toArray(), []) ?? []
  const pages = useLiveQuery(() => db.pages.toArray(), []) ?? []

  const [projectsOpen, setProjectsOpen] = useState(false)
  /** 各项目节点的展开状态 */
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  /** 各版本节点的展开状态 */
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(new Set())
  /** 显式选中的版本（点击版本名即高亮，点其他行或离开项目后取消） */
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
  /** 拖拽中的节点 / 放置指示（before/after 蓝色插线） */
  const [drag, setDrag] = useState<DragInfo | null>(null)
  const [dropHint, setDropHint] = useState<{ kind: DragInfo['kind']; id: string; pos: 'before' | 'after' } | null>(null)

  const routeMatch = location.pathname.match(/^\/project\/([^/]+)(?:\/page\/([^/]+))?/)
  const routeProjectId = routeMatch?.[1] ?? null
  const routePageId = routeMatch?.[2] ?? null

  // 路由进入某项目时自动展开该项目节点
  useEffect(() => {
    if (!routeProjectId) return
    setExpandedProjects((prev) => new Set(prev).add(routeProjectId))
  }, [routeProjectId])

  const pagesByVersion = useMemo(() => {
    const m = new Map<string, typeof pages>()
    pages.forEach((p) => {
      if (!p.versionId) return
      const arr = m.get(p.versionId) ?? []
      arr.push(p)
      m.set(p.versionId, arr)
    })
    // 页面按手动排序值（拖拽）排序，未拖过的按创建时间
    ;[...m.values()].forEach((arr) => arr.sort(bySort))
    return m
  }, [pages])

  // 路由进入某页面时自动展开其所属版本节点
  const routePage = routePageId ? pages.find((pg) => pg.id === routePageId) : null
  const routeVersionId = routePage?.versionId
  useEffect(() => {
    if (routeVersionId) setExpandedVersions((prev) => new Set(prev).add(routeVersionId))
  }, [routeVersionId])

  // 离开项目作用域时清除版本选中
  useEffect(() => {
    if (routeProjectId === null) setSelectedVersion(null)
  }, [routeProjectId])

  const versionsByProject = useMemo(() => {
    const m = new Map<string, typeof versions>()
    versions.forEach((v) => {
      const arr = m.get(v.projectId) ?? []
      arr.push(v)
      m.set(v.projectId, arr)
    })
    // 版本按手动排序值（拖拽）排序，未拖过的按创建时间
    ;[...m.values()].forEach((arr) => arr.sort(bySort))
    return m
  }, [versions])

  // 项目按手动排序值（拖拽）排序，未拖过的按创建时间
  const sortedProjects = useMemo(() => [...projects].sort(bySort), [projects])

  const toggleInSet = (setter: typeof setExpandedProjects, id: string) =>
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // ===== 拖拽排序（项目/版本/页面，仅同类型且同父节点内移动） =====
  const handleDragStart = (info: DragInfo) => (e: DragEvent) => {
    setDrag(info)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', info.id)
  }

  const handleDragEnd = () => {
    setDrag(null)
    setDropHint(null)
  }

  const canDropOn = (kind: DragInfo['kind'], parentId: string | null, rowId: string) =>
    drag !== null && drag.kind === kind && drag.parentId === parentId && drag.id !== rowId

  const handleDragOver = (kind: DragInfo['kind'], parentId: string | null, rowId: string) => (e: DragEvent) => {
    if (!canDropOn(kind, parentId, rowId)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setDropHint((prev) => (prev && prev.id === rowId && prev.pos === pos ? prev : { kind, id: rowId, pos }))
  }

  const handleDragLeave = (rowId: string) => (e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setDropHint((prev) => (prev?.id === rowId ? null : prev))
  }

  const handleDrop = (
    kind: DragInfo['kind'],
    parentId: string | null,
    rowId: string,
    list: { id: string }[]
  ) => (e: DragEvent) => {
    if (!drag || !canDropOn(kind, parentId, rowId)) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    const fromId = drag.id
    setDrag(null)
    setDropHint(null)
    void reorderList(
      kind === 'project' ? 'projects' : kind === 'version' ? 'versions' : 'pages',
      list,
      fromId,
      rowId,
      pos
    )
  }

  /** 行样式：拼拖拽中/放置插线指示类 */
  const rowCls = (kind: DragInfo['kind'], id: string, base: string) =>
    `${base}${drag?.id === id ? ' dragging' : ''}${
      dropHint && dropHint.kind === kind && dropHint.id === id ? ` drop-${dropHint.pos}` : ''
    }`

  return (
    <>
      {/* 最近访问：跳转独立页面（整行可点，含左侧 icon） */}
      <Link to="/recent" className={`nav-root-row ${location.pathname === '/recent' ? 'active' : ''}`}>
        <span className="root-icon">
          <ClockIcon />
        </span>
        <span className="tree-root-label">最近访问</span>
      </Link>

      {/* 项目列表（子目录为项目树）：仅项目列表页高亮，/recent 时不选中 */}
      <Link
        to="/"
        className={`nav-root-row ${location.pathname === '/' ? 'active' : ''}`}
        onClick={() => setProjectsOpen(!projectsOpen)}
      >
        <span className="root-icon">
          <FolderIcon />
        </span>
        <span className="tree-root-label">项目列表</span>
      </Link>
      {projectsOpen && (
        <div className="nav-tree">
          {sortedProjects.map((p) => {
            const projOpen = expandedProjects.has(p.id)
            const projVersions = versionsByProject.get(p.id) ?? []
            const projActive = routeProjectId === p.id && !routePageId && selectedVersion === null
            return (
              <div key={p.id} className="tree-project">
                <div
                  className={rowCls('project', p.id, `tree-row ${projActive ? 'active' : ''}`)}
                  draggable
                  onDragStart={handleDragStart({ kind: 'project', id: p.id, parentId: null })}
                  onDragEnd={handleDragEnd}
                  onDragOver={handleDragOver('project', null, p.id)}
                  onDragLeave={handleDragLeave(p.id)}
                  onDrop={handleDrop('project', null, p.id, sortedProjects)}
                >
                  <button
                    type="button"
                    className={`tree-caret ${projOpen ? 'open' : ''}`}
                    onClick={() => toggleInSet(setExpandedProjects, p.id)}
                    title={projOpen ? '收起' : '展开'}
                  >
                    <CaretIcon />
                  </button>
                  <Link
                    to={`/project/${p.id}`}
                    className="tree-label"
                    onClick={() => {
                      setExpandedProjects((prev) => new Set(prev).add(p.id))
                      setSelectedVersion(null)
                    }}
                    title={p.name}
                  >
                    {p.name}
                  </Link>
                </div>
                {projOpen &&
                  projVersions.map((v) => {
                    const vOpen = expandedVersions.has(v.id)
                    const vPages = pagesByVersion.get(v.id) ?? []
                    return (
                      <div key={v.id} className="tree-branch">
                        <div
                          className={rowCls('version', v.id, `tree-row tree-v2 ${selectedVersion === v.id ? 'active' : ''}`)}
                          draggable
                          onDragStart={handleDragStart({ kind: 'version', id: v.id, parentId: p.id })}
                          onDragEnd={handleDragEnd}
                          onDragOver={handleDragOver('version', p.id, v.id)}
                          onDragLeave={handleDragLeave(v.id)}
                          onDrop={handleDrop('version', p.id, v.id, projVersions)}
                        >
                          <button
                            type="button"
                            className={`tree-caret ${vOpen ? 'open' : ''}`}
                            onClick={() => toggleInSet(setExpandedVersions, v.id)}
                            title={vOpen ? '收起' : '展开'}
                          >
                            <CaretIcon />
                          </button>
                          <Link
                            to={`/project/${p.id}?v=${v.id}`}
                            className="tree-label dim"
                            onClick={() => {
                              setExpandedVersions((prev) => new Set(prev).add(v.id))
                              setSelectedVersion(v.id)
                            }}
                            title={v.name}
                          >
                            {v.name}
                          </Link>
                          <span className="tree-count">{vPages.length}</span>
                        </div>
                        {vOpen &&
                          vPages.map((pg) => (
                            <Link
                              key={pg.id}
                              to={`/project/${p.id}/page/${pg.id}`}
                              className={rowCls('page', pg.id, `tree-leaf ${routePageId === pg.id ? 'active' : ''}`)}
                              draggable
                              onDragStart={handleDragStart({ kind: 'page', id: pg.id, parentId: v.id })}
                              onDragEnd={handleDragEnd}
                              onDragOver={handleDragOver('page', v.id, pg.id)}
                              onDragLeave={handleDragLeave(pg.id)}
                              onDrop={handleDrop('page', v.id, pg.id, vPages)}
                              onClick={() => setSelectedVersion(null)}
                              title={pg.pageName}
                            >
                              {pg.pageName}
                            </Link>
                          ))}
                      </div>
                    )
                  })}
              </div>
            )
          })}
          {projects.length === 0 && <p className="tree-empty">暂无项目</p>}
        </div>
      )}
    </>
  )
}

export default function Layout({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const isSettings = location.pathname === '/settings'
  const mainRef = useRef<HTMLElement>(null)

  // ===== 深色 / 浅色模式：支持跟随系统 / 手动切换，持久化到 localStorage，挂在 <html data-theme> 上 =====
  const [themeMode, setThemeMode] = useState<'system' | 'light' | 'dark'>(() => {
    const v = localStorage.getItem('app-theme')
    return v === 'dark' || v === 'light' ? v : 'system'
  })
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  // 「跟随系统」时监听系统深浅色变化
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const fn = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])
  const theme = themeMode === 'system' ? (systemDark ? 'dark' : 'light') : themeMode
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  // 设置页「通用设置」切换主题时同步（含跟随系统）
  useEffect(() => {
    const fn = (e: Event) => {
      const m = (e as CustomEvent).detail
      if (m === 'system' || m === 'light' || m === 'dark') setThemeMode(m)
    }
    window.addEventListener('app-theme-change', fn)
    return () => window.removeEventListener('app-theme-change', fn)
  }, [])

  /** 顶栏按钮手动切换：在浅色 / 深色间切换并写回持久化 */
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setThemeMode(next)
    localStorage.setItem('app-theme', next)
  }

  // 路由切换时内容区回到顶部（侧边栏点击项目名等跳转同理）
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [location.pathname])

  // ===== 侧边栏展开 / 收起（持久化到 localStorage） =====
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('app-sidebar-collapsed') === '1'
  )
  const toggleSidebar = () =>
    setSidebarCollapsed((v) => {
      const next = !v
      localStorage.setItem('app-sidebar-collapsed', String(next))
      return next
    })

  // 设置按钮 toggle：在设置页时再点返回上一页
  const toggleSettings = () => {
    if (!isSettings) {
      navigate('/settings')
      return
    }
    if (window.history.length > 1) navigate(-1)
    else navigate('/')
  }

  return (
    <div className="app-shell">
      <header className="app-topbar">
        {/* 自绘窗口控制按钮（替代原生红绿灯） */}
        <WindowControls />
        {/* 仅展示品牌，不做跳转；整条顶栏可拖动窗口（搜索/按钮区除外） */}
        <div className="topbar-brand">
          <img
            className="app-logo-icon"
            src={theme === 'dark' ? appIconUrl : appIconLightUrl}
            alt=""
            width={22}
            height={22}
          />
          AI 走查工具
        </div>
        <TopbarSearch />
        <div className="topbar-actions">
          <button
            type="button"
            className="topbar-icon-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            type="button"
            className={`topbar-icon-btn ${isSettings ? 'active' : ''}`}
            onClick={toggleSettings}
            title={isSettings ? '关闭设置' : '设置'}
          >
            <GearIcon />
          </button>
        </div>
      </header>
      <div className="app-main">
        <aside className={`app-sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
          {isSettings ? (
            <SettingsNav />
          ) : (
            <nav className="app-nav">
              <div className="nav-section-label">工作空间</div>
              <SidebarTree />
            </nav>
          )}
          {/* 展开/收起侧边栏（底部） */}
          <div className="sidebar-toggle-row">
            <button
              type="button"
              className="sidebar-toggle"
              onClick={toggleSidebar}
              title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
            >
              <SidebarToggleIcon collapsed={sidebarCollapsed} />
            </button>
          </div>
          <div className="app-sidebar-footer">
            Made by{' '}
            <a
              className="footer-link"
              href="https://quweijia.is-a.dev/"
              target="_blank"
              rel="noreferrer"
            >
              Vic Qu
            </a>
          </div>
        </aside>
        <main className="app-content" ref={mainRef}>{children}</main>
      </div>
    </div>
  )
}
