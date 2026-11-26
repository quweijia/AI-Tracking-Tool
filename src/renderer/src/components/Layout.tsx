import { ReactNode, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { tr } from '../i18n'
import { db, bySort, hasWalkTrash } from '../db'
import { productDb, hasProductTrash } from '../db/product'
import { hasUndo, pushUndo, undoOnce } from '../dndUndo'
import { GRID_DRAG_EVENT, type GridDragInfo } from '../gridDragBus'
import { useSettingsStore, type SettingsTab } from '../stores/settings'
import { useAiTasksStore, type AiTask } from '../stores/aiTasks'
import { useAppIconStore, findAppIcon, type AppIconKey } from '../stores/appIcon'
import { useProductModeStore } from '../stores/productMode'
import appIconUrl from '../assets/app-icon.png'
import AiAssistant from './aiAssistant/AiAssistant'
import appIconLightUrl from '../assets/app-icon-light.png'
import { ToastViewport } from './Toast'
import { ConfirmDialogHost } from './ConfirmDialog'

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

/** 自绘窗口控制按钮：macOS 渲染原生风格红绿灯（左上，原生红绿灯失焦重绘会消失，改为渲染层实现；失焦置灰）；
 * Windows 渲染右上角 Win 风格三按钮（最小化 / 最大化还原 / 关闭，最大化状态随窗口切换图标） */
function WindowControls() {
  const { t } = useTranslation('layout')
  const [focused, setFocused] = useState(() => document.hasFocus())
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    const sync = () => setFocused(document.hasFocus())
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    // 点击未激活窗口的拖拽区激活时 DOM focus/blur 会被吞掉，用主进程 IPC 兜底同步置灰态
    // （?. 防御：preload 未重建时 API 缺失，避免崩溃白屏）
    const off = window.electronAPI.onWindowFocusChanged?.(setFocused)
    // Windows 三按钮：订阅最大化状态变化 + 初始查询对齐（双击顶栏 toggle 也走 maximize/unmaximize 事件）
    const offMax = window.electronAPI.onWindowMaximizedChanged?.(setMaximized)
    window.electronAPI.getWindowMaximized?.().then(setMaximized).catch(() => undefined)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      off?.()
      offMax?.()
    }
  }, [])
  // macOS：原生风格红绿灯，位置样式行为与线上版本一致（勿改）
  if (window.electronAPI.platform === 'darwin') {
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
  // Windows：右上角 Win 风格三按钮（按钮区不参与拖拽，isTopbarControl 已排除 button）
  return (
    <div className={`win-controls${focused ? '' : ' inactive'}`}>
      <button type="button" className="win3-btn" title={t('winMinimize')} onClick={() => window.electronAPI.minimizeWindow()}>
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
          <path d="M1 5h8" />
        </svg>
      </button>
      <button
        type="button"
        className="win3-btn"
        title={maximized ? t('winRestore') : t('winMaximize')}
        onClick={() => window.electronAPI.maximizeWindow()}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
            <rect x="1.5" y="3" width="5.5" height="5.5" />
            <path d="M3.5 1.5h5v5" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
            <rect x="1.5" y="1.5" width="7" height="7" />
          </svg>
        )}
      </button>
      <button type="button" className="win3-btn close" title={t('winClose')} onClick={() => window.electronAPI.closeWindow()}>
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
        </svg>
      </button>
    </div>
  )
}

/** 顶栏交互控件判别：按钮/输入/链接/标题区/搜索区不参与拖拽与双击最大化（标题区悬停浮现模式切换按钮，事件需保留） */
const isTopbarControl = (target: EventTarget | null): boolean =>
  target instanceof Element && !!target.closest('button, input, a, .topbar-title-zone, .topbar-search')

/** 拖拽跟随：顶栏 mousedown 后，鼠标移动持续通知主进程按光标位移挪窗（原 CSS drag 区域不派发 DOM 事件，改为渲染层驱动） */
function onWindowDragMove(): void {
  window.electronAPI.dragWindowMove()
}

/** 拖拽结束：mouseup 后移除监听并通知主进程清理拖拽原点 */
function onWindowDragEnd(): void {
  window.removeEventListener('mousemove', onWindowDragMove)
  window.removeEventListener('mouseup', onWindowDragEnd)
  window.electronAPI.dragWindowEnd()
}

/** 顶栏按下启动窗口拖拽（仅左键、非控件区域） */
function handleTopbarMouseDown(e: ReactMouseEvent<HTMLElement>): void {
  if (e.button !== 0 || isTopbarControl(e.target)) return
  window.electronAPI.dragWindowStart()
  window.addEventListener('mousemove', onWindowDragMove)
  window.addEventListener('mouseup', onWindowDragEnd)
}

