import { ReactNode, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { tr } from '../i18n'
import { db, bySort } from '../db'
import { useSettingsStore, type SettingsTab } from '../stores/settings'
import { useAiTasksStore, type AiTask } from '../stores/aiTasks'
import { useAppIconStore, findAppIcon, type AppIconKey } from '../stores/appIcon'
import appIconUrl from '../assets/app-icon.png'
import AiAssistant from './aiAssistant/AiAssistant'
import appIconLightUrl from '../assets/app-icon-light.png'

/** 侧边栏宽度拖拽（右缘手柄）：范围 180–420px，默认 200，持久化到 localStorage */
const SIDEBAR_WIDTH_KEY = 'app-sidebar-width'
const SIDEBAR_MIN_WIDTH = 180
const SIDEBAR_MAX_WIDTH = 420
const clampSidebarWidth = (w: number) => Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, w)))

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
  const { t } = useTranslation('layout')
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
      <button type="button" className="win-btn close" title={t('winClose')} onClick={() => window.electronAPI.closeWindow()}>
        <svg viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" aria-hidden>
          <path d="M1.2 1.2l5.6 5.6M6.8 1.2 1.2 6.8" />
        </svg>
      </button>
      <button type="button" className="win-btn min" title={t('winMinimize')} onClick={() => window.electronAPI.minimizeWindow()}>
        <svg viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" aria-hidden>
          <path d="M1.2 4h5.6" />
        </svg>
      </button>
      <button type="button" className="win-btn max" title={t('winMaximize')} onClick={() => window.electronAPI.maximizeWindow()}>
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

/** 设计规范 icon（调色板） */
function PaletteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 21a9 9 0 1 1 9-9c0 2.5-2 3.5-3.5 3.5H15a2 2 0 0 0-1.5 3.3c.4.5.5 1.2.1 1.6-.4.4-.9.6-1.6.6Z" />
      <circle cx="7.5" cy="11" r="1" />
      <circle cx="10.5" cy="7" r="1" />
      <circle cx="15" cy="7.5" r="1" />
    </svg>
  )
}

/** 移动端规范 icon（手机） */
function PhoneIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </svg>
  )
}

/** PC 端规范 icon（显示器） */
function MonitorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}

/** 可视化大屏规范 icon（大屏 + 柱状图） */
function ScreenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M7 21h10M12 17v4" />
      <path d="M7 13v-2M11 13V8M15 13v-4" />
    </svg>
  )
}

/** Electron 桌面端规范 icon（应用窗口） */
function AppWindowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="M6.5 6.5h.01M9.2 6.5h.01" />
    </svg>
  )
}

/** 规范分类端映射图标：h5→手机 / dashboard→大屏 / electron→应用窗口 / 其余→显示器 */
export function SpecPlatIcon({ platformKey }: { platformKey: string }) {
  if (platformKey === 'h5') return <PhoneIcon />
  if (platformKey === 'dashboard') return <ScreenIcon />
  if (platformKey === 'electron') return <AppWindowIcon />
  return <MonitorIcon />
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

/** 分析报告 icon（文档 + 图表） */
function ReportDocIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M9 17v-3M13 17v-6M17 17v-4" />
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

/** 容差设置 icon（标尺刻度） */
function RulerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 9h18v6H3z" />
      <path d="M7 9v3M11 9v2M15 9v3M19 9v2" />
    </svg>
  )
}

/** AI 小助手 icon（机器人，与悬浮球形象呼应） */
function BotIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </svg>
  )
}

