import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { LayeredRunSummary, LayeredToleranceConfig, StructuredChecksConfig, StyleDiff, StyleNode, ToleranceConfig, WalkCheckOptions } from '../../../shared/types'
import {
  DEFAULT_STRUCTURED_CHECKS,
  DEFAULT_TOLERANCE,
  DEFAULT_WALK_CHECK_OPTIONS,
  LAYERED_TOLERANCE_KEY,
  STRUCTURED_CHECKS_KEY,
  WALK_ANALYSES,
  WALK_DIMENSIONS,
  normalizeLayeredTolerance,
  normalizeStructuredChecks,
  normalizeWalkCheckOptions
} from '../../../shared/types'
import {
  CATEGORY_LABELS,
  db,
  genId,
  touchPage,
  aiAnnotationsToIssues,
  type AnnotationShape,
  type Category,
  type Issue,
  type WalkthroughPage
} from '../db'
import AnnotationCanvas from './AnnotationCanvas'
import DevBrowser, { type DevBrowserHandle } from './DevBrowser'
import IssueEditorModal from './IssueEditorModal'
import MatchConfirmDrawer, { type PendingPair } from './MatchConfirmDrawer'
import ExemptResultDrawer from './ExemptResultDrawer'
import LayeredResultDrawer from './LayeredResultDrawer'
import { WalkCheckOptionsModal, WalkAdvancedModal } from './WalkOptionsModal'
import { buildSkillGuides, type SkillItemLite } from '../utils/skillGuide'
import SkillStatsPanel from './SkillStatsPanel'
import { extractSkillTags, stripSkillTags } from '../utils/skillTags'
import { appendWalkRun, readWalkRuns, type WalkRunRecord } from '../utils/skillStats'
import {
  checkSpec,
  formatSpecSummary,
  loadProjectSpecTokens,
  type SpecCheckToken,
  type SpecViolation
} from '../spec/specCheck'
import { checkElements, type ElementFinding } from '../spec/elementCheck'
import { refineAiRects } from '../spec/aiRectRefine'
import { checkA11y, type A11yFinding } from '../spec/a11yCheck'
import { useAiTasksStore } from '../stores/aiTasks'

/** 自动走查技能选择持久化：last=上次选用的技能集（优先），default=全局默认绑定技能集（兜底） */
const SKILL_LAST_KEY = 'walkLastSkillIds'
const SKILL_DEFAULT_KEY = 'walkDefaultSkillIds'

/** 读取本地存储的技能 id 列表（JSON 字符串数组，异常时返回空） */
function readStoredSkillIds(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    const arr = raw ? (JSON.parse(raw) as unknown) : null
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 低置信度阈值：低于该值的匹配对进入人工确认 */
const CONFIRM_THRESHOLD = 0.6

/** 走查视口高度（页面高度设置项已移除，采集时整页自动适配，预览用固定基准高度） */
const WALK_VP_HEIGHT = 900

/** 走查结果标注工具：browse 仅浏览（抓手平移），其余可直接在结果图上绘制（measure/picker 为直建工具，不弹编辑弹窗） */
type WalkTool = 'browse' | 'point' | 'rect' | 'text' | 'measure' | 'picker'

/** 自动走查标注历史操作（可逆）：add=新增（直建/弹窗），update=拖拽移动；删除走编辑弹窗，不纳入撤销 */
type WalkHistoryOp = { type: 'add'; issue: Issue } | { type: 'update'; before: Issue; after: Issue }

/** 结果层筛选：全部 / AI 视觉 / Token 规范 / 元素清单 / 无障碍 / 结构化调试 / 手动新增 */
type LayerFilter = 'all' | 'structured' | 'spec' | 'visual' | 'manual' | 'element' | 'a11y'

/** 最近一次自动走查的采集缓存（双图 + 程序轨校验所需的设计稿/页面 DOM 根节点，应用重启后失效） */
let lastRunStore: {
  designDataUrl: string
  shotDataUrl: string
  designRoot?: unknown
  domRoot?: unknown
  viewport?: { width: number; height: number }
  /** 设计稿 Frame 尺寸（元素清单校验的设计稿坐标映射用） */
  frameSize?: { width: number; height: number }
} | null = null

/** 弹窗回传的采集结果 */
interface WalkCapture {
  domRoot: { root: unknown } | unknown
  screenshotDataUrl: string
  viewport: { width: number; height: number }
  collected: number
  skipped: number
}

/** 弹窗回传监听器（模块级）：切换页面（组件卸载）后回传仍可达，后台任务继续处理 */
const walkHandlerRef: { current: ((cap: WalkCapture) => void) | null } = { current: null }
let walkListenerRegistered = false
function ensureWalkListener(): void {
  if (walkListenerRegistered) return
  walkListenerRegistered = true
  window.electronAPI.walkOnResult((cap) => walkHandlerRef.current?.(cap))
}

/** 从配置中取 Figma PAT（复用 MCP 管理的令牌字段） */
function patFromConfig(cfg: Record<string, unknown>): string {
  const mcps = (cfg.mcps as { pat?: string; enabled?: boolean }[] | undefined) ?? []
  // 仅读取已启用服务的 PAT（enabled 缺省视为启用）
  const withPat = mcps.find((m) => m.enabled !== false && m.pat && m.pat.trim())
  if (withPat) return withPat.pat!.trim()
  const legacy = cfg.figmaMcp as { pat?: string } | undefined
  return legacy?.pat?.trim() ?? ''
}

function toleranceFromConfig(cfg: Record<string, unknown>): ToleranceConfig {
  return { ...DEFAULT_TOLERANCE, ...((cfg.walkTolerance as Partial<ToleranceConfig>) ?? {}) }
}

function checkOptionsFromConfig(cfg: Record<string, unknown>): WalkCheckOptions {
  return normalizeWalkCheckOptions(cfg.walkCheckOptions as Partial<WalkCheckOptions> | undefined)
}

/** dataUrl → ArrayBuffer（保存截图到本地数据目录用） */
function dataUrlToBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

/** 标注是否带坐标信息、需要渲染到图上（清单手加的问题无坐标不渲染） */
const renderOnCanvas = (i: Issue) =>
  i.shape === 'point' ||
  i.shape === 'text' ||
  i.shape === 'measure' ||
  i.shape === 'picker' ||
  i.width !== 0 ||
  i.height !== 0

/** 归一化矩形重叠度（IoU） */
function rectIoU(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = a.width * a.height + b.width * b.height - inter
  return union > 0 ? inter / union : 0
}

/** 元素清单发现类型 → 描述 i18n key */
const ELEMENT_DESC_KEY: Record<ElementFinding['kind'], string> = {
  'img-broken': 'elImgBroken',
  'element-missing': 'elMissing',
  'text-mismatch': 'elTextMismatch'
}

/** 无障碍发现类型 → 描述 i18n key */
const A11Y_DESC_KEY: Record<A11yFinding['kind'], string> = {
  'img-alt-missing': 'a11yImgAlt',
  'contrast-low': 'a11yContrast',
  'font-too-small': 'a11yFontSmall',
  'tap-target-small': 'a11yTapTarget',
  'input-no-label': 'a11yInputLabel'
}

/** 结果面板迷你工具 icon（线性风格，随文字颜色继承） */
function WalkToolIcon({ name }: { name: WalkTool }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  switch (name) {
    case 'browse':
      return (
        <svg {...common}>
          <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
          <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
          <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
          <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
        </svg>
      )
    case 'point':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        </svg>
      )
    case 'rect':
      return (
        <svg {...common}>
          <rect x="4" y="6" width="16" height="12" rx="1.5" strokeDasharray="4 3" />
        </svg>
      )
    case 'text':
      return (
        <svg {...common}>
          <path d="M5 6V4h14v2" />
          <path d="M12 4v16" />
          <path d="M9 20h6" />
        </svg>
      )
    case 'measure':
      // 两点测量：斜线 + 两端点，与画布上测量标注的渲染形态一致
      return (
        <svg {...common}>
          <path d="M6.5 17.5L17.5 6.5" />
          <circle cx="5" cy="19" r="2" />
          <circle cx="19" cy="5" r="2" />
        </svg>
      )
    case 'picker':
      // 吸管取色
      return (
        <svg {...common}>
          <path d="m2 22 1-1h3l9-9" />
          <path d="M3 21v-3l9-9" />
          <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" />
        </svg>
      )
  }
}