/** 顶栏双击：最大化窗口，再次双击还原之前窗口大小 */
function handleTopbarDoubleClick(e: ReactMouseEvent<HTMLElement>): void {
  if (isTopbarControl(e.target)) return
  window.electronAPI.maximizeWindow()
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

/** 产品标注 icon（标签） */
function TagIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2H2v10l9.3 9.3a1 1 0 0 0 1.4 0l8.6-8.6a1 1 0 0 0 0-1.4Z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
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

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M10 11v5M14 11v5" />
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
  const productMode = useProductModeStore((s) => s.enabled)
  /** 设置中心导航配置（渲染进程侧边栏 + 设置页共用；通用设置置顶）。
   *  hiddenInProduct：产品模式下隐藏的分区（容差/MCP/SkillHub 属走查能力裁剪） */
  const tabs: { key: SettingsTab; label: string; icon: ReactNode; hiddenInProduct?: boolean }[] = [
    { key: 'general', label: t('navGeneral'), icon: <SlidersIcon /> },
    { key: 'tolerance', label: t('navTolerance'), icon: <RulerIcon />, hiddenInProduct: true },
    { key: 'models', label: t('navModels'), icon: <CpuIcon />, hiddenInProduct: true },
    { key: 'assistant', label: t('navAssistant'), icon: <BotIcon />, hiddenInProduct: true },
    { key: 'mcp', label: t('navMcp'), icon: <PlugIcon />, hiddenInProduct: true },
    { key: 'skills', label: t('navSkills'), icon: <PuzzleIcon />, hiddenInProduct: true },
    { key: 'auth', label: t('navAuth'), icon: <ShieldIcon /> },
    { key: 'browser', label: t('navBrowser'), icon: <GlobeIcon /> },
    { key: 'about', label: t('navAbout'), icon: <InfoIcon /> }
  ]
  // 产品模式下按能力开关过滤设置分区，当前 tab 被隐藏时回退到通用设置
  const visibleTabs = productMode ? tabs.filter((item) => !item.hiddenInProduct) : tabs
  useEffect(() => {
    if (productMode && tab !== 'general' && tabs.some((x) => x.key === tab && x.hiddenInProduct)) {
      console.log(`[PRODUCT_MODE] settings tab "${tab}" hidden in product mode, fallback to general`)
      setTab('general')
    }
  }, [productMode, tab, setTab])
  return (
    <nav className="app-nav">
      <div className="nav-section-label">{t('settingsSection')}</div>
      {visibleTabs.map((item) => (
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
function TopbarSearch({ productMode }: { productMode?: boolean }) {
  const { t } = useTranslation('layout')
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const query = q.trim().toLowerCase()

  // 产品模式搜索产品标注数据，走查模式搜索走查数据
  // 注意：所有 useLiveQuery 必须无条件调用（React Hooks 规则）
  const walkProjects = useLiveQuery(async () => (await db.projects.toArray()).filter((p) => !p.deletedAt), [])
  const walkPages = useLiveQuery(async () => (await db.pages.toArray()).filter((p) => !p.deletedAt), [])
  const walkFolders = useLiveQuery(async () => (await db.folders.toArray()).filter((f) => !f.deletedAt), [])
  const productProjects = useLiveQuery(async () => (await productDb.projects.toArray()).filter((p) => !p.deletedAt), [])
  const productPages = useLiveQuery(async () => (await productDb.pages.toArray()).filter((p) => !p.deletedAt), [])
  const projects = productMode ? (productProjects ?? []) : (walkProjects ?? [])
  const pages = productMode ? (productPages ?? []) : (walkPages ?? [])
  const folders = productMode ? [] : (walkFolders ?? [])

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

  const projHits = query ? projects.filter((p: any) => p.name.toLowerCase().includes(query)).slice(0, 4) : []
  const folderHits = query ? folders.filter((v) => v.name.toLowerCase().includes(query)).slice(0, 4) : []
  const pageHits = query ? pages.filter((p: any) => (p.name ?? p.pageName ?? '').toLowerCase().includes(query)).slice(0, 6) : []
  const hasHits = projHits.length > 0 || folderHits.length > 0 || pageHits.length > 0
  const showPop = focused && query.length > 0

  const projectName = (id: string) => projects.find((p: any) => p.id === id)?.name ?? t('unknownProject')
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
      <kbd className="search-kbd">{navigator.platform.toLowerCase().includes('mac') ? '⌘K' : 'Ctrl+K'}</kbd>
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
                go(productMode ? `/product/${p.id}` : `/project/${p.id}`)
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
                go(productMode ? `/product/${p.projectId}/page/${p.id}` : `/project/${p.projectId}/page/${p.id}`)
              }}
            >
              <span className="search-item-name">{'name' in p ? p.name : p.pageName}</span>
              <span className="search-item-sub">
                {projectName(p.projectId)}
                {'folderId' in p && p.folderId ? ` / ${folderName(p.folderId as string)}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 拖拽排序节点信息：kind 决定可放置目标类型，parentId 限定只能在同一父节点内移动
 *  （kind 'page' 双关：走查模式 = 页面，产品模式 = 标注集，两者互斥不会同树出现） */
type DragInfo = { kind: 'project' | 'folder' | 'page'; id: string; parentId: string | null }

/** 树节点结构兼容类型：走查 Folder / 产品 ProductFolder 通用 */
type TreeFolderLike = { id: string; projectId: string; parentId?: string; name: string }
/** 树叶子结构兼容类型：走查 WalkthroughPage（pageName）/ 产品 ProductAnnotationSet（name）通用 */
type TreeLeafLike = { id: string; projectId: string; folderId?: string; name?: string; pageName?: string }
/** 树叶子行文案：走查页面取 pageName，产品标注集取 name */
const leafLabel = (leaf: TreeLeafLike) => leaf.name ?? leaf.pageName ?? ''

/** 1×1 透明图：侧边栏拖拽时用 setDragImage 隐藏浏览器默认的灰色元素拖影 */
const TRANSPARENT_DRAG_IMG = (() => {
  const img = new Image(1, 1)
  img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  return img
})()

/** 拖拽排序落库：把 fromId 移到 toId 前/后，整列重排 sortNo（步长 10）。
 *  mode 决定数据源：walk 写走查库（pages），product 写产品库（pages → 标注集 sets） */
async function reorderList(
  mode: 'walk' | 'product',
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
  // 排序前压撤销栈（Cmd+Z 撤回；文件夹与页面/标注集均支持，项目排序不撤回）
  if (which === 'folders' || which === 'pages') await pushUndo(mode)
  for (let i = 0; i < ids.length; i++) {
    const sortNo = (i + 1) * 10
    if (mode === 'walk') {
      const changes = { sortNo }
      if (which === 'projects') await db.projects.update(ids[i], changes)
      else if (which === 'folders') await db.folders.update(ids[i], changes)
      else await db.pages.update(ids[i], changes)
    } else {
      // 产品标注集带 updatedAt（项目详情/最近访问依赖它），排序时同步刷新
      const changes = which === 'pages' ? { sortNo, updatedAt: Date.now() } : { sortNo }
      if (which === 'projects') await productDb.projects.update(ids[i], changes)
      else if (which === 'folders') await productDb.folders.update(ids[i], changes)
      else await productDb.sets.update(ids[i], changes)
    }
  }
}

/** 侧边栏树状菜单：最近访问入口 + 项目列表（项目 → 文件夹与页面并列） */
function SidebarTree() {
  const { t } = useTranslation('layout')
  const productMode = useProductModeStore((s) => s.enabled)
  const navMode: 'walk' | 'product' = productMode ? 'product' : 'walk'
  const location = useLocation()
  const navigate = useNavigate()
  const projects = useLiveQuery(async () => (await db.projects.toArray()).filter((p) => !p.deletedAt), []) ?? []
  const folders = useLiveQuery(async () => (await db.folders.toArray()).filter((f) => !f.deletedAt), []) ?? []
  const pages = useLiveQuery(async () => (await db.pages.toArray()).filter((p) => !p.deletedAt), []) ?? []
  /** 产品标注数据（产品模式目录树用；Hooks 规则：无条件查询，按模式取用；回收站中的不进目录树） */
  const productProjects = useLiveQuery(async () => (await productDb.projects.toArray()).filter((p) => !p.deletedAt), []) ?? []
  const productFolders = useLiveQuery(async () => (await productDb.folders.toArray()).filter((f) => !f.deletedAt), []) ?? []
  const productSets = useLiveQuery(async () => (await productDb.sets.toArray()).filter((s) => !s.deletedAt), []) ?? []
  /** 设计规范端分类（侧边栏「设计规范」分组的子项） */
  const specCats = useLiveQuery(() => db.specCategories.toArray(), []) ?? []
  /** 回收站是否有内容（两库分别探测，按模式取用）：仅在有软删记录时显示「回收站」菜单 */
  const walkHasTrash = useLiveQuery(() => hasWalkTrash(), [], false)
  const productHasTrash = useLiveQuery(() => hasProductTrash(), [], false)
  const hasTrash = (productMode ? productHasTrash : walkHasTrash) ?? false

  const { t: t2 } = useTranslation('specsPage')

  const [projectsOpen, setProjectsOpen] = useState(false)
  /** 设计规范分组展开状态（持久化，默认展开） */
  const [specsOpen, setSpecsOpen] = useState(() => localStorage.getItem('app-specs-nav-open') !== '0')
  /** 设计规范菜单启用开关（设置页「通用」管理，关闭后隐藏整个分组；默认开启） */
  const [specMenuOn, setSpecMenuOn] = useState(true)
  /** 各项目节点的展开状态 */
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  /** 各文件夹节点的展开状态 */
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  /** 拖拽中的节点 / 放置指示（before/after 蓝色插线；in = 网格卡片拖到节点上的整行高亮） */
  const [drag, setDrag] = useState<DragInfo | null>(null)
  const [dropHint, setDropHint] = useState<{ kind: DragInfo['kind']; id: string; pos: 'before' | 'after' | 'in' } | null>(null)
  /** 网格卡片拖拽状态（页面/标注集/文件夹从网格拖到侧边栏树放置）：监听 gridDragBus 广播 */
  const [gridDrag, setGridDrag] = useState<GridDragInfo | null>(null)
  useEffect(() => {
    const onGridDrag = (e: Event) => {
      const info = (e as CustomEvent<GridDragInfo | null>).detail ?? null
      setGridDrag(info)
      // 网格拖拽结束（含取消释放）时清除「拖入」整行高亮
      if (!info) setDropHint((prev) => (prev?.pos === 'in' ? null : prev))
    }
    window.addEventListener(GRID_DRAG_EVENT, onGridDrag)
    return () => window.removeEventListener(GRID_DRAG_EVENT, onGridDrag)
  }, [])

  const routeMatch = location.pathname.match(/^\/project\/([^/]+)(?:\/page\/([^/]+))?/)
  const routeProjectId = routeMatch?.[1] ?? null
  const routePageId = routeMatch?.[2] ?? null
  /** 文件夹视图参数（/project/:pid?f=:fid）：文件夹高亮直接由路由派生，避免 state 残留导致双选中 */
  const routeFolderParam = new URLSearchParams(location.search).get('f')

  /** 产品模式路由：/product/:projectId(/set/:setId)，文件夹视图 ?f=:fid（与走查同约定） */
  const prodMatch = location.pathname.match(/^\/product\/([^/]+)(?:\/set\/([^/]+))?/)
  const prodProjectId = prodMatch?.[1] ?? null
  const prodSetId = prodMatch?.[2] ?? null
  const prodFolderParam = new URLSearchParams(location.search).get('f')

  // 路由进入某项目时自动展开该项目节点
  useEffect(() => {
    if (!routeProjectId) return
    setExpandedProjects((prev) => new Set(prev).add(routeProjectId))
  }, [routeProjectId])

  // 产品模式：路由进入某项目时自动展开该项目节点
  useEffect(() => {
    if (prodProjectId) setExpandedProjects((prev) => new Set(prev).add(prodProjectId))
  }, [prodProjectId])

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

  // 读取设计规范菜单开关（设置页「通用」切换后通过 spec-menu-change 事件即时联动）
  useEffect(() => {
    const load = () => {
      void window.electronAPI.getConfig().then((cfg) => setSpecMenuOn(cfg.specMenuEnabled !== false))
    }
    load()
    window.addEventListener('spec-menu-change', load)
    return () => window.removeEventListener('spec-menu-change', load)
  }, [])

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

  // 产品模式：路由进入某标注集时自动展开其所属文件夹节点
  const prodRouteSetFolderId = prodSetId ? productSets.find((s) => s.id === prodSetId)?.folderId : undefined
  useEffect(() => {
    if (prodRouteSetFolderId) setExpandedFolders((prev) => new Set(prev).add(prodRouteSetFolderId))
  }, [prodRouteSetFolderId])

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

  /** 走查：项目根级未分组页面（与文件夹并列挂在项目下） */
  const rootPagesByProject = useMemo(() => {
    const m = new Map<string, (typeof pages)[number][]>()
    pages
      .filter((p) => !p.folderId)
      .forEach((p) => {
        const arr = m.get(p.projectId) ?? []
        arr.push(p)
        m.set(p.projectId, arr)
      })
    ;[...m.values()].forEach((arr) => arr.sort(bySort))
    return m
  }, [pages])

  /** 产品模式：排序后的项目（与走查侧同构，供目录树渲染） */
  const sortedProductProjects = useMemo(() => [...productProjects].sort(bySort), [productProjects])

  /** 产品模式：项目根级文件夹 与 文件夹子级映射 */
  const prodRootFoldersByProject = useMemo(() => {
    const m = new Map<string, (typeof productFolders)[number][]>()
    productFolders
      .filter((v) => !v.parentId)
      .forEach((v) => {
        const arr = m.get(v.projectId) ?? []
        arr.push(v)
        m.set(v.projectId, arr)
      })
    ;[...m.values()].forEach((arr) => arr.sort(bySort))
    return m
  }, [productFolders])

  const prodChildFoldersByParent = useMemo(() => {
    const m = new Map<string, (typeof productFolders)[number][]>()
    productFolders
      .filter((v) => v.parentId)
      .forEach((v) => {
        const arr = m.get(v.parentId!) ?? []
        arr.push(v)
        m.set(v.parentId!, arr)
      })
    ;[...m.values()].forEach((arr) => arr.sort(bySort))
    return m
  }, [productFolders])

  /** 产品模式：文件夹 → 标注集 / 项目根级标注集（无 folderId） */
  const prodSetsByFolder = useMemo(() => {
    const m = new Map<string, (typeof productSets)[number][]>()
    productSets
      .filter((s) => s.folderId)
      .forEach((s) => {
        const arr = m.get(s.folderId!) ?? []
        arr.push(s)
        m.set(s.folderId!, arr)
      })
    ;[...m.values()].forEach((arr) => arr.sort(bySort))
    return m
  }, [productSets])

  const projRootSetsByProject = useMemo(() => {
    const m = new Map<string, (typeof productSets)[number][]>()
    productSets
      .filter((s) => !s.folderId)
      .forEach((s) => {
        const arr = m.get(s.projectId) ?? []
        arr.push(s)
        m.set(s.projectId, arr)
      })
    ;[...m.values()].forEach((arr) => arr.sort(bySort))
    return m
  }, [productSets])

  /** 递归渲染文件夹节点（多层嵌套：文件夹与页面/标注集并列展示；depth 决定逐级缩进；
   *  mode 决定数据源与路由：walk → 走查库页面 /project…，product → 产品库标注集 /product…） */
  const renderFolderNode = (
    mode: 'walk' | 'product',
    f: TreeFolderLike,
    projId: string,
    siblings: TreeFolderLike[],
    depth = 0
  ) => {
    const isProduct = mode === 'product'
    const vOpen = expandedFolders.has(f.id)
    const vLeaves: TreeLeafLike[] = isProduct
      ? (prodSetsByFolder.get(f.id) ?? [])
      : (pagesByFolder.get(f.id) ?? [])
    const children: TreeFolderLike[] = isProduct
      ? (prodChildFoldersByParent.get(f.id) ?? [])
      : (childFoldersByParent.get(f.id) ?? [])
    // 拖拽层级约定：根级文件夹挂在项目下互拖，子级文件夹在同一父级内互拖
    const parentKey = f.parentId ?? projId
    const foldActive = isProduct
      ? prodFolderParam === f.id && prodProjectId === projId
      : routeFolderParam === f.id && routeProjectId === projId
    return (
      <div key={f.id} className="tree-branch">
        <div
          className={rowCls('folder', f.id, `tree-row tree-v2 ${foldActive ? 'active' : ''}`)}
          style={{ paddingLeft: 40 + depth * 16 }}
          draggable
          onDragStart={handleDragStart({ kind: 'folder', id: f.id, parentId: parentKey })}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => {
            if (gridDrag) return handleGridDragOver('folder', projId, f.id)(e)
            handleDragOver('folder', parentKey, f.id)(e)
          }}
          onDragLeave={handleDragLeave(f.id)}
          onDrop={(e) => {
            if (gridDrag) return handleGridDrop(projId, f.id)(e)
            handleDrop(mode, 'folder', parentKey, f.id, siblings)(e)
          }}
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
            to={isProduct ? `/product/${projId}?f=${f.id}` : `/project/${projId}?f=${f.id}`}
            className="tree-label dim"
            onClick={() => {
              setExpandedFolders((prev) => new Set(prev).add(f.id))
            }}
            title={f.name}
          >
            {f.name}
          </Link>
          <span className="count count-sm tree-count">{vLeaves.length}</span>
        </div>
        {vOpen && (
          <>
            {children.map((c) => renderFolderNode(mode, c, projId, children, depth + 1))}
            {vLeaves.map((pg) => {
              const leafActive = isProduct ? prodSetId === pg.id : routePageId === pg.id
              return (
                <Link
                  key={pg.id}
                  to={isProduct ? `/product/${projId}/set/${pg.id}` : `/project/${projId}/page/${pg.id}`}
                  className={rowCls('page', pg.id, `tree-leaf ${leafActive ? 'active' : ''}`)}
                  style={{ paddingLeft: 62 + depth * 16 }}
                  draggable
                  onDragStart={handleDragStart({ kind: 'page', id: pg.id, parentId: f.id })}
                  onDragEnd={handleDragEnd}
                  onDragOver={handleDragOver('page', f.id, pg.id)}
                  onDragLeave={handleDragLeave(pg.id)}
                  onDrop={handleDrop(mode, 'page', f.id, pg.id, vLeaves)}
                  title={leafLabel(pg)}
                >
                  {leafLabel(pg)}
                </Link>
              )
            })}
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
    mode: 'walk' | 'product',
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
      mode,
      kind === 'project' ? 'projects' : kind === 'folder' ? 'folders' : 'pages',
      list,
      fromId,
      rowId,
      pos
    )
  }

  // ===== 网格卡片拖到侧边栏树放置（页面/标注集/文件夹 → 文件夹行/项目根行，整行高亮 pos: 'in'） =====

  /** 文件夹防环：targetId 是否就是 ancestorId 或位于其子孙之下（沿 parentId 上溯，seen 防死循环） */
  const folderIsDescendantOf = (mode: 'walk' | 'product', ancestorId: string, targetId: string): boolean => {
    const all = mode === 'product' ? productFolders : folders
    let cur = all.find((x) => x.id === targetId)
    const seen = new Set<string>()
    while (cur && cur.parentId && !seen.has(cur.id)) {
      seen.add(cur.id)
      if (cur.parentId === ancestorId) return true
      cur = all.find((x) => x.id === cur!.parentId)
    }
    return false
  }

  /** 网格卡片能否放入：页面/标注集支持跨项目（落到哪个项目/文件夹就归属哪个项目）；文件夹仅同项目
   *  （跨项目需级联迁移其下页面，暂不支持）；未已在目标层；文件夹不可放入自身或其子孙 */
  const gridCanDropInto = (info: GridDragInfo, projId: string, folderId: string | null): boolean => {
    if (info.kind !== 'folder') return info.projectId !== projId || info.parentId !== (folderId ?? undefined)
    if (info.projectId !== projId) return false
    if (info.parentId === (folderId ?? undefined)) return false
    if (folderId !== null) {
      if (info.id === folderId) return false
      return !folderIsDescendantOf(info.mode, info.id, folderId)
    }
    return true
  }

  const handleGridDragOver = (kind: 'folder' | 'project', projId: string, folderId: string | null) => (e: DragEvent) => {
    if (!gridDrag || !gridCanDropInto(gridDrag, projId, folderId)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const id = folderId ?? projId
    setDropHint((prev) => (prev?.kind === kind && prev.id === id && prev.pos === 'in' ? prev : { kind, id, pos: 'in' }))
  }

  /** 网格卡片放入侧边栏节点：移动到目标项目/文件夹层（folderId null = 项目根），置于该层末尾（Cmd+Z 可撤回）；
   *  页面/标注集跨项目时同步改归属项目 */
  const handleGridDrop = (projId: string, folderId: string | null) => (e: DragEvent) => {
    const info = gridDrag
    if (!info || !gridCanDropInto(info, projId, folderId)) return
    e.preventDefault()
    setGridDrag(null)
    setDropHint(null)
    void moveGridItemTo(info, folderId, projId)
  }

  const moveGridItemTo = async (info: GridDragInfo, targetFolderId: string | null, targetProjId: string) => {
    await pushUndo(info.mode)
    const isProduct = info.mode === 'product'
    const folderTable = isProduct ? productDb.folders : db.folders
    const leafTable = isProduct ? productDb.sets : db.pages
    // 目标层兄弟（文件夹 / 页面或标注集）取 maxSort 作为排序基线，移到末尾
    const maxOf = (arr: { sortNo?: number }[]) => arr.reduce((m, x) => Math.max(m, x.sortNo ?? 0), 0)
    let maxSort = 0
    if (info.kind === 'folder') {
      const sibs = (isProduct ? productFolders : folders).filter((x) =>
        targetFolderId ? x.parentId === targetFolderId : !x.parentId && x.projectId === info.projectId
      )
      maxSort = maxOf(sibs)
    } else if (targetFolderId) {
      maxSort = maxOf(await leafTable.where('folderId').equals(targetFolderId).toArray())
    } else {
      maxSort = maxOf(
        (await leafTable.where('projectId').equals(targetProjId).toArray()).filter((s) => !s.folderId)
      )
    }
    const sortNo = maxSort + 10
    if (info.kind === 'folder') {
      await folderTable.update(info.id, { parentId: targetFolderId ?? undefined, sortNo })
    } else {
      // projectId 随落点更新（跨项目移动；同项目时为原值无副作用）；产品标注集带 updatedAt（项目详情/最近访问依赖它）
      const changes = isProduct
        ? { projectId: targetProjId, folderId: targetFolderId ?? undefined, sortNo, updatedAt: Date.now() }
        : { projectId: targetProjId, folderId: targetFolderId ?? undefined, sortNo }
      await leafTable.update(info.id, changes)
    }
  }

  /** 行样式：拼拖拽中/放置插线指示类 */
  const rowCls = (kind: DragInfo['kind'], id: string, base: string) =>
    `${base}${drag?.id === id ? ' dragging' : ''}${
      dropHint && dropHint.kind === kind && dropHint.id === id ? ` drop-${dropHint.pos}` : ''
    }`

  /** 项目目录树分组（走查 / 产品两模式共用）：根行（可展开收起）+ 项目 → 文件夹与页面/标注集并列树；
   *  mode 决定根行文案/图标/路由与数据源（走查 = pages，产品 = 标注集 sets），拖拽排序落库随模式分流 */
  const renderProjectsGroup = (mode: 'walk' | 'product') => {
    const isProduct = mode === 'product'
    const dataProjects = isProduct ? sortedProductProjects : sortedProjects
    const rootFoldersMap = isProduct ? prodRootFoldersByProject : rootFoldersByProject
    const rootLeavesMap = isProduct ? projRootSetsByProject : rootPagesByProject
    const routeProj = isProduct ? prodProjectId : routeProjectId
    const routeLeaf = isProduct ? prodSetId : routePageId
    const routeFold = isProduct ? prodFolderParam : routeFolderParam
    return (
      <div key={`projects-${mode}`} className={`nav-group ${projectsOpen ? 'nav-group-tree' : ''}`}>
        {/* 根行拆分交互：icon 仅展开/收起树（不跳转），文字跳转项目列表页 */}
        <div
          className={`nav-root-row ${(isProduct ? location.pathname === '/product' : location.pathname === '/') ? 'active' : ''}`}
          draggable="false"
        >
          <button
            type="button"
            className="root-icon"
            onClick={() => {
              const next = !projectsOpen
              setProjectsOpen(next)
              // 手风琴：展开项目列表时自动收起设计规范分组（仅走查模式有该分组，含持久化状态）
              if (next && !isProduct) {
                setSpecsOpen(false)
                localStorage.setItem('app-specs-nav-open', '0')
              }
            }}
            title={projectsOpen ? t('treeCollapse') : t('treeExpand')}
          >
            {isProduct ? <TagIcon /> : <FolderIcon />}
          </button>
          <Link
            to={isProduct ? '/product' : '/'}
            className="tree-root-label"
            draggable="false"
            onClick={() => {
              // 跳转的同时确保树展开（与下方项目行点击展开行为一致，不做收起）
              if (!projectsOpen) {
                setProjectsOpen(true)
                if (!isProduct) {
                  setSpecsOpen(false)
                  localStorage.setItem('app-specs-nav-open', '0')
                }
              }
            }}
          >
            {isProduct ? t('navProductAnnotation') : t('navProjects')}
          </Link>
        </div>
        {projectsOpen && (
          <div className="nav-tree">
            {dataProjects.map((p) => {
              const projOpen = expandedProjects.has(p.id)
              const projRootFolders = rootFoldersMap.get(p.id) ?? []
              // 项目根级未分组页面/标注集（与文件夹并列挂在项目下）
              const projRootLeaves = rootLeavesMap.get(p.id) ?? []
              const projActive = routeProj === p.id && !routeLeaf && !routeFold
              return (
                <div key={p.id} className="tree-project">
                  <div
                    className={rowCls('project', p.id, `tree-row ${projActive ? 'active' : ''}`)}
                    draggable
                    onDragStart={handleDragStart({ kind: 'project', id: p.id, parentId: null })}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) => {
                      if (gridDrag) return handleGridDragOver('project', p.id, null)(e)
                      handleDragOver('project', null, p.id)(e)
                    }}
                    onDragLeave={handleDragLeave(p.id)}
                    onDrop={(e) => {
                      if (gridDrag) return handleGridDrop(p.id, null)(e)
                      handleDrop(mode, 'project', null, p.id, dataProjects)(e)
                    }}
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
                      to={isProduct ? `/product/${p.id}` : `/project/${p.id}`}
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
                      {projRootFolders.map((v) => renderFolderNode(mode, v, p.id, projRootFolders))}
                      {/* 项目根级未分组页面/标注集：与文件夹并列，仅在项目内互拖排序 */}
                      {projRootLeaves.map((pg) => (
                        <div key={pg.id} className="tree-branch">
                          <Link
                            to={isProduct ? `/product/${p.id}/set/${pg.id}` : `/project/${p.id}/page/${pg.id}`}
                            className={rowCls('page', pg.id, `tree-leaf ${routeLeaf === pg.id ? 'active' : ''}`)}
                            draggable
                            onDragStart={handleDragStart({ kind: 'page', id: pg.id, parentId: p.id })}
                            onDragEnd={handleDragEnd}
                            onDragOver={handleDragOver('page', p.id, pg.id)}
                            onDragLeave={handleDragLeave(pg.id)}
                            onDrop={handleDrop(mode, 'page', p.id, pg.id, projRootLeaves)}
                            title={leafLabel(pg)}
                          >
                            {leafLabel(pg)}
                          </Link>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )
            })}
            {dataProjects.length === 0 && <p className="tree-empty">{t('emptyProjects')}</p>}
          </div>
        )}
      </div>
    )
  }

  // ===== 侧边栏菜单配置数组：按模式过滤（walk=AI走查 / product=产品标注），后续增删菜单只改此配置 =====
  const navEntries: { id: string; visibleIn: ('walk' | 'product')[]; gate?: boolean; render: () => ReactNode }[] = [
    // 设计规范：整行跳转总览页，同时展开/收起端分类子项（与项目列表行一致）；设置页可关闭整个功能入口
    // nav-group-tree 仅在树展开时挂载：组可收缩（min-height:0）供树内滚动；收起后组不可压缩，防止行被 flex 压缩导致与相邻菜单重叠
    {
      id: 'specs',
      visibleIn: ['walk'],
      gate: specMenuOn,
      render: () => (
        <div key="specs" className={`nav-group ${specsOpen ? 'nav-group-tree' : ''}`}>
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
      ),
    },
    // 最近访问：跳转独立页面（整行可点，含左侧 icon；两种模式共用，页面内部按模式取数）
    {
      id: 'recent',
      visibleIn: ['walk', 'product'],
      render: () => (
        <div key="recent" className="nav-group">
          <Link to="/recent" className={`nav-root-row ${location.pathname === '/recent' ? 'active' : ''}`} draggable="false">
            <span className="root-icon">
              <ClockIcon />
            </span>
            <span className="tree-root-label">{t('navRecent')}</span>
          </Link>
        </div>
      ),
    },

    // 项目列表（子目录为项目树）：仅项目列表页高亮，/recent 时不选中
    {
      id: 'projects',
      visibleIn: ['walk'],
      render: () => renderProjectsGroup('walk'),
    },
    // 产品标注：产品模式专属入口，子目录为产品项目目录树（与走查项目树同构，拖拽排序落产品库）
    {
      id: 'product-annotation',
      visibleIn: ['product'],
      render: () => renderProjectsGroup('product'),
    },
    // 标注报告：查看所有导出过的报告（走查 HTML 报告 / 产品标注报告，按模式过滤；吸底）
    {
      id: 'reports',
      visibleIn: ['walk', 'product'],
      render: () => (
        <div key="reports" className="nav-group">
          <Link to="/reports" className={`nav-root-row ${location.pathname === '/reports' ? 'active' : ''}`} draggable="false">
            <span className="root-icon">
              <ReportDocIcon />
            </span>
            <span className="tree-root-label">{t('navReports')}</span>
          </Link>
        </div>
      ),
    },
    // 回收站：本模式已删除项目/文件夹/页面（软删可还原；走查/产品数据严格隔离）
    // gate：当前模式库中无软删记录时不显示菜单；正停留在回收站页时保持显示，避免清空后导航突然消失
    {
      id: 'trash',
      visibleIn: ['walk', 'product'],
      gate: hasTrash || location.pathname === '/trash',
      render: () => (
        // nav-group-trash：吸底展示（margin-top:auto 推到侧边栏导航区底部，见 global.css）
        <div key="trash" className="nav-group nav-group-trash">
          <Link to="/trash" className={`nav-root-row ${location.pathname === '/trash' ? 'active' : ''}`} draggable="false">
            <span className="root-icon">
              <TrashIcon />
            </span>
            <span className="tree-root-label">{t('navTrash')}</span>
          </Link>
        </div>
      ),
    },
  ]

  // 按当前模式过滤菜单：gate 为二级开关（如设置页的设计规范入口开关）
  const shownNav = navEntries.filter((e) => (e.gate === undefined || e.gate) && e.visibleIn.includes(navMode))
  useEffect(() => {
    console.log(
      `[PRODUCT_MODE] 侧边栏菜单过滤 mode=${navMode}, gate(specs)=${specMenuOn}, 显示: ${shownNav.map((e) => e.id).join(', ')}`,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navMode, specMenuOn])

  return <>{shownNav.map((e) => e.render())}</>
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
    // 原生窗口 chrome 跟随应用解析后的主题：系统深色 + 应用浅色时避免原生层绘制深色外描边
    window.electronAPI.setThemeSource(theme).catch(() => undefined)
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

  // ===== 产品模式：顶栏标题与 document.title（= Electron 原生窗口标题）随模式切换，关闭后恢复原名 =====
  const productMode = useProductModeStore((s) => s.enabled)
  const setEnabled = useProductModeStore((s) => s.setEnabled)
  useEffect(() => {
    document.title = productMode ? t('productAppName') : t('appName')
    console.log(`[PRODUCT_MODE] Layout 顶栏标题: ${productMode ? t('productAppName') : t('appName')}`)
  }, [productMode, t])

  // ===== Cmd/Ctrl+Z 撤销拖拽排序 / 移动层级（文件夹 + 页面/标注集；详情页网格与侧边栏共用一个撤销栈）。
  //  仅项目详情页一级路由生效（/project/:id、/product/:id），标注画布页有自己的 Cmd+Z 标注撤销；
  //  HashRouter 下路由在 location.hash 里，pathname 恒为 /；输入框聚焦时交给原生文本撤销 =====
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() !== 'z') return
      const p = window.location.hash.replace(/^#/, '').split('?')[0]
      if (!/^\/project\/[^/]+$/.test(p) && !/^\/product\/[^/]+$/.test(p)) return
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const mode: 'walk' | 'product' = useProductModeStore.getState().enabled ? 'product' : 'walk'
      if (!hasUndo(mode)) return
      e.preventDefault()
      void undoOnce(mode)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** 顶栏模式切换按钮：AI 走查 ↔ 产品标注（点击时图标顺时针旋转一圈） */
  const [modeSwitching, setModeSwitching] = useState(false)
  const modeSwitchTimerRef = useRef<number | null>(null)
  const handleToggleMode = () => {
    setEnabled(!productMode)
    // 先移除再添加 switching 类，保证连续点击时旋转动画每次都重新触发
    setModeSwitching(false)
    requestAnimationFrame(() => {
      setModeSwitching(true)
      if (modeSwitchTimerRef.current) window.clearTimeout(modeSwitchTimerRef.current)
      modeSwitchTimerRef.current = window.setTimeout(() => setModeSwitching(false), 700)
    })
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
  // ===== 后台任务悬浮提示：用户选择「后台运行并离开」后，底部常驻当前任务入口 =====
  // 只提示「不在其所在页面」的任务（页面内已有进度/结果通知，不重复）；跑完的任务在被
  // 目标页消费后会自动清出任务列表，悬浮提示随之消失
  const bgTasks = useMemo(
    () =>
      aiTasks.filter(
        (t) => t.status !== 'interrupted' && location.pathname !== `/project/${t.projectId}/page/${t.pageId}`
      ),
    [aiTasks, location.pathname]
  )
  const bgTask = bgTasks.find((t) => t.status === 'running') ?? bgTasks[bgTasks.length - 1] ?? null
  const bgRunningCount = bgTasks.filter((t) => t.status === 'running').length
  // 多任务时点击胶囊展开任务选择列表（进行中优先，其余按发起时间）
  const [bgTaskPicker, setBgTaskPicker] = useState(false)
  const bgTaskList = useMemo(
    () =>
      [...bgTasks].sort((a, b) => {
        const ra = a.status === 'running' ? 0 : 1
        const rb = b.status === 'running' ? 0 : 1
        return ra - rb || a.startedAt - b.startedAt
      }),
    [bgTasks]
  )
  useEffect(() => {
    if (bgTaskList.length <= 1) setBgTaskPicker(false)
  }, [bgTaskList.length])
  // 胶囊可见时给 body 打标记：底部居中的 Toast 抬到胶囊上方渲染
  // （Toast 层级更高，不抬会盖住胶囊；胶囊 top ≈ 46px，Toast 抬至 56px 留 10px 间距）
  const bgPillVisible = !productMode && !!bgTask
  useEffect(() => {
    document.body.classList.toggle('bg-pill-visible', bgPillVisible)
    return () => document.body.classList.remove('bg-pill-visible')
  }, [bgPillVisible])
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
      <header
        className="app-topbar"
        onMouseDown={handleTopbarMouseDown}
        onDoubleClick={handleTopbarDoubleClick}
      >
        {/* 自绘窗口控制按钮（替代原生红绿灯） */}
        <WindowControls />
        {/* 仅展示品牌，不做跳转；顶栏空白区按住拖动窗口、双击最大化/还原（控件/标题/搜索区除外） */}
        <div className="topbar-brand">
          <img
            className="app-logo-icon"
            src={customIconUrl ?? (theme === 'dark' ? appIconUrl : appIconLightUrl)}
            alt=""
            width={22}
            height={22}
          />
          {/* 模式切换按钮：标题右侧 16px，悬停标题时浮现（AI走查 ↔ 产品标注） */}
          <div className="topbar-title-zone">
            {/* 固定最小宽度：两种模式标题宽度不同，避免切换时右侧按钮左右移动 */}
            <span className="topbar-title-text">{productMode ? t('productAppName') : t('appName')}</span>
            <button
              type="button"
              className={`topbar-icon-btn mode-toggle-btn${modeSwitching ? ' switching' : ''}`}
              onClick={handleToggleMode}
              title={productMode ? t('switchToWalk') : t('switchToProduct')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                {/* 两条对置的弧线箭头（互不相连），点击切换时沿圆环轨道顺时针流动一圈 */}
                <g className="orbit-arrows">
                  {/* 顶部弧线 → 实心箭头（指向右下，顺时针切线方向） */}
                  <path d="M4.75 8.62A8 8 0 0 1 19.25 8.62" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <path d="M0 0-4.2-2.7-4.2 2.7Z" fill="currentColor" transform="translate(19.25 8.62) rotate(65)" />
                  {/* 底部弧线 → 实心箭头（指向左上，顺时针切线方向） */}
                  <path d="M19.25 15.38A8 8 0 0 1 4.75 15.38" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <path d="M0 0-4.2-2.7-4.2 2.7Z" fill="currentColor" transform="translate(4.75 15.38) rotate(-115)" />
                </g>
              </svg>
            </button>
          </div>
        </div>
        {/* 全局搜索：产品模式下搜索产品标注内容，走查模式下搜索走查内容 */}
        <TopbarSearch productMode={productMode} />
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
          {/* 底部：Designed by + 侧边栏折叠按钮（折叠后按钮仍在底部同位置） */}
          <div className="app-sidebar-footer">
            <span className="footer-text">
              Designed by{' '}
              <a
                className="footer-link"
                draggable={false}
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

      {/* AI 小助手：右下角悬浮球 + 对话面板（全局常驻，会话随项目/页面路由隔离）；产品模式为走查专属能力，隐藏 */}
      {!productMode && <AiAssistant />}

      {/* 后台 AI 识别任务：离开任务页后底部常驻入口，点击跳回任务页面
          （完成后由任务页消费结果并清出列表，提示自动消失）；多任务时先展开任务选择列表 */}
      {!productMode && bgTask && (
        <>
          {bgTaskPicker && (
            <>
              <div className="bg-task-backdrop" onClick={() => setBgTaskPicker(false)} />
              <div className="bg-task-picker" role="menu">
                {bgTaskList.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    role="menuitem"
                    className="bg-task-picker-item"
                    onClick={() => {
                      setBgTaskPicker(false)
                      // view 参数让工作台切到任务发起时的模式（手动标注 / 自动走查）
                      navigate(`/project/${task.projectId}/page/${task.pageId}?view=${task.mode}`)
                    }}
                  >
                    <span className={`bg-task-dot${task.status === 'running' ? ' running' : ''}`} aria-hidden />
                    <span className="bg-task-picker-name" title={task.pageName}>
                      {task.pageName || t('bgTaskUnnamed')}
                    </span>
                    <span className={`bg-task-picker-mode ${task.mode}`}>
                      {task.mode === 'auto' ? t('bgTaskModeAuto') : t('bgTaskModeManual')}
                    </span>
                    <span className={`bg-task-picker-state${task.status === 'failed' ? ' failed' : ''}`}>
                      {task.status === 'running'
                        ? t('bgTaskStateRunning')
                        : task.status === 'failed'
                          ? t('bgTaskStateFailed')
                          : t('bgTaskStateDone')}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          <button
            type="button"
            className="bg-task-pill"
            onClick={() => {
              // 单任务直接跳转；多任务展开选择列表
              if (bgTaskList.length <= 1) {
                navigate(`/project/${bgTask.projectId}/page/${bgTask.pageId}?view=${bgTask.mode}`)
              } else {
                setBgTaskPicker((v) => !v)
              }
            }}
          >
            <span className={`bg-task-dot${bgTask.status === 'running' ? ' running' : ''}`} aria-hidden />
            <span className="bg-task-label">
              {bgTask.status === 'running' ? t('bgTaskRunning', { n: bgRunningCount }) : t('bgTaskDone')}
            </span>
            <span className="bg-task-hint">
              {bgTaskList.length > 1 ? t('bgTaskSelect') : t('bgTaskOpen')}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m9 18 6-6-6-6" />
              </svg>
            </span>
          </button>
        </>
      )}

      {/* P06 轻提示容器：视口底部居中，亮/暗随 html[data-theme] */}
      <ToastViewport />

      {/* P06 命令式确认对话框：与 Toast 同级挂载，层级 3050（低于 Toast 3100） */}
      <ConfirmDialogHost />

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