/** 设置模式下侧边栏替换为设置分区导航（与设置页内容区经 zustand 同步） */
function SettingsNav() {
  const { tab, setTab } = useSettingsStore()
  const { t } = useTranslation('layout')
  /** 设置中心导航配置（渲染进程侧边栏 + 设置页共用；通用设置置顶） */
  const tabs: { key: SettingsTab; label: string; icon: ReactNode }[] = [
    { key: 'general', label: t('navGeneral'), icon: <SlidersIcon /> },
    { key: 'tolerance', label: t('navTolerance'), icon: <RulerIcon /> },
    { key: 'models', label: t('navModels'), icon: <CpuIcon /> },
    { key: 'assistant', label: t('navAssistant'), icon: <BotIcon /> },
    { key: 'mcp', label: t('navMcp'), icon: <PlugIcon /> },
    { key: 'skills', label: t('navSkills'), icon: <PuzzleIcon /> },
    { key: 'auth', label: t('navAuth'), icon: <ShieldIcon /> },
    { key: 'browser', label: t('navBrowser'), icon: <GlobeIcon /> },
    { key: 'about', label: t('navAbout'), icon: <InfoIcon /> }
  ]
  return (
    <nav className="app-nav">
      <div className="nav-section-label">{t('settingsSection')}</div>
      {tabs.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`nav-settings-item ${tab === item.key ? 'active' : ''}`}
          onClick={() => setTab(item.key)}
        >
          <span className="nav-settings-icon">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </nav>
  )
}