/** 空态插画：浏览器窗口 + 虚线选框 + 光标 + AI 角标（浅蓝渐变风） */
function EmptyIllustration() {
  return (
    <svg className="aw-illo" width="200" height="150" viewBox="0 0 200 150" fill="none" aria-hidden>
      <ellipse cx="100" cy="126" rx="82" ry="12" fill="#dbe6fb" opacity="0.55" />
      <g transform="rotate(-4 100 75)">
        <rect x="34" y="22" width="132" height="92" rx="10" fill="#ffffff" stroke="#c9d9f7" strokeWidth="2" />
        <path d="M34 32c0-5.5 4.5-10 10-10h112c5.5 0 10 4.5 10 10v10H34V32z" fill="#3b82f6" />
        <circle cx="46" cy="37" r="2.6" fill="#ffffff" opacity="0.9" />
        <circle cx="55" cy="37" r="2.6" fill="#ffffff" opacity="0.75" />
        <circle cx="64" cy="37" r="2.6" fill="#ffffff" opacity="0.6" />
        <rect x="46" y="54" width="52" height="7" rx="3.5" fill="#dbe6fb" />
        <rect x="46" y="68" width="36" height="7" rx="3.5" fill="#eef3fd" />
        <rect x="46" y="88" width="44" height="7" rx="3.5" fill="#eef3fd" />
        <rect x="108" y="54" width="46" height="44" rx="6" fill="#f2f6fe" stroke="#bfd3f9" strokeWidth="1.6" />
      </g>
      <rect x="78" y="62" width="46" height="40" rx="4" fill="#e8f0fe" stroke="#3b82f6" strokeWidth="2" strokeDasharray="6 4" />
      <path d="M96 76l14 6-6 2.4-2.6 6z" fill="#2563eb" stroke="#ffffff" strokeWidth="1.6" />
      <g transform="rotate(6 148 100)">
        <rect x="128" y="86" width="40" height="30" rx="8" fill="#2563eb" />
        <text x="148" y="106" textAnchor="middle" fontSize="14" fontWeight="700" fill="#ffffff" fontFamily="-apple-system, sans-serif">AI</text>
      </g>
      <path d="M40 96c-10 8-14 16-10 22" stroke="#9dbdf5" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 5" fill="none" />
      <circle cx="28" cy="120" r="3" fill="#9dbdf5" />
    </svg>
  )
}

interface AutoWalkPanelProps {
  page: WalkthroughPage
  /** 现有问题（自动走查仅展示 imgSet='walk' 的结果，与手动标注隔离） */
  issues: Issue[]
  /** 自动走查流程结束后回调（切换回手动标注查看结果） */
  onWalkDone?: () => void
  /** 聚焦的问题（问题清单点击卡片：双图同步放大定位到该点位并隐藏其他标注） */
  focusIssue?: Issue | null
  /** 退出聚焦 */
  onExitFocus?: () => void
  /** 自动走查设置区（技能 / 自定义检查 / 统计 / 高级调试行）是否展开，由工作台顶部折叠按钮控制 */
  controlsOpen?: boolean
}

/**
 * 自动走查面板：
 * 进入面板自动加载开发页面（URL 由页面设置配置）并读取 Figma 画板尺寸（视口宽度自动匹配），
 * 页面加载完成后自动采集 → Figma 拉设计稿 → AI 视觉走查 + Token 规范校验 + 元素清单校验（可选 a11y）落库，直接出结果；
 * 结构化尺寸 diff 拆为「高级调试」子功能（默认关闭，弹窗手动运行），结果在自动走查 tab 内独立展示（不替换手动上传的双图）。
 */