/** 顶部通栏搜索：全局检索项目 / 文件夹 / 页面，⌘K 快捷聚焦 */
function TopbarSearch() {
  const { t } = useTranslation('layout')
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const query = q.trim().toLowerCase()

  const projects = useLiveQuery(() => db.projects.toArray(), []) ?? []
  const pages = useLiveQuery(() => db.pages.toArray(), []) ?? []
  const folders = useLiveQuery(() => db.folders.toArray(), []) ?? []

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
  const folderHits = query ? folders.filter((v) => v.name.toLowerCase().includes(query)).slice(0, 4) : []
  const pageHits = query ? pages.filter((p) => p.pageName.toLowerCase().includes(query)).slice(0, 6) : []
  const hasHits = projHits.length > 0 || folderHits.length > 0 || pageHits.length > 0
  const showPop = focused && query.length > 0

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? t('unknownProject')
  const folderName = (id: string | undefined) => folders.find((v) => v.id === id)?.name ?? ''

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
        placeholder={t('searchPlaceholder')}
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
          {!hasHits && <p className="search-empty">{t('searchEmpty', { query: q.trim() })}</p>}
          {projHits.length > 0 && <p className="search-group">{t('groupProjects')}</p>}
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
              <span className="search-item-sub">{t('groupProjects')}</span>
            </button>
          ))}
          {folderHits.length > 0 && <p className="search-group">{t('groupFolders')}</p>}
          {folderHits.map((v) => (
            <button
              key={v.id}
              type="button"
              className="search-item"
              onMouseDown={(e) => {
                e.preventDefault()
                go(`/project/${v.projectId}?f=${v.id}`)
              }}
            >
              <span className="search-item-name">{v.name}</span>
              <span className="search-item-sub">{projectName(v.projectId)}</span>
            </button>
          ))}
          {pageHits.length > 0 && <p className="search-group">{t('groupPages')}</p>}
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
                {folderName(p.folderId) ? ` / ${folderName(p.folderId)}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 拖拽排序节点信息：kind 决定可放置目标类型，parentId 限定只能在同一父节点内移动 */
type DragInfo = { kind: 'project' | 'folder' | 'page'; id: string; parentId: string | null }

/** 1×1 透明图：侧边栏拖拽时用 setDragImage 隐藏浏览器默认的灰色元素拖影 */
const TRANSPARENT_DRAG_IMG = (() => {
  const img = new Image(1, 1)
  img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  return img
})()

/** 拖拽排序落库：把 fromId 移到 toId 前/后，整列重排 sortNo（步长 10） */
async function reorderList(
  which: 'projects' | 'folders' | 'pages',
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
    else if (which === 'folders') await db.folders.update(ids[i], changes)
    else await db.pages.update(ids[i], changes)
  }
}

/** 侧边栏树状菜单：最近访问入口 + 项目列表（项目 → 文件夹与页面并列） */
function SidebarTree() {
  const { t } = useTranslation('layout')
  const location = useLocation()
  const navigate = useNavigate()
  const projects = useLiveQuery(() => db.projects.toArray(), []) ?? []
  const folders = useLiveQuery(() => db.folders.toArray(), []) ?? []
  const pages = useLiveQuery(() => db.pages.toArray(), []) ?? []
  /** 设计规范端分类（侧边栏「设计规范」分组的子项） */
  const specCats = useLiveQuery(() => db.specCategories.toArray(), []) ?? []

  const { t: t2 } = useTranslation('specsPage')

  const [projectsOpen, setProjectsOpen] = useState(false)
  /** 设计规范分组展开状态（持久化，默认展开） */
  const [specsOpen, setSpecsOpen] = useState(() => localStorage.getItem('app-specs-nav-open') !== '0')
  /** 各项目节点的展开状态 */
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  /** 各文件夹节点的展开状态 */
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  /** 拖拽中的节点 / 放置指示（before/after 蓝色插线） */
  const [drag, setDrag] = useState<DragInfo | null>(null)
  const [dropHint, setDropHint] = useState<{ kind: DragInfo['kind']; id: string; pos: 'before' | 'after' } | null>(null)

  const routeMatch = location.pathname.match(/^\/project\/([^/]+)(?:\/page\/([^/]+))?/)
  const routeProjectId = routeMatch?.[1] ?? null
  const routePageId = routeMatch?.[2] ?? null
  /** 文件夹视图参数（/project/:pid?f=:fid）：文件夹高亮直接由路由派生，避免 state 残留导致双选中 */
  const routeFolderParam = new URLSearchParams(location.search).get('f')

  // 路由进入某项目时自动展开该项目节点
  useEffect(() => {
    if (!routeProjectId) return
    setExpandedProjects((prev) => new Set(prev).add(routeProjectId))
  }, [routeProjectId])

  /** 设计规范分组：路由命中 /specs/* 时自动展开分组 */
  const specsActive = location.pathname === '/specs' || location.pathname.startsWith('/specs/')
  /** 仅总览页（/specs）时分组行高亮；选中子分类时父级保持非高亮 */
  const specsRootActive = location.pathname === '/specs'
  const sortedSpecCats = useMemo(() => [...specCats].sort(bySort), [specCats])

  // 路由进入设计规范页时自动展开分组（手风琴：同时收起项目列表，保证侧边栏同时只有一棵展开树）
  useEffect(() => {
    if (specsActive) {
      setSpecsOpen(true)
      setProjectsOpen(false)
    }
  }, [specsActive])

  /** 文件夹 → 其下页面 */
  const pagesByFolder = useMemo(() => {
    const m = new Map<string, typeof pages>()
    pages.forEach((p) => {
      if (!p.folderId) return
      const arr = m.get(p.folderId) ?? []
      arr.push(p)
      m.set(p.folderId, arr)
    })
    // 页面按手动排序值（拖拽）排序，未拖过的按创建时间
    ;[...m.values()].forEach((arr) => arr.sort(bySort))
    return m
  }, [pages])

  // 路由进入某页面时自动展开其所属文件夹节点
  const routePage = routePageId ? pages.find((pg) => pg.id === routePageId) : null
  const routeFolderId = routePage?.folderId
  useEffect(() => {
    if (routeFolderId) setExpandedFolders((prev) => new Set(prev).add(routeFolderId))
  }, [routeFolderId])

  /** 项目根级文件夹（parentId 为空）与各文件夹的子文件夹（多层嵌套） */
  const rootFoldersByProject = useMemo(() => {
    const m = new Map<string, typeof folders>()
    folders
      .filter((v) => !v.parentId)
      .forEach((v) => {
        const arr = m.get(v.projectId) ?? []
        arr.push(v)
        m.set(v.projectId, arr)
      })
    // 文件夹按手动排序值（拖拽）排序，未拖过的按创建时间
    ;[...m.values()].forEach((arr) => arr.sort(bySort))
    return m
  }, [folders])

  const childFoldersByParent = useMemo(() => {
    const m = new Map<string, typeof folders>()
    folders
      .filter((v) => v.parentId)
      .forEach((v) => {
        const arr = m.get(v.parentId!) ?? []
        arr.push(v)
        m.set(v.parentId!, arr)
      })
    ;[...m.values()].forEach((arr) => arr.sort(bySort))
    return m
  }, [folders])

  // 项目按手动排序值（拖拽）排序，未拖过的按创建时间
  const sortedProjects = useMemo(() => [...projects].sort(bySort), [projects])

  /** 递归渲染文件夹节点（多层嵌套：文件夹与页面并列展示；depth 决定逐级缩进） */
  const renderFolderNode = (
    f: (typeof folders)[number],
    proj: (typeof projects)[number],
    siblings: typeof folders,
    depth = 0
  ) => {
    const vOpen = expandedFolders.has(f.id)
    const vPages = pagesByFolder.get(f.id) ?? []
    const children = childFoldersByParent.get(f.id) ?? []
    // 拖拽层级约定：根级文件夹挂在项目下互拖，子级文件夹在同一父级内互拖
    const parentKey = f.parentId ?? proj.id
    return (
      <div key={f.id} className="tree-branch">
        <div
          className={rowCls('folder', f.id, `tree-row tree-v2 ${routeFolderParam === f.id && routeProjectId === proj.id ? 'active' : ''}`)}
          style={{ paddingLeft: 40 + depth * 16 }}
          draggable
          onDragStart={handleDragStart({ kind: 'folder', id: f.id, parentId: parentKey })}
          onDragEnd={handleDragEnd}
          onDragOver={handleDragOver('folder', parentKey, f.id)}
          onDragLeave={handleDragLeave(f.id)}
          onDrop={handleDrop('folder', parentKey, f.id, siblings)}
        >
          <button
            type="button"
            className={`tree-caret ${vOpen ? 'open' : ''}`}
            onClick={() => toggleInSet(setExpandedFolders, f.id)}
            title={vOpen ? t('treeCollapse') : t('treeExpand')}
          >
            <CaretIcon />
          </button>
          <Link
            to={`/project/${proj.id}?f=${f.id}`}
            className="tree-label dim"
            onClick={() => {
              setExpandedFolders((prev) => new Set(prev).add(f.id))
            }}
            title={f.name}
          >
            {f.name}
          </Link>
          <span className="tree-count">{vPages.length}</span>
        </div>
        {vOpen && (
          <>
            {children.map((c) => renderFolderNode(c, proj, children, depth + 1))}
            {vPages.map((pg) => (
              <Link
                key={pg.id}
                to={`/project/${proj.id}/page/${pg.id}`}
                className={rowCls('page', pg.id, `tree-leaf ${routePageId === pg.id ? 'active' : ''}`)}
                style={{ paddingLeft: 62 + depth * 16 }}
                draggable
                onDragStart={handleDragStart({ kind: 'page', id: pg.id, parentId: f.id })}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver('page', f.id, pg.id)}
                onDragLeave={handleDragLeave(pg.id)}
                onDrop={handleDrop('page', f.id, pg.id, vPages)}
                title={pg.pageName}
              >
                {pg.pageName}
              </Link>
            ))}
          </>
        )}
      </div>
    )
  }

  const toggleInSet = (setter: typeof setExpandedProjects, id: string) =>
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // ===== 拖拽排序（项目/文件夹/页面，仅同类型且同父节点内移动） =====
  // 透明拖影：隐藏浏览器默认的灰色元素拖影（拖起时跟随鼠标的标题+链接提示框）
  const handleDragStart = (info: DragInfo) => (e: DragEvent) => {
    setDrag(info)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMG, 0, 0)
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
      kind === 'project' ? 'projects' : kind === 'folder' ? 'folders' : 'pages',
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
      {/* 设计规范：整行跳转总览页，同时展开/收起端分类子项（与项目列表行一致） */}
      {/* nav-group-tree 仅在树展开时挂载：组可收缩（min-height:0）供树内滚动；收起后组不可压缩，防止行被 flex 压缩导致与相邻菜单重叠 */}
      <div className={`nav-group ${specsOpen ? 'nav-group-tree' : ''}`}>
        <Link
          to="/specs"
          className={`nav-root-row specx-group ${specsRootActive ? 'active' : ''}`}
          draggable="false"
          onClick={() => {
            const next = !specsOpen
            setSpecsOpen(next)
            localStorage.setItem('app-specs-nav-open', next ? '1' : '0')
            // 手风琴：展开设计规范时自动收起项目列表，避免两棵树同时超高被压缩
            if (next) setProjectsOpen(false)
          }}
        >
          <span className="root-icon">
            <PaletteIcon />
          </span>
          <span className="tree-root-label">{t('navSpecs')}</span>
          <span className={`specx-caret ${specsOpen ? 'open' : ''}`}>
            <CaretIcon />
          </span>
        </Link>
        {specsOpen && (
          <div className="nav-tree specx-navtree">
            {sortedSpecCats.map((c) => (
              <Link
                key={c.id}
                to={`/specs/${c.id}`}
                className={`tree-row specx-sub ${
                  location.pathname === `/specs/${c.id}` || location.pathname.startsWith(`/specs/${c.id}/`)
                    ? 'active'
                    : ''
                }`}
                draggable="false"
              >
                <span className="specx-sub-ico">
                  <SpecPlatIcon platformKey={c.platformKey} />
                </span>
                <span className="tree-label">{c.builtin ? t2(`platform_${c.platformKey}`) : c.name}</span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* 最近访问：跳转独立页面（整行可点，含左侧 icon） */}
      <div className="nav-group">
        <Link to="/recent" className={`nav-root-row ${location.pathname === '/recent' ? 'active' : ''}`} draggable="false">
          <span className="root-icon">
            <ClockIcon />
          </span>
          <span className="tree-root-label">{t('navRecent')}</span>
        </Link>
      </div>

      {/* 项目列表（子目录为项目树）：仅项目列表页高亮，/recent 时不选中 */}
      <div className={`nav-group ${projectsOpen ? 'nav-group-tree' : ''}`}>
        <Link
          to="/"
          className={`nav-root-row ${location.pathname === '/' ? 'active' : ''}`}
          draggable="false"
          onClick={() => {
            const next = !projectsOpen
            setProjectsOpen(next)
            // 手风琴：展开项目列表时自动收起设计规范分组（含持久化状态）
            if (next) {
              setSpecsOpen(false)
              localStorage.setItem('app-specs-nav-open', '0')
            }
          }}
        >
          <span className="root-icon">
            <FolderIcon />
          </span>
          <span className="tree-root-label">{t('navProjects')}</span>
        </Link>
        {projectsOpen && (
          <div className="nav-tree">
            {sortedProjects.map((p) => {
              const projOpen = expandedProjects.has(p.id)
              const projRootFolders = rootFoldersByProject.get(p.id) ?? []
              // 项目根级未分组页面（与文件夹并列挂在项目下）
              const projRootPages = pages.filter((pg) => pg.projectId === p.id && !pg.folderId).sort(bySort)
              const projActive = routeProjectId === p.id && !routePageId && !routeFolderParam
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
                      title={projOpen ? t('treeCollapse') : t('treeExpand')}
                    >
                      <CaretIcon />
                    </button>
                    <Link
                      to={`/project/${p.id}`}
                      className="tree-label"
                      onClick={() => {
                        setExpandedProjects((prev) => new Set(prev).add(p.id))
                      }}
                      title={p.name}
                    >
                      {p.name}
                    </Link>
                  </div>
                  {projOpen && (
                    <>
                      {projRootFolders.map((v) => renderFolderNode(v, p, projRootFolders))}
                      {/* 项目根级未分组页面：与文件夹并列，仅在项目内互拖排序 */}
                      {projRootPages.map((pg) => (
                        <div key={pg.id} className="tree-branch">
                          <Link
                            to={`/project/${p.id}/page/${pg.id}`}
                            className={rowCls('page', pg.id, `tree-leaf ${routePageId === pg.id ? 'active' : ''}`)}
                            draggable
                            onDragStart={handleDragStart({ kind: 'page', id: pg.id, parentId: p.id })}
                            onDragEnd={handleDragEnd}
                            onDragOver={handleDragOver('page', p.id, pg.id)}
                            onDragLeave={handleDragLeave(pg.id)}
                            onDrop={handleDrop('page', p.id, pg.id, projRootPages)}
                            title={pg.pageName}
                          >
                            {pg.pageName}
                          </Link>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )
            })}
            {projects.length === 0 && <p className="tree-empty">{t('emptyProjects')}</p>}
          </div>
        )}
      </div>

      {/* 分析报告：查看所有导出过的 HTML 走查报告（置于项目列表及其树之后，吸底） */}
      <div className="nav-group">
        <Link to="/reports" className={`nav-root-row ${location.pathname === '/reports' ? 'active' : ''}`} draggable="false">
          <span className="root-icon">
            <ReportDocIcon />
          </span>
          <span className="tree-root-label">{t('navReports')}</span>
        </Link>
      </div>
    </>
  )
}

export default function Layout({ children }: { children: ReactNode }) {
  const { t } = useTranslation('layout')
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

  // 内容滚动超过一屏后，右下角出现「回到顶部」悬浮按钮
  const [showBackTop, setShowBackTop] = useState(false)

  // 路由切换时内容区回到顶部（侧边栏点击项目名等跳转同理）
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
    setShowBackTop(false)
  }, [location.pathname])

  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    const onScroll = () => setShowBackTop(el.scrollTop > 400)
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

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

  // ===== 侧边栏宽度拖拽：右边缘手柄拉宽/缩窄，松开后持久化 =====
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const v = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return Number.isFinite(v) && v > 0 ? clampSidebarWidth(v) : 200
  })
  const sidebarWidthRef = useRef(sidebarWidth)
  const startSidebarResize = (e: ReactMouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidthRef.current
    document.body.classList.add('sidebar-resizing')
    const onMove = (ev: MouseEvent) => {
      const w = clampSidebarWidth(startW + ev.clientX - startX)
      sidebarWidthRef.current = w
      setSidebarWidth(w)
    }
    const onUp = () => {
      document.body.classList.remove('sidebar-resizing')
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidthRef.current))
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ===== AI 识别任务进行中：切页前确认（中断 / 后台运行 / 取消） =====
  const aiTasks = useAiTasksStore((s) => s.tasks)
  const runningTasks = useMemo(() => aiTasks.filter((t) => t.status === 'running'), [aiTasks])
  const [navConfirm, setNavConfirm] = useState<{ go: () => void; tasks: AiTask[] } | null>(null)

  // AI 识别流式进度：更新对应页面进行中任务的提示（按钮文案实时显示耗时与接收字数）
  useEffect(
    () =>
      window.electronAPI.onAiProgress((info) => {
        const sec = Math.round(info.elapsedMs / 1000)
        const note = tr('progressNote', 'layout', { sec, chars: (info.chars / 1000).toFixed(1) })
        useAiTasksStore.getState().progressPage(info.pageName ?? '', note)
      }),
    []
  )

  // ===== 应用图标：顶栏 logo 跟随通用设置的选择；启动时从配置恢复 =====
  const appIconKey = useAppIconStore((s) => s.key)
  const customIconUrl = findAppIcon(appIconKey)?.url ?? null
  useEffect(() => {
    void window.electronAPI.getConfig().then((cfg) => {
      const k = cfg['appIcon'] as AppIconKey | undefined
      if (k && k !== 'default') useAppIconStore.getState().setKey(k)
    })
  }, [])

  // 拦截应用内链接导航（侧边栏树、面包屑等 <a href="#/...">；当前页链接不拦截）
  // 同一轮 AI 识别期间只提示一次：用户确认离开后，后续切换页面/项目不再重复弹窗；任务全部结束后重置
  const navConfirmShownRef = useRef(false)
  useEffect(() => {
    if (runningTasks.length === 0) navConfirmShownRef.current = false
  }, [runningTasks.length])
  useEffect(() => {
    if (runningTasks.length === 0) return
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
      if (!a) return
      const href = a.getAttribute('href') ?? ''
      if (!href.startsWith('#/')) return
      if (href.slice(1) === location.pathname) return
      e.preventDefault()
      e.stopPropagation()
      if (navConfirmShownRef.current) {
        navigate(href.slice(1))
        return
      }
      setNavConfirm({
        go: () => {
          navConfirmShownRef.current = true
          navigate(href.slice(1))
        },
        tasks: runningTasks
      })
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [runningTasks, location.pathname, navigate])

  // 设置按钮 toggle：在设置页时再点返回上一页
  const toggleSettings = () => {
    const guard = (go: () => void) => {
      if (runningTasks.length === 0) {
        go()
      } else if (navConfirmShownRef.current) {
        go()
      } else {
        setNavConfirm({
          go: () => {
            navConfirmShownRef.current = true
            go()
          },
          tasks: runningTasks
        })
      }
    }
    if (!isSettings) {
      // 记录来源页名称，设置页顶部「返回 xx」标题跟随显示
      const p = location.pathname
      const from = p.startsWith('/recent')
        ? t('fromRecent')
        : p.includes('/issues')
          ? t('fromIssues')
          : p.includes('/export')
            ? t('fromExport')
            : /\/page\//.test(p)
              ? t('fromWorkbench')
              : /\/new$/.test(p)
                ? t('fromNew')
                : p.startsWith('/project/')
                  ? t('fromProjectDetail')
                  : t('fromProjectList')
      guard(() => navigate('/settings', { state: { from } }))
      return
    }
    guard(() => {
      if (window.history.length > 1) navigate(-1)
      else navigate('/')
    })
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
            src={customIconUrl ?? (theme === 'dark' ? appIconUrl : appIconLightUrl)}
            alt=""
            width={22}
            height={22}
          />
          {t('appName')}
        </div>
        <TopbarSearch />
        <div className="topbar-actions">
          <button
            type="button"
            className="topbar-icon-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? t('toLightMode') : t('toDarkMode')}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            type="button"
            className={`topbar-icon-btn ${isSettings ? 'active' : ''}`}
            onClick={toggleSettings}
            title={isSettings ? t('closeSettings') : t('openSettings')}
          >
            <GearIcon />
          </button>
        </div>
      </header>
      <div className="app-main">
        <aside
          className={`app-sidebar${sidebarCollapsed ? ' collapsed' : ''}`}
          style={sidebarCollapsed ? undefined : { width: sidebarWidth }}
        >
          {isSettings ? (
            <SettingsNav />
          ) : (
            <nav className="app-nav">
              <div className="nav-section-label">{t('workspaceSection')}</div>
              <SidebarTree />
            </nav>
          )}
          {/* 右缘拖拽手柄：拉宽/缩窄侧边栏（折叠态隐藏） */}
          {!sidebarCollapsed && <div className="sidebar-resizer" onMouseDown={startSidebarResize} aria-hidden />}
          {/* 底部：Made by + 侧边栏折叠按钮（折叠后按钮仍在底部同位置） */}
          <div className="app-sidebar-footer">
            <span className="footer-text">
              Made by{' '}
              <a
                className="footer-link"
                href="https://quweijia.is-a.dev/"
                target="_blank"
                rel="noreferrer"
              >
                Vic Qu
              </a>
            </span>
            <button
              type="button"
              className="sidebar-toggle"
              onClick={toggleSidebar}
              title={sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}
            >
              <SidebarToggleIcon collapsed={sidebarCollapsed} />
            </button>
          </div>
        </aside>
        <main className="app-content" ref={mainRef}>{children}</main>
      </div>

      {/* 内容滚动超过一屏后出现的「回到顶部」悬浮按钮（fixed 右下角，全页面生效） */}
      {showBackTop && (
        <button
          type="button"
          className="back-top-btn"
          title={t('backToTop')}
          onClick={() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m18 15-6-6-6 6" />
          </svg>
        </button>
      )}

      {/* AI 小助手：右下角悬浮球 + 对话面板（全局常驻，会话随项目/页面路由隔离） */}
      <AiAssistant />

      {/* AI 识别任务进行中：切页确认（中断 / 后台运行 / 取消） */}
      {navConfirm && (
        <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && setNavConfirm(null)}>
          <div className="modal nav-confirm-modal">
            <h3>{t('navConfirmTitle')}</h3>
            <p className="settings-desc">
              {t('navConfirmDesc', {
                pages: navConfirm.tasks.map((x) => x.pageName).join(t('enumerateJoin')),
                count: navConfirm.tasks.length
              })}
            </p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setNavConfirm(null)}>
                {t('cancel')}
              </button>
              <button
                className="btn-secondary"
                onClick={() => {
                  navConfirm.tasks.forEach((task) => useAiTasksStore.getState().interrupt(task.pageId))
                  navConfirm.go()
                  setNavConfirm(null)
                }}
              >
                {t('navConfirmInterrupt')}
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  navConfirm.go()
                  setNavConfirm(null)
                }}
              >
                {t('navConfirmBackground')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