export default function AutoWalkPanel({ page, issues, onWalkDone, focusIssue, onExitFocus, controlsOpen = true }: AutoWalkPanelProps) {
  const { t } = useTranslation('autoWalkPanel')
  // 弹窗回传监听只注册一次（模块级），页面切换后回传仍可达
  ensureWalkListener()

  // 初始即取页面已保存的 devUrl：进入面板自动加载（内嵌模式）
  const [loadedUrl, setLoadedUrl] = useState(page.devUrl ?? '')
  const [running, setRunning] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pendingPairs, setPendingPairs] = useState<PendingPair[] | null>(null)
  /** 内嵌 webview 页面加载完成（自动触发送走查的前提） */
  const [pageLoaded, setPageLoaded] = useState(false)
  /** 内嵌采集中（防重复点击） */
  const [embedSending, setEmbedSending] = useState(false)
  /** 内嵌画板中 DevBrowser 句柄（reload / runCapture） */
  const devBrowserRef = useRef<DevBrowserHandle | null>(null)
  /** 待采集守卫：点击「开始走查」后置位，页面就绪即发起采集（空态不自动预览/走查） */
  const pendingCaptureRef = useRef(false)
  /** 自定义检查项与容差（config 持久化） */
  const [checkOptions, setCheckOptions] = useState<WalkCheckOptions>(DEFAULT_WALK_CHECK_OPTIONS)
  const [tolerance, setTolerance] = useState<ToleranceConfig>(DEFAULT_TOLERANCE)
  const [checkOpen, setCheckOpen] = useState(false)
  const [tolOpen, setTolOpen] = useState(false)
  /** 自动走查技能集（模块1）：可选技能 + 本次选中（入口在自定义检查项弹窗内）；选中技能以指引文本注入 AI 识别 */
  const [skills, setSkills] = useState<SkillItemLite[]>([])
  const [skillIds, setSkillIds] = useState<string[]>([])
  /** 高级调试子开关（结构化尺寸 diff，默认关闭，config 持久化） */
  const [advancedDebug, setAdvancedDebug] = useState(false)
  /** 分层还原度判定开关（增量旁路，默认关闭，config 持久化） */
  const [layeredEnabled, setLayeredEnabled] = useState(false)
  /** 最近一次走查的分层旁路摘要（随消息条存活，不落库）；layeredOpen 控制明细抽屉显隐（关闭后可从消息条再次打开） */
  const [layeredResult, setLayeredResult] = useState<LayeredRunSummary | null>(null)
  const [layeredOpen, setLayeredOpen] = useState(false)
  /** 结构化对比增强配置（圆角 computed/父级追溯开关 + Hug 文本宽度判定模式，config 持久化） */
  const [structuredChecks, setStructuredChecks] = useState<StructuredChecksConfig>(DEFAULT_STRUCTURED_CHECKS)
  /** 最近一次结构化分析的圆角父级裁剪豁免项（随消息条存活，只读抽屉展示，不落库不进报告） */
  const [exemptDiffs, setExemptDiffs] = useState<StyleDiff[] | null>(null)
  const [exemptOpen, setExemptOpen] = useState(false)
  /** 自动走查独立双图（tab 内展示，与手动上传隔离） */
  const [walkDesignUrl, setWalkDesignUrl] = useState('')
  const [walkShotUrl, setWalkShotUrl] = useState('')
  /** 匹配到的 Figma 画板宽度（进入面板自动读取，内嵌画板视口跟随；未读到前为 null 兜底 1440） */
  const [figmaWidth, setFigmaWidth] = useState<number | null>(null)
  /** 匹配到的 Figma 画板高度（进入面板自动读取，内嵌画板视口高度默认取画板原始尺寸） */
  const [figmaHeight, setFigmaHeight] = useState<number | null>(null)
  /** 最近一次自动走查的采集缓存（程序轨校验复用），design 在前 */
  const lastRunRef = useRef<{
    designDataUrl: string
    shotDataUrl: string
    designRoot?: unknown
    domRoot?: unknown
    viewport?: { width: number; height: number }
    frameSize?: { width: number; height: number }
  } | null>(lastRunStore)
  /** 自动走查结果点击编辑 */
  const [editingIssue, setEditingIssue] = useState<Issue | null>(null)
  /** 结果筛选：层（全部/结构化/视觉/手动）与分类 */
  const [layerFilter, setLayerFilter] = useState<LayerFilter>('all')
  const [catFilter, setCatFilter] = useState<Category | 'all'>('all')
  /** 技能筛选：仅看命中该技能的问题（null=全部，模块3） */
  const [skillFilter, setSkillFilter] = useState<string | null>(null)
  /** 技能效果统计面板展开开关 */
  const [statsOpen, setStatsOpen] = useState(false)
  /** 自动走查运行记录（localStorage 元信息，统计面板联查当前问题库） */
  const [walkRuns, setWalkRuns] = useState<WalkRunRecord[]>(() => readWalkRuns())
  /** 结果面板手动标注工具（两画布共用）与共享缩放（设计稿/开发截图同步缩放） */
  const [walkTool, setWalkTool] = useState<WalkTool>('browse')
  const [walkZoom, setWalkZoom] = useState(1)
  /** 自动走查撤销/重做历史栈（新增/移动共用，无按钮入口，Cmd/Ctrl+Z 直连；切页清空） */
  const [walkUndoStack, setWalkUndoStack] = useState<WalkHistoryOp[]>([])
  const [walkRedoStack, setWalkRedoStack] = useState<WalkHistoryOp[]>([])
  /** 新建走查标注草稿（结果图上绘制后弹出编辑弹窗） */
  const [creatingWalk, setCreatingWalk] = useState<{
    rect: { x: number; y: number; width: number; height: number }
    targetImage: 'design' | 'screenshot'
    shape: AnnotationShape
  } | null>(null)
  /** 双图画布滚动容器（同步滚动 + 抓手拖拽） */
  const designScrollRef = useRef<HTMLDivElement>(null)
  const shotScrollRef = useRef<HTMLDivElement>(null)
  const syncingScroll = useRef(false)

  /** 面板缩放（1~4 倍，步进 0.25），双图同步 */
  const setZoom = (value: number) => setWalkZoom(Math.min(4, Math.max(1, Math.round(value * 4) / 4)))

  /** 双图同步滚动：一处滚动另一处跟随 */
  const handlePanelScroll = (source: 'design' | 'shot') => {
    if (syncingScroll.current) return
    syncingScroll.current = true
    const from = source === 'design' ? designScrollRef.current : shotScrollRef.current
    const to = source === 'design' ? shotScrollRef.current : designScrollRef.current
    if (from && to) {
      to.scrollTop = from.scrollTop
      to.scrollLeft = from.scrollLeft
    }
    syncingScroll.current = false
  }

  /** 抓手拖拽平移：按住拖动转换成滚动位移，双图同步 */
  const handlePanelPanStart = (e: ReactMouseEvent) => {
    if (walkTool !== 'browse') return
    const el = designScrollRef.current
    const el2 = shotScrollRef.current
    if (!el && !el2) return
    e.preventDefault()
    const start = {
      x: e.clientX,
      y: e.clientY,
      sl: designScrollRef.current?.scrollLeft ?? 0,
      st: designScrollRef.current?.scrollTop ?? 0
    }
    const move = (ev: MouseEvent) => {
      const dx = start.sl - (ev.clientX - start.x)
      const dy = start.st - (ev.clientY - start.y)
      if (el) {
        el.scrollLeft = dx
        el.scrollTop = dy
      }
      if (el2) {
        el2.scrollLeft = dx
        el2.scrollTop = dy
      }
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // 当页面编辑弹窗保存后，page.devUrl 会变化：同步加载 URL 并清除待采集守卫
  useEffect(() => {
    setLoadedUrl(page.devUrl ?? '')
    pendingCaptureRef.current = false
    setPageLoaded(false)
  }, [page.devUrl, page.id])

  // 进入面板 / 切换页面：自动读取 Figma 画板尺寸（视口宽度匹配用）；无连接报错，无 PAT 兜底 1440 放行
  useEffect(() => {
    let cancelled = false
    setFigmaWidth(null)
    setFigmaHeight(null)
    const figUrl = (page.figmaUrl ?? '').trim()
    if (!figUrl) {
      setMsg({ ok: false, text: t('errNoFigmaUrl') })
      return
    }
    void (async () => {
      try {
        const cfg = await window.electronAPI.getConfig()
        if (cancelled) return
        const pat = patFromConfig(cfg)
        if (!pat) {
          setMsg({ ok: false, text: t('errNoPat') })
          setFigmaWidth(1440)
          return
        }
        const size = await window.electronAPI.figmaNodeSize({ pat, figmaUrl: figUrl })
        if (cancelled) return
        if (size.ok && size.width) {
          setFigmaWidth(size.width)
          if (size.height) setFigmaHeight(size.height)
        } else {
          setMsg({ ok: false, text: size.message })
          setFigmaWidth(1440)
        }
      } catch {
        if (!cancelled) setFigmaWidth(1440)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [page.figmaUrl, page.id, t])

  // ===== 聚焦查看：放大到 2x，双图画布滚动居中到问题点位 =====
  useEffect(() => {
    if (!focusIssue) return
    setZoom(2)
    const raf = window.requestAnimationFrame(() => {
      for (const el of [designScrollRef.current, shotScrollRef.current]) {
        if (!el) continue
        const img = el.querySelector('img')
        if (!img) continue
        const r = img.getBoundingClientRect()
        if (!r.width || !r.height) continue
        el.scrollLeft = (focusIssue.x + focusIssue.width / 2) * r.width - el.clientWidth / 2
        el.scrollTop = (focusIssue.y + focusIssue.height / 2) * r.height - el.clientHeight / 2
      }
    })
    return () => window.cancelAnimationFrame(raf)
  }, [focusIssue, walkZoom])

  // ===== 初始化：读取配置 + 加载走查双图 =====
  useEffect(() => {
    void window.electronAPI.getConfig().then((c) => {
      setCheckOptions(checkOptionsFromConfig(c))
      setTolerance(toleranceFromConfig(c))
      setAdvancedDebug(c.walkAdvancedDebug === true)
      setLayeredEnabled(
        normalizeLayeredTolerance(c.walkLayeredTolerance as Partial<LayeredToleranceConfig> | undefined).enabled
      )
      setStructuredChecks(
        normalizeStructuredChecks(c.walkStructuredChecks as Partial<StructuredChecksConfig> | undefined)
      )
      // 加载技能列表 + 恢复上次选用的技能集（无记录回退全局默认绑定），过滤已删除的技能
      const skillList = (c.skills as SkillItemLite[] | undefined) ?? []
      setSkills(skillList)
      const lastIds = readStoredSkillIds(SKILL_LAST_KEY).filter((id) => skillList.some((s) => s.id === id))
      setSkillIds(
        lastIds.length ? lastIds : readStoredSkillIds(SKILL_DEFAULT_KEY).filter((id) => skillList.some((s) => s.id === id))
      )
    })
  }, [])

  // 页面走查双图路径变化（含首次进入）时加载
  useEffect(() => {
    if (page.walkDesignPath) {
      void window.electronAPI.readImage(page.walkDesignPath).then((url) => setWalkDesignUrl(url ?? ''))
    } else {
      setWalkDesignUrl('')
    }
    if (page.walkShotPath) {
      void window.electronAPI.readImage(page.walkShotPath).then((url) => setWalkShotUrl(url ?? ''))
    } else {
      setWalkShotUrl('')
    }
  }, [page.walkDesignPath, page.walkShotPath])



  /** 自动走查 imgSet='walk' 的问题（与手动标注隔离） */
  const walkIssues = useMemo(() => issues.filter((i) => i.imgSet === 'walk'), [issues])
  /** 按层与分类筛选后的结果（画布标注与计数联动）；技能筛选仅看命中该技能的问题（模块3） */
  const filteredWalkIssues = useMemo(
    () =>
      walkIssues.filter(
        (i) =>
          (layerFilter === 'all' || i.source === layerFilter) &&
          (catFilter === 'all' || i.category === catFilter) &&
          (!skillFilter || extractSkillTags(i.description).includes(skillFilter))
      ),
    [walkIssues, layerFilter, catFilter, skillFilter]
  )
  /** 结果中出现过的命中技能（按首次出现序，技能筛选 chip 组） */
  const walkSkillNames = useMemo(() => {
    const set = new Set<string>()
    for (const i of walkIssues) extractSkillTags(i.description).forEach((n) => set.add(n))
    return [...set]
  }, [walkIssues])
  const walkDesignIssues = useMemo(
    () => filteredWalkIssues.filter((i) => i.targetImage === 'design' && renderOnCanvas(i)),
    [filteredWalkIssues]
  )
  const walkShotIssues = useMemo(
    () => filteredWalkIssues.filter((i) => i.targetImage === 'screenshot' && renderOnCanvas(i)),
    [filteredWalkIssues]
  )
  const structCount = walkIssues.filter((i) => i.source === 'structured').length
  const specCount = walkIssues.filter((i) => i.source === 'spec').length
  const visualCount = walkIssues.filter((i) => i.source === 'visual').length
  const manualCount = walkIssues.filter((i) => i.source === 'manual').length
  const elementCount = walkIssues.filter((i) => i.source === 'element').length
  const a11yCount = walkIssues.filter((i) => i.source === 'a11y').length
  /** 结果中出现过的分类（按固定顺序） */
  const walkCategories = useMemo(() => {
    const present = new Set(walkIssues.map((i) => i.category))
    return (Object.keys(CATEGORY_LABELS) as Category[]).filter((c) => present.has(c))
  }, [walkIssues])


  /** 内嵌画板视口：宽度取 Figma 画板尺寸（未匹配前 1440 兜底），高度取画板原始高度（未匹配前固定基准） */
  const previewVp = useMemo(() => ({ width: figmaWidth ?? 1440, height: figmaHeight ?? WALK_VP_HEIGHT }), [figmaWidth, figmaHeight])

  /** 走查序号：仅对自动走查组（imgSet='walk'）按创建时间编号，与问题清单（自动走查模式只列走查问题）口径一致 */
  const issueNos = useMemo(() => {
    const m = new Map<string, number>()
    ;[...walkIssues]
      .sort((a, b) => a.createdAt - b.createdAt)
      .forEach((i, idx) => m.set(i.id, idx + 1))
    return m
  }, [walkIssues])

  /** 聚焦条展示用：去掉命中技能标注后的干净描述与命中技能名（模块3） */
  const focusClean = focusIssue
    ? {
        desc: stripSkillTags(focusIssue.description),
        names: extractSkillTags(focusIssue.description)
      }
    : null

  /** 批量落库（imgSet='walk'），并按来源去重：程序校验结果（Token/元素清单/a11y）优先，AI 视觉仅保留未被覆盖的 */
  const saveIssues = async (
    diffs: StyleDiff[],
    /** AI 视觉候选：已经 aiAnnotationsToIssues 转换为 Issue 行（测量换算 px、吸色已取样） */
    visualCandidates: Issue[],
    /** 额外去重基准：本次走查已先行落库的程序校验行（先于视觉轨落库） */
    specBase: Issue[] = []
  ): Promise<{ structured: number; visual: number; visualSaved: Issue[] }> => {
    const now = Date.now()
    const rows: Issue[] = diffs.map((d, i) => ({
      id: genId(),
      pageId: page.id,
      targetImage: 'screenshot',
      x: d.rect.x,
      y: d.rect.y,
      width: d.rect.width,
      height: d.rect.height,
      shape: d.colorHex ? 'picker' : 'rect',
      color: d.colorHex,
      description: d.description,
      severity: d.severity,
      category: d.category,
      status: 'pending',
      source: 'structured',
      imgSet: 'walk',
      figmaNodeId: d.figmaNodeId,
      domPath: d.domPath,
      matchConfidence: d.matchConfidence,
      createdAt: now + i
    }))
    const structuredRows = rows
    // 去重基准：结构化差异 + 已落库的规范校验行（同类别 + 区域重叠视为已覆盖）
    const dedupBase = [...structuredRows, ...specBase]
    // 视觉候选：与结构化差异（同类别 + 区域重叠）去重后保留
    for (const v of visualCandidates) {
      const covered = dedupBase.some((s) => s.category === v.category && rectIoU(s, v) > 0.2)
      if (covered) continue
      rows.push(v)
    }
    if (rows.length) {
      await db.issues.bulkAdd(rows)
      void touchPage(page.id)
    }
    return {
      structured: structuredRows.length,
      visual: rows.length - structuredRows.length,
      /** 本次实际落库的视觉问题行（模块3 运行记录联查用） */
      visualSaved: rows.slice(structuredRows.length)
    }
  }

  // ===== 重新走查（rewalk 按钮 / 手动入口）：校验 → 加载页面 → 自动采集 =====
  const startWalk = async () => {
    if (running) return
    const devUrl = resolveDevUrl(page.devUrl ?? '')
    if (!devUrl) {
      setMsg({ ok: false, text: t('errNoDevUrl') })
      return
    }
    const figUrl = page.figmaUrl?.trim() ?? ''
    if (!figUrl) {
      setMsg({ ok: false, text: t('errNoFigmaUrl') })
      return
    }
    if (walkDesignUrl || walkShotUrl) {
      if (!window.confirm(t('rewalkConfirm'))) {
        return
      }
    }
    setRunning(true)
    setMsg({ ok: true, text: t('readingFigma') })
    try {
      const cfg = await window.electronAPI.getConfig()
      // AI 任务默认浏览器：系统浏览器仅打开页面浏览，无法自动采集标注
      if ((cfg['aiDefaultBrowser'] as string | undefined) === 'system') {
        window.open(devUrl)
        setMsg({
          ok: true,
          text: t('sysBrowserOpened')
        })
        return
      }
      const pat = patFromConfig(cfg)
      if (!pat) {
        setMsg({ ok: false, text: t('errNoPat') })
        return
      }
      // 重新走查：立即清空双图画板旧图（设计稿/开发截图），新采集落库后由 effect 回填新图
      setWalkDesignUrl('')
      setWalkShotUrl('')
      // 1. 轻量读取画板宽度（视口宽度自动匹配）
      const size = await window.electronAPI.figmaNodeSize({ pat, figmaUrl: figUrl })
      if (!size.ok || !size.width) {
        setMsg({ ok: false, text: size.message })
        return
      }
      setFigmaWidth(size.width)
      if (size.height) setFigmaHeight(size.height)
      // 2. 保存连接与 URL，在下方内嵌画板加载页面后自动采集
      await db.pages.update(page.id, { figmaUrl: figUrl, devUrl, updatedAt: Date.now() })
      if (devUrl !== loadedUrl) {
        // 换 URL：重新加载，pageLoaded 后由待采集 effect 接手
        pendingCaptureRef.current = true
        setPageLoaded(false)
        setLoadedUrl(devUrl)
      } else if (pageLoaded) {
        // 同一页面已加载：直接采集
        void runEmbeddedCapture()
      } else {
        // 同一页面未加载完成：reload，加载完成后由待采集 effect 接手
        pendingCaptureRef.current = true
        devBrowserRef.current?.reload()
      }
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setRunning(false)
    }
  }

  /** 规范校验违例 → 问题行（描述按当前语言拼装；坐标已归一化 0~1，与画布口径一致） */
  const violationToIssue = (v: SpecViolation, i: number): Issue => {
    const delta =
      v.deltaKind === 'deltaE'
        ? t('deltaE', { v: (v.deltaValue ?? 0).toFixed(1) })
        : v.deltaKind === 'px'
          ? t('deltaPx', { v: Math.round(Math.abs(v.deltaValue ?? 0)) })
          : t('styleMismatch')
    return {
      id: genId(),
      pageId: page.id,
      targetImage: 'screenshot',
      x: v.rect.x,
      y: v.rect.y,
      width: v.rect.width,
      height: v.rect.height,
      shape: 'rect',
      description: t('specIssueDesc', {
        prop: t(v.propKey),
        actual: v.actualText,
        token: v.tokenName,
        expected: v.expectedText,
        delta
      }),
      severity: v.severity,
      category: v.category,
      status: 'pending',
      source: 'spec',
      imgSet: 'walk',
      domPath: v.node.domPath,
      createdAt: Date.now() + i
    }
  }

  /** 元素清单发现 → 问题行（缺失元素框选在设计稿上，其余在开发截图；坐标已归一化 0~1） */
  const elementFindingToIssue = (f: ElementFinding, i: number): Issue => ({
    id: genId(),
    pageId: page.id,
    targetImage: f.targetImage,
    x: f.rect.x,
    y: f.rect.y,
    width: f.rect.width,
    height: f.rect.height,
    shape: 'rect',
    description: t(ELEMENT_DESC_KEY[f.kind], {
      text: f.designText ?? '',
      design: f.designText ?? '',
      dom: f.domText ?? ''
    }),
    severity: f.severity,
    category: f.category,
    status: 'pending',
    source: 'element',
    imgSet: 'walk',
    domPath: f.domPath ?? f.node?.domPath ?? f.designNode?.domPath,
    createdAt: Date.now() + i
  })

  /** 无障碍发现 → 问题行（统一标注在开发截图上） */
  const a11yFindingToIssue = (f: A11yFinding, i: number): Issue => ({
    id: genId(),
    pageId: page.id,
    targetImage: 'screenshot',
    x: f.rect.x,
    y: f.rect.y,
    width: f.rect.width,
    height: f.rect.height,
    shape: 'rect',
    description: t(A11Y_DESC_KEY[f.kind], { actual: f.actualText ?? '', expected: f.expectedText ?? '' }),
    severity: f.severity,
    category: f.category,
    status: 'pending',
    source: 'a11y',
    imgSet: 'walk',
    domPath: f.domPath ?? f.node.domPath,
    createdAt: Date.now() + i
  })

  // ===== 采集回传 → 保存双图 → 程序轨校验（Token / 元素清单 / 可选 a11y）→ AI 视觉走查 =====
  const handleCaptured = async (cap: WalkCapture) => {
    setRunning(true)
    setMsg({ ok: true, text: t('capturedReading') })
    /** 后台任务 id（注册前出错时为 null，catch 里按需上报失败） */
    let taskId: string | null = null
    try {
      const cfg = await window.electronAPI.getConfig()
      const pat = patFromConfig(cfg)
      if (!pat) throw new Error(t('errNoPat'))
      const figUrl = page.figmaUrl?.trim() || ''
      const fig = await window.electronAPI.figmaFetchDesign({ pat, figmaUrl: figUrl })
      if (!fig.ok || !fig.data) throw new Error(fig.message)
      // 保存走查独立双图（清理旧的走查图，不动手动上传的双图）
      const oldWalkPaths = [page.walkDesignPath, page.walkShotPath].filter(Boolean) as string[]
      const [designPath, shotPath] = await Promise.all([
        window.electronAPI.saveImage(dataUrlToBuffer(fig.data.screenshotDataUrl), 'png'),
        window.electronAPI.saveImage(dataUrlToBuffer(cap.screenshotDataUrl), 'png')
      ])
      for (const p of oldWalkPaths) await window.electronAPI.deleteImage(p).catch(() => undefined)
      await db.pages.update(page.id, { walkDesignPath: designPath, walkShotPath: shotPath, updatedAt: Date.now() })
      const lastRun = {
        designDataUrl: fig.data.screenshotDataUrl,
        shotDataUrl: cap.screenshotDataUrl,
        designRoot: fig.data.root,
        domRoot: cap.domRoot,
        viewport: cap.viewport,
        frameSize: fig.data.frameSize
      }
      lastRunRef.current = lastRun
      lastRunStore = lastRun
      // ===== 程序轨：设计规范 Token 校验（只依赖页面 DOM 与绑定规范，先独立落库；AI 失败也不影响）=====
      let specRows: Issue[] = []
      let specToks: SpecCheckToken[] = []
      try {
        specToks = await loadProjectSpecTokens(page.projectId, page.platform)
        if (specToks.length && cap.domRoot) {
          const violations = checkSpec(cap.domRoot as StyleNode, specToks, cap.viewport, toleranceFromConfig(cfg))
          if (violations.length) {
            // 覆盖上一轮规范校验结果（程序生成行无人工确认态，状态随重跑重置）
            const oldSpec = walkIssues.filter((i) => i.source === 'spec')
            if (oldSpec.length) await db.issues.bulkDelete(oldSpec.map((i) => i.id))
            specRows = violations.map(violationToIssue)
            await db.issues.bulkAdd(specRows)
            void touchPage(page.id)
          }
        }
      } catch {
        // 规范校验失败不阻断走查主流程
      }
      // ===== 程序轨：元素清单一致性校验（图片加载失败 / 元素缺失 / 文案不一致）=====
      let elementRows: Issue[] = []
      try {
        if (lastRun.designRoot && cap.domRoot) {
          const findings = checkElements(
            lastRun.designRoot as StyleNode,
            cap.domRoot as StyleNode,
            lastRun.frameSize ?? cap.viewport,
            cap.viewport
          )
          if (findings.length) {
            // 覆盖上一轮元素清单结果（程序生成行无人工确认态，状态随重跑重置）
            const oldElement = walkIssues.filter((i) => i.source === 'element')
            if (oldElement.length) await db.issues.bulkDelete(oldElement.map((i) => i.id))
            elementRows = findings.map(elementFindingToIssue)
            await db.issues.bulkAdd(elementRows)
            void touchPage(page.id)
          }
        }
      } catch {
        // 元素清单校验失败不阻断走查主流程
      }
      // ===== 程序轨：无障碍 a11y 检查（默认关闭，自定义检查项中按需开启）=====
      let a11yRows: Issue[] = []
      try {
        if (checkOptions.a11y && cap.domRoot) {
          const findings = checkA11y(cap.domRoot as StyleNode, cap.viewport)
          if (findings.length) {
            const oldA11y = walkIssues.filter((i) => i.source === 'a11y')
            if (oldA11y.length) await db.issues.bulkDelete(oldA11y.map((i) => i.id))
            a11yRows = findings.map(a11yFindingToIssue)
            await db.issues.bulkAdd(a11yRows)
            void touchPage(page.id)
          }
        }
      } catch {
        // a11y 检查失败不阻断走查主流程
      }
      // AI 视觉走查：按自定义检查项注入 prompt，标注设计规范问题
      const models = (cfg.aiModels as { id: string }[] | undefined) ?? []
      const modelId = (cfg.aiDefaultModelId as string | undefined) ?? models[0]?.id ?? ''
      if (!modelId) {
        const progCount = specRows.length + elementRows.length + a11yRows.length
        setMsg({
          ok: false,
          text: progCount ? `${t('errNoModel')} ${t('progFound', { count: progCount })}` : t('errNoModel')
        })
        return
      }
      // 注册后台任务：切换页面不影响识别，返回页面时从这里恢复状态
      taskId = useAiTasksStore.getState().start(page.id, page.pageName)
      setMsg({ ok: true, text: t('aiRunning') })
      // 自动走查技能集：与手动标注页同一套拼接规则，把选中技能转为指引文本注入识别请求
      const skillGuides = buildSkillGuides(skills, skillIds)
      const res = await window.electronAPI.aiAnnotate({
        modelId,
        pageName: page.pageName,
        platformLabel: '',
        designDataUrl: lastRun.designDataUrl,
        shotDataUrl: lastRun.shotDataUrl,
        walkOptions: {
          dimensionLabels: WALK_DIMENSIONS.filter((d) => checkOptions.dimensions.includes(d.key)).map((d) => d.label),
          depth: checkOptions.depth,
          analysisLabels: WALK_ANALYSES.filter((a) => checkOptions.analysis.includes(a.key)).map((a) => a.label),
          style: checkOptions.style,
          specSummary: specToks.length ? formatSpecSummary(specToks) : undefined
        },
        skillGuides: skillGuides.length ? skillGuides : undefined
      })
      // 任务被用户中断：丢弃结果，不落库
      if (useAiTasksStore.getState().tasks.find((t) => t.id === taskId)?.status === 'interrupted') {
        useAiTasksStore.getState().clear(taskId)
        return
      }
      if (!res.ok) {
        useAiTasksStore.getState().finish(taskId, false, res.message)
        setMsg({ ok: false, text: t('aiFailContinue', { msg: res.message }) })
        // 高级调试开启时，AI 失败也补跑一次结构化 diff（有精确还原调试需求的开发用）
        if (cfg.walkAdvancedDebug === true) await runStructured({ force: true })
        return
      }
      // 覆盖未审核的旧视觉候选后落库
      const unconfirmed = walkIssues.filter((i) => i.source === 'visual' && i.isAISuggested && !i.aiConfirmed)
      if (unconfirmed.length) await db.issues.bulkDelete(unconfirmed.map((i) => i.id))
      // AI 结果转 Issue：测量标注换算 px、吸色标注双图取样，再与结构化差异去重落库
      const visualRows = await aiAnnotationsToIssues(
        page.id,
        res.issues ?? [],
        lastRun.designDataUrl,
        lastRun.shotDataUrl,
        { imgSet: 'walk' }
      )
      // AI 视觉框吸附到 DOM/Figma 真实元素矩形，消除模型坐标估算偏移
      refineAiRects(visualRows, {
        domRoot: lastRun.domRoot as StyleNode | null,
        viewport: lastRun.viewport,
        designRoot: lastRun.designRoot,
        frameSize: lastRun.frameSize
      })
      const { visual, visualSaved } = await saveIssues([], visualRows, [...specRows, ...elementRows, ...a11yRows])
      const total = res.issues?.length ?? 0
      let doneText = total
        ? t('visualDone', { count: visual, dup: total - visual })
        : t('visualDoneNone')
      if (specRows.length) doneText += ` ${t('specFound', { count: specRows.length })}`
      if (elementRows.length) doneText += ` ${t('elementFound', { count: elementRows.length })}`
      if (a11yRows.length) doneText += ` ${t('a11yFound', { count: a11yRows.length })}`
      useAiTasksStore.getState().finish(taskId, true, doneText)
      setMsg({ ok: true, text: doneText })
      // 记录本次走查运行元信息（模块3 技能效果统计：localStorage，问题本体联查当前问题库）
      setWalkRuns(
        appendWalkRun({
          ts: Date.now(),
          pageId: page.id,
          pageName: page.pageName,
          skillUsed: skillGuides.length > 0,
          skillNames: skills.filter((s) => skillIds.includes(s.id)).map((s) => s.name),
          issueIds: visualSaved.map((i) => i.id)
        })
      )
      // 高级调试开启时，AI 完成后自动补跑一次结构化 diff
      if (cfg.walkAdvancedDebug === true) await runStructured({ force: true })
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err)
      if (taskId) useAiTasksStore.getState().finish(taskId, false, errText)
      setMsg({ ok: false, text: errText })
    } finally {
      setRunning(false)
    }
  }

  // 弹窗回传 → 面板处理（handler 挂模块级 ref，规避闭包过期；卸载不清除，后台任务继续）
  const capturedRef = useRef(handleCaptured)
  capturedRef.current = handleCaptured
  walkHandlerRef.current = (cap) => void capturedRef.current(cap)

  // ===== 低置信度确认：加入选中差异（结果留在当前页查看，不跳转） =====
  const handleConfirmPairs = async (picked: PendingPair[]) => {
    const all: StyleDiff[] = picked.flatMap((p) => p.diffs)
    const fresh = await filterNewDiffs(all)
    if (!fresh.length) {
      setPendingPairs(null)
      setMsg({ ok: true, text: t('dupNone') })
      return
    }
    const { structured } = await saveIssues(fresh, [])
    setPendingPairs(null)
    setMsg({ ok: true, text: t('confirmAdded', { count: structured }) })
  }

  /** 结构化差异去重：与已落库的 walk 结构化问题按（图层节点 + DOM 路径 + 分类 + 描述）比对，跳过重复项 */
  const filterNewDiffs = async (diffs: StyleDiff[]): Promise<StyleDiff[]> => {
    const existing = walkIssues.filter((i) => i.source === 'structured')
    const keyOf = (d: { figmaNodeId?: string; domPath?: string; category: string; description: string }) =>
      `${d.figmaNodeId ?? ''}|${d.domPath ?? ''}|${d.category}|${d.description}`
    const seen = new Set(existing.map(keyOf))
    return diffs.filter((d) => {
      const k = keyOf(d)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }

  // ===== 高级调试：结构化尺寸 diff（默认关闭；弹窗手动运行，或开启后随走查自动补跑） =====
  const runStructured = async (opts?: { force?: boolean }) => {
    if (!opts?.force && running) return
    const run = lastRunRef.current
    if (!run || !run.designRoot || !run.domRoot) {
      setMsg({ ok: false, text: t('structuredStale') })
      return
    }
    setRunning(true)
    setMsg({ ok: true, text: t('matching') })
    // 重跑时清空上一次分层旁路摘要与抽屉，避免残留
    setLayeredResult(null)
    setLayeredOpen(false)
    // 同步清空上一次圆角豁免项与抽屉
    setExemptDiffs(null)
    setExemptOpen(false)
    try {
      const cfg = await window.electronAPI.getConfig()
      // 检查深度映射：容差倍率（宽松 ×2 / 标准 ×1 / 严格 ÷2）；宽高与内边距/间距仅严格模式比对
      const factor = checkOptions.depth === 'loose' ? 2 : checkOptions.depth === 'strict' ? 0.5 : 1
      const base = toleranceFromConfig(cfg)
      const tolerance = {
        size: base.size * factor,
        typography: base.typography * factor,
        spacing: base.spacing * factor,
        radius: base.radius * factor,
        border: base.border * factor,
        color: base.color * factor
      }
      const cmp = await window.electronAPI.walkthroughCompare({
        designRoot: run.designRoot as never,
        domRoot: run.domRoot as never,
        tolerance,
        viewport: run.viewport ?? { width: figmaWidth ?? 1440, height: figmaHeight ?? WALK_VP_HEIGHT },
        includeSizeSpacing: checkOptions.depth === 'strict'
      })
      // 分层旁路结果：仅摘要展示与明细抽屉（不落库、不进问题清单、不进报告）
      const layered = cmp.layered?.enabled ? cmp.layered : null
      if (layered) setLayeredResult(layered)
      // 圆角父级裁剪豁免项：仅摘要展示与只读抽屉（不落库、不进问题清单、不进报告）
      const exempt = cmp.exemptDiffs?.length ? cmp.exemptDiffs : null
      if (exempt) setExemptDiffs(exempt)
      // 拆分：高置信度自动落库；低置信度进人工确认
      const autoDiffs = cmp.diffs.filter((d) => d.matchConfidence >= CONFIRM_THRESHOLD)
      const pending: PendingPair[] = cmp.pairs
        .filter((p) => p.confidence < CONFIRM_THRESHOLD)
        .map((p) => ({
          pair: p,
          diffs: cmp.diffs.filter(
            (d) =>
              d.matchConfidence < CONFIRM_THRESHOLD &&
              d.figmaNodeId === p.design.figmaNodeId &&
              d.domPath === p.dom.domPath
          )
        }))
        .filter((it) => it.diffs.length > 0)
      // 高置信度自动落库（去重后追加）；低置信度进人工确认
      const freshAuto = await filterNewDiffs(autoDiffs)
      const { structured } = await saveIssues(freshAuto, [])
      const parts = [
        structured
          ? freshAuto.length < autoDiffs.length
            ? t('structuredSkipped', { count: structured, skipped: autoDiffs.length - freshAuto.length })
            : t('structuredAdded', { count: structured })
          : autoDiffs.length
            ? t('structuredDup')
            : t('structuredNone'),
        pending.length ? t('pendingConfirm', { count: pending.length }) : '',
        t('unmatched', { d: cmp.unmatchedDesignCount, e: cmp.unmatchedDomCount }),
        layered
          ? t('layeredSummary', {
              score: Math.round(layered.score),
              moduleAbsorbed: layered.moduleAbsorbed,
              elementReported: layered.elementReported
            })
          : '',
        exempt ? t('exemptSummary', { count: exempt.length }) : ''
      ].filter(Boolean)
      setMsg({ ok: true, text: parts.join(t('sep')) })
      if (pending.length) setPendingPairs(pending)
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setRunning(false)
    }
  }

  /** 解析并校验开发页面 URL：拦截应用自身地址（加载会导致内置浏览器嵌套假死） */
  const resolveDevUrl = (raw: string): string | null => {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
    try {
      if (new URL(url).origin === window.location.origin) {
        setMsg({ ok: false, text: t('selfUrlErr') })
        return null
      }
    } catch {
      // 非法 URL 交给页面加载流程报错
    }
    return url
  }

  /** 内嵌画板采集：直接调用 DevBrowser 采集 DOM + 截图，走弹窗同一条回传处理链路 */
  const runEmbeddedCapture = async (): Promise<void> => {
    if (!devBrowserRef.current || embedSending) return
    setEmbedSending(true)
    try {
      // 采集尺寸按 Figma 画板设计尺寸：高度用 figmaHeight（未取到时回退文档实际高度）
      const cap = await devBrowserRef.current.runCapture(true, figmaHeight ?? undefined)
      void capturedRef.current(cap)
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setEmbedSending(false)
    }
  }

  /** 保存自定义检查项 */
  const saveCheckOptions = (opts: WalkCheckOptions) => {
    setCheckOptions(opts)
    void window.electronAPI.setConfig('walkCheckOptions', opts)
    setCheckOpen(false)
  }

  /** 保存容差（仅作用于高级调试的结构化 diff） */
  const saveTolerance = (t: ToleranceConfig) => {
    setTolerance(t)
    void window.electronAPI.setConfig('walkTolerance', t)
    setTolOpen(false)
  }

  /** 切换高级调试子开关（结构化尺寸 diff，config 持久化） */
  const toggleAdvancedDebug = (v: boolean) => {
    setAdvancedDebug(v)
    void window.electronAPI.setConfig('walkAdvancedDebug', v)
  }

  /** 切换分层还原度判定开关：只翻 enabled，写回前重读配置合并，避免覆盖 Settings 页修改的容差/权重 */
  const toggleLayered = async (v: boolean) => {
    setLayeredEnabled(v)
    const cfg = await window.electronAPI.getConfig()
    const cur = normalizeLayeredTolerance(cfg.walkLayeredTolerance as Partial<LayeredToleranceConfig> | undefined)
    void window.electronAPI.setConfig(LAYERED_TOLERANCE_KEY, { ...cur, enabled: v })
  }

  /** 修改结构化对比增强配置（独立配置键，整对象直写即可） */
  const changeStructuredChecks = (v: StructuredChecksConfig) => {
    setStructuredChecks(v)
    void window.electronAPI.setConfig(STRUCTURED_CHECKS_KEY, v)
  }

  /** 记录一步可撤销操作（新操作入栈时清空重做栈，最多保留 50 步） */
  const pushWalkHistory = (op: WalkHistoryOp) => {
    setWalkUndoStack((s) => [...s.slice(-49), op])
    setWalkRedoStack([])
  }

  /** 执行撤销/重做：按操作类型对库做反向/正向写入并刷新页面时间戳 */
  const applyWalkHistoryOp = async (op: WalkHistoryOp, dir: 'undo' | 'redo') => {
    if (op.type === 'add') {
      if (dir === 'undo') await db.issues.bulkDelete([op.issue.id])
      else await db.issues.bulkPut([op.issue])
      void touchPage(op.issue.pageId)
    } else {
      await db.issues.bulkPut([dir === 'undo' ? op.before : op.after])
      void touchPage(op.before.pageId)
    }
  }

  /** 撤销上一步自动走查标注操作（Cmd/Ctrl+Z） */
  const undoWalk = () => {
    const op = walkUndoStack[walkUndoStack.length - 1]
    if (!op) return
    void applyWalkHistoryOp(op, 'undo')
    setWalkUndoStack((s) => s.slice(0, -1))
    setWalkRedoStack((r) => [...r, op])
  }

  /** 重做被撤销的操作（Cmd/Ctrl+Shift+Z） */
  const redoWalk = () => {
    const op = walkRedoStack[walkRedoStack.length - 1]
    if (!op) return
    void applyWalkHistoryOp(op, 'redo')
    setWalkRedoStack((r) => r.slice(0, -1))
    setWalkUndoStack((s) => [...s.slice(-49), op])
  }

  // 切换页面时清空撤销/重做栈（操作与页面绑定，跨页撤销无意义）
  useEffect(() => {
    setWalkUndoStack([])
    setWalkRedoStack([])
  }, [page.id])

  // 快捷键：Cmd/Ctrl+Z 撤销、Cmd/Ctrl+Shift+Z 重做（输入框内交给原生撤销；不设依赖数组，每次渲染重挂保证闭包新鲜）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      e.preventDefault()
      if (e.shiftKey) redoWalk()
      else undoWalk()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /** 走查结果编辑保存（与手动标注一致的编辑弹窗） */
  const saveWalkIssue = async (fields: {
    description: string
    severity: Issue['severity']
    category: Issue['category']
    status: Issue['status']
    targetImage: Issue['targetImage']
    color?: string
    measureValue?: string
  }) => {
    if (!editingIssue) return
    await db.issues.update(editingIssue.id, {
      ...fields,
      ...(editingIssue.isAISuggested && !editingIssue.aiConfirmed ? { aiConfirmed: true } : {})
    })
    void touchPage(editingIssue.pageId)
    setEditingIssue(null)
  }

  const deleteWalkIssue = async () => {
    if (!editingIssue) return
    await db.issues.delete(editingIssue.id)
    void touchPage(editingIssue.pageId)
    setEditingIssue(null)
  }

  /** 结果图上手动新增标注（imgSet='walk'，与自动走查结果同区展示） */
  const createWalkIssue = async (fields: {
    description: string
    severity: Issue['severity']
    category: Issue['category']
    status: Issue['status']
    targetImage: Issue['targetImage']
    color?: string
    measureValue?: string
  }) => {
    if (!creatingWalk) return
    const issue: Issue = {
      id: genId(),
      pageId: page.id,
      targetImage: creatingWalk.targetImage,
      x: creatingWalk.rect.x,
      y: creatingWalk.rect.y,
      width: creatingWalk.rect.width,
      height: creatingWalk.rect.height,
      shape: creatingWalk.shape,
      description: fields.description,
      severity: fields.severity,
      category: fields.category,
      status: 'pending',
      source: 'manual',
      imgSet: 'walk',
      createdAt: Date.now()
    }
    await db.issues.add(issue)
    pushWalkHistory({ type: 'add', issue })
    void touchPage(page.id)
    setCreatingWalk(null)
  }

  /** 测量/吸色直建（不弹编辑弹窗）：按数据形态落库为 measure（含换算 px）或 picker（含取样色）标注 */
  const quickWalkCreate = (
    rect: { x: number; y: number; width: number; height: number },
    targetImage: 'design' | 'screenshot',
    data: { measurePx?: number; colorHex?: string }
  ): void => {
    const base = {
      id: genId(),
      pageId: page.id,
      targetImage,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      status: 'pending' as const,
      source: 'manual' as const,
      imgSet: 'walk' as const,
      createdAt: Date.now()
    }
    if (data.measurePx != null) {
      const px = `${Math.max(1, Math.round(data.measurePx))}px`
      const issue: Issue = {
        ...base,
        shape: 'measure',
        measureValue: px,
        description: t('quickMeasureDesc', { px }),
        severity: 'suggestion',
        category: 'spacing'
      }
      void db.issues.add(issue)
      pushWalkHistory({ type: 'add', issue })
    } else if (data.colorHex) {
      const issue: Issue = {
        ...base,
        shape: 'picker',
        color: data.colorHex,
        description: t('quickPickerDesc', { hex: data.colorHex }),
        severity: 'suggestion',
        category: 'color'
      }
      void db.issues.add(issue)
      pushWalkHistory({ type: 'add', issue })
    } else {
      return
    }
    void touchPage(page.id)
  }

  const hasWalkImages = !!(walkDesignUrl && walkShotUrl)
  // AI 识别后台任务：切页后返回时恢复进行中状态与结果提示
  const aiTasks = useAiTasksStore((s) => s.tasks)
  const aiTaskRunning = aiTasks.some((t) => t.pageId === page.id && t.status === 'running')
  useEffect(() => {
    const finished = aiTasks.filter(
      (t) => t.pageId === page.id && (t.status === 'done' || t.status === 'failed' || t.status === 'interrupted')
    )
    if (finished.length === 0) return
    setMsg({ ok: finished.every((t) => t.status === 'done'), text: finished[finished.length - 1].message })
    finished.forEach((t) => useAiTasksStore.getState().clear(t.id))
  }, [aiTasks, page.id])
  const busy = running || embedSending || aiTaskRunning

  // 点击「开始走查」后：页面加载完成且视口尺寸就绪即自动发起采集（空态不做实时预览，也不自动走查）
  useEffect(() => {
    if (!pendingCaptureRef.current) return
    if (!loadedUrl || !pageLoaded || embedSending || running || aiTaskRunning) return
    if (figmaWidth === null) return
    pendingCaptureRef.current = false
    void runEmbeddedCapture()
  }, [loadedUrl, pageLoaded, embedSending, running, aiTaskRunning, figmaWidth])

  /** 分类标签（cat_* key，连字符转下划线） */
  const enumKey = (v: string) => v.replace(/-/g, '_')
  const catLabel = (c: Category) => t(`cat_${enumKey(c)}`)

  /** 结果面板标注工具定义（随界面语言生成） */
  const WALK_TOOLS: { value: WalkTool; title: string }[] = [
    { value: 'browse', title: t('tool_browse') },
    { value: 'point', title: t('tool_point') },
    { value: 'rect', title: t('tool_rect') },
    { value: 'text', title: t('tool_text') },
    { value: 'measure', title: t('tool_measure') },
    { value: 'picker', title: t('tool_picker') }
  ]

  /** 面板工具条：标注工具切换 + 缩放（设计稿/开发截图共用工具与同步缩放） */
  const renderPanelTools = () => (
    <div className="aw-panel-tools">
      {WALK_TOOLS.map((t) => (
        <button
          key={t.value}
          type="button"
          className={`aw-tool-btn${walkTool === t.value ? ' active' : ''}`}
          title={t.title}
          onClick={() => setWalkTool(t.value)}
        >
          <WalkToolIcon name={t.value} />
        </button>
      ))}
      <span className="aw-tool-sep" />
      <button
        type="button"
        className="aw-tool-btn"
        title={t('zoom_out')}
        disabled={walkZoom <= 1}
        onClick={() => setZoom(walkZoom - 0.25)}
      >
        −
      </button>
      <span className="aw-zoom-val">{Math.round(walkZoom * 100)}%</span>
      <button
        type="button"
        className="aw-tool-btn"
        title={t('zoom_in')}
        disabled={walkZoom >= 4}
        onClick={() => setZoom(walkZoom + 0.25)}
      >
        ＋
      </button>
    </div>
  )

  return (
    <div className="auto-walk">
      {(controlsOpen || msg || aiTaskRunning) && (
      <div className="auto-walk-controls card">
        {controlsOpen && (
          <>
        <div className="auto-walk-row auto-walk-actions">
          <button className="btn-secondary" onClick={() => setCheckOpen(true)} disabled={running}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            {t('customChecks')}
          </button>
          <span className="auto-walk-stats">
            {t('stats', { v: visualCount, p: specCount + elementCount + a11yCount })}
          </span>
          <button className="btn-secondary auto-walk-adv" onClick={() => setTolOpen(true)} disabled={running} title={t('advTitle')}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
              <circle cx="16" cy="7" r="2.2" />
              <circle cx="8" cy="17" r="2.2" />
            </svg>
            {t('advSettings')}
          </button>
          {hasWalkImages && (
            <button className="btn-secondary" onClick={startWalk} disabled={busy}>
              {t('rewalk')}
            </button>
          )}
        </div>
          </>
        )}
        {(msg || aiTaskRunning) && (
          <p
            className={`auto-walk-msg ${msg ? (msg.ok ? 'ok' : 'err') : 'ok'}`}
            /* flex 布局对齐提示条：文字与右侧关闭按钮垂直居中（同 .ai-msg 通知条方案，global.css 不可改走内联样式） */
            style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}
          >
            {msg ? msg.text : t('aiTaskRunning')}
            {/* 分层还原度旁路：有摘要且消息条存活时可查看明细（只读抽屉，不落库不进报告） */}
            {layeredResult && msg && (
              <button type="button" className="auto-walk-cancel" onClick={() => setLayeredOpen(true)}>
                {t('layeredDetail')}
              </button>
            )}
            {/* 圆角父级裁剪豁免项：有结果且消息条存活时可查看明细（只读抽屉，不落库不进报告） */}
            {exemptDiffs && msg && (
              <button type="button" className="auto-walk-cancel" onClick={() => setExemptOpen(true)}>
                {t('exemptDetail')}
              </button>
            )}
            {/* 完成类通知条支持手动关闭（AI 视觉走查完成 / 结构化分析完成等） */}
            {msg && (
              <button
                type="button"
                className="auto-walk-msg-close"
                aria-label={t('close')}
                onClick={() => setMsg(null)}
              >
                ×
              </button>
            )}
          </p>
        )}
      </div>
      )}

      {hasWalkImages ? (
        <div className="aw-result">
          {/* 分类分层筛选：层（AI 视觉/Token/元素清单/a11y/高级调试/手动，有结果才显示）+ 分类维度 */}
          {(walkIssues.length > 0 && (visualCount > 0 || specCount > 0 || elementCount > 0 || a11yCount > 0 || manualCount > 0 || walkCategories.length > 0)) && (
            <div className="aw-filters">
              <div className="aw-chip-group">
                {([
                  { key: 'all', label: t('filterAll', { n: walkIssues.length }) },
                  ...(visualCount ? [{ key: 'visual', label: t('filterVisual', { n: visualCount }) }] : []),
                  ...(specCount ? [{ key: 'spec', label: t('filterSpec', { n: specCount }) }] : []),
                  ...(elementCount ? [{ key: 'element', label: t('filterElement', { n: elementCount }) }] : []),
                  ...(a11yCount ? [{ key: 'a11y', label: t('filterA11y', { n: a11yCount }) }] : []),
                  ...(advancedDebug && structCount
                    ? [{ key: 'structured', label: t('filterStructured', { n: structCount }) }]
                    : []),
                  ...(manualCount ? [{ key: 'manual', label: t('filterManual', { n: manualCount }) }] : [])
                ] as { key: LayerFilter; label: string }[]).map((l) => (
                  <button
                    key={l.key}
                    type="button"
                    className={`aw-chip${layerFilter === l.key ? ' active' : ''}`}
                    onClick={() => setLayerFilter(l.key)}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
              {walkSkillNames.length > 0 && <span className="aw-filter-sep" />}
              {/* 技能筛选组：仅看命中该技能的问题（模块3；插在层与分类组之间，分类组保持 last-child 右对齐） */}
              {walkSkillNames.length > 0 && (
                <div className="aw-chip-group">
                  <button
                    type="button"
                    className={`aw-chip${skillFilter === null ? ' active' : ''}`}
                    onClick={() => setSkillFilter(null)}
                  >
                    {t('skillFilterAll')}
                  </button>
                  {walkSkillNames.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={`aw-chip aw-chip-skill${skillFilter === name ? ' active' : ''}`}
                      title={t('onlySkill', { skill: name })}
                      onClick={() => setSkillFilter(skillFilter === name ? null : name)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
              <span className="aw-filter-sep" />
              {/* 分类组（末位右对齐）：技能效果统计入口紧邻「全部类型」左侧，点击弹出统计弹窗 */}
              <div className="aw-chip-group">
                <button type="button" className="aw-chip" title={t('statsTitle')} onClick={() => setStatsOpen(true)}>
                  {t('statsTitle')}
                </button>
                {walkCategories.length > 0 && (
                  <button
                    type="button"
                    className={`aw-chip${catFilter === 'all' ? ' active' : ''}`}
                    onClick={() => setCatFilter('all')}
                  >
                    {t('catAll')}
                  </button>
                )}
                  {walkCategories.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`aw-chip${catFilter === c ? ' active' : ''}`}
                      title={t('onlyCat', { cat: catLabel(c) })}
                      onClick={() => setCatFilter(catFilter === c ? 'all' : c)}
                    >
                      {catLabel(c)}
                    </button>
                  ))}
              </div>
            </div>
          )}
          {/* 聚焦查看提示条：双图只显示当前问题点位，可退出；描述剥离命中技能标注，命中技能以小标签展示（模块3） */}
          {focusIssue && focusClean && (
            <div className="aw-focus-bar">
              <span>
                {t('focusing', {
                  desc: focusClean.desc.length > 32 ? `${focusClean.desc.slice(0, 32)}…` : focusClean.desc
                })}
              </span>
              {focusClean.names.map((name) => (
                <em key={name} className="aw-skill-tag">
                  {name}
                </em>
              ))}
              {onExitFocus && (
                <button type="button" onClick={onExitFocus}>
                  {t('exitFocus')}
                </button>
              )}
            </div>
          )}
          <div className="aw-result-grid">
            <div className="aw-result-panel card">
              <div className="panel-title">
                {t('designPanelTitle')}
                <span className="panel-count">{t('annCount', { n: walkDesignIssues.length })}</span>
                {renderPanelTools()}
              </div>
              <div className="aw-result-canvas">
                <div
                  className={`aw-zoom-scroll${walkTool === 'browse' ? ' hand-pan' : ''}`}
                  ref={designScrollRef}
                  onScroll={() => handlePanelScroll('design')}
                  onMouseDown={handlePanelPanStart}
                >
                  <div style={{ width: `${walkZoom * 100}%` }}>
                    <AnnotationCanvas
                      dataUrl={walkDesignUrl}
                      alt={t('designAlt')}
                      issues={walkDesignIssues}
                      tool={walkTool === 'browse' ? null : walkTool}
                      panMode={walkTool === 'browse'}
                      logicalWidth={lastRunRef.current?.frameSize?.width ?? (figmaWidth && figmaWidth > 0 ? figmaWidth : undefined)}
                      targetImage="design"
                      noOf={(issue) => issueNos.get(issue.id) ?? 0}
                      focusId={focusIssue?.id ?? null}
                      onCreate={(rect, target) =>
                        setCreatingWalk({ rect, targetImage: target, shape: walkTool as AnnotationShape })
                      }
                      onQuickCreate={quickWalkCreate}
                      onMove={(issue, rect) => {
                        const after = { ...issue, x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                        void db.issues.update(issue.id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
                        pushWalkHistory({ type: 'update', before: issue, after })
                        void touchPage(issue.pageId)
                      }}
                      onEdit={(issue) => setEditingIssue(issue)}
                    />
                  </div>
                </div>
              </div>
            </div>
            <div className="aw-result-panel card">
              <div className="panel-title">
                {t('shotPanelTitle')}
                <span className="panel-count">{t('annCount', { n: walkShotIssues.length })}</span>
                {renderPanelTools()}
              </div>
              <div className="aw-result-canvas">
                <div
                  className={`aw-zoom-scroll${walkTool === 'browse' ? ' hand-pan' : ''}`}
                  ref={shotScrollRef}
                  onScroll={() => handlePanelScroll('shot')}
                  onMouseDown={handlePanelPanStart}
                >
                  <div style={{ width: `${walkZoom * 100}%` }}>
                    <AnnotationCanvas
                      dataUrl={walkShotUrl}
                      alt={t('shotAlt')}
                      issues={walkShotIssues}
                      tool={walkTool === 'browse' ? null : walkTool}
                      panMode={walkTool === 'browse'}
                      logicalWidth={lastRunRef.current?.viewport?.width ?? (figmaWidth && figmaWidth > 0 ? figmaWidth : undefined)}
                      targetImage="screenshot"
                      noOf={(issue) => issueNos.get(issue.id) ?? 0}
                      focusId={focusIssue?.id ?? null}
                      onCreate={(rect, target) =>
                        setCreatingWalk({ rect, targetImage: target, shape: walkTool as AnnotationShape })
                      }
                      onQuickCreate={quickWalkCreate}
                      onMove={(issue, rect) => {
                        const after = { ...issue, x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                        void db.issues.update(issue.id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
                        pushWalkHistory({ type: 'update', before: issue, after })
                        void touchPage(issue.pageId)
                      }}
                      onEdit={(issue) => setEditingIssue(issue)}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
          <p className="auto-walk-hint">
            {t('resultHint')}
          </p>
        </div>
      ) : (
        <div className="auto-walk-empty card">
          {/* 隐藏挂载采集画板：仅供「开始走查」后台加载页面并采集截图，不做实时预览 */}
          <div
            aria-hidden
            style={{ position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none', zIndex: -1, overflow: 'hidden' }}
          >
            <DevBrowser
              ref={devBrowserRef}
              url={loadedUrl}
              viewport={previewVp}
              displayScale={1}
              hideBar
              hideScrollbar
              onFail={(m) => setMsg({ ok: false, text: m })}
              onLoadingChange={(loading) => setPageLoaded(!loading)}
            />
          </div>
          <EmptyIllustration />
          <h3>{t('emptyTitle')}</h3>
          <p>
            {t('emptyDesc1')}
            <br />
            {t('emptyDesc2')}
          </p>
          <button className="btn-primary aw-start-btn" onClick={startWalk} disabled={busy}>
            {running
              ? t('preparing')
              : aiTaskRunning
                ? aiTasks.find((task) => task.status === 'running' && task.pageId === page.id)?.message ?? t('aiRecognizing')
                : embedSending
                  ? t('capturing')
                  : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M8 5.5v13l11-6.5z" />
                </svg>
                {t('startWalk')}
              </>
            )}
          </button>
        </div>
      )}

      {pendingPairs && (
        <MatchConfirmDrawer
          items={pendingPairs}
          onConfirm={handleConfirmPairs}
          onClose={() => setPendingPairs(null)}
        />
      )}

      {layeredOpen && layeredResult && (
        <LayeredResultDrawer summary={layeredResult} onClose={() => setLayeredOpen(false)} />
      )}

      {exemptOpen && exemptDiffs && (
        <ExemptResultDrawer items={exemptDiffs} onClose={() => setExemptOpen(false)} />
      )}

      {statsOpen && (
        <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && setStatsOpen(false)}>
          <div className="modal">
            <h3>{t('statsTitle')}</h3>
            <SkillStatsPanel runs={walkRuns} issues={walkIssues} open onToggle={() => setStatsOpen(false)} />
            <div className="modal-actions">
              <span className="modal-spacer" />
              <button className="btn-secondary" onClick={() => setStatsOpen(false)}>
                {t('close')}
              </button>
            </div>
          </div>
        </div>
      )}
      {checkOpen && (
        <WalkCheckOptionsModal
          initial={checkOptions}
          skills={skills}
          skillIds={skillIds}
          onSkillChange={(ids) => {
            setSkillIds(ids)
            localStorage.setItem(SKILL_LAST_KEY, JSON.stringify(ids))
          }}
          onSaveSkillDefault={(ids) => {
            localStorage.setItem(SKILL_DEFAULT_KEY, JSON.stringify(ids))
            setMsg({ ok: true, text: t('skillDefaultSaved') })
          }}
          onSave={saveCheckOptions}
          onCancel={() => setCheckOpen(false)}
        />
      )}
      {tolOpen && (
        <WalkAdvancedModal
          initial={tolerance}
          debugEnabled={advancedDebug}
          layeredEnabled={layeredEnabled}
          structuredChecks={structuredChecks}
          canRun={!!(lastRunRef.current?.designRoot && lastRunRef.current?.domRoot) && !busy}
          busy={running}
          onSave={saveTolerance}
          onToggleDebug={toggleAdvancedDebug}
          onChangeLayeredEnabled={(v) => void toggleLayered(v)}
          onChangeStructuredChecks={changeStructuredChecks}
          onRun={() => {
            setTolOpen(false)
            void runStructured({ force: true })
          }}
          onCancel={() => setTolOpen(false)}
        />
      )}
      {creatingWalk && (
        <IssueEditorModal
          mode="create"
          issue={{
            id: '',
            pageId: page.id,
            targetImage: creatingWalk.targetImage,
            x: creatingWalk.rect.x,
            y: creatingWalk.rect.y,
            width: creatingWalk.rect.width,
            height: creatingWalk.rect.height,
            shape: creatingWalk.shape,
            description: '',
            severity: 'minor',
            category: 'spacing',
            status: 'pending',
            createdAt: 0
          }}
          onSave={createWalkIssue}
          onCancel={() => setCreatingWalk(null)}
        />
      )}
      {editingIssue && (
        <IssueEditorModal
          mode="edit"
          issue={editingIssue}
          onSave={saveWalkIssue}
          onDelete={deleteWalkIssue}
          onCancel={() => setEditingIssue(null)}
        />
      )}
    </div>
  )
}
