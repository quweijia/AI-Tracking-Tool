import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { StyleDiff, StyleNode, ToleranceConfig, WalkCheckOptions } from '../../../shared/types'
import {
  DEFAULT_TOLERANCE,
  DEFAULT_WALK_CHECK_OPTIONS,
  WALK_ANALYSES,
  WALK_DIMENSIONS,
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
import DevBrowser from './DevBrowser'
import IssueEditorModal from './IssueEditorModal'
import MatchConfirmDrawer, { type PendingPair } from './MatchConfirmDrawer'
import { WalkCheckOptionsModal, WalkAdvancedModal } from './WalkOptionsModal'
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

/** 低置信度阈值：低于该值的匹配对进入人工确认 */
const CONFIRM_THRESHOLD = 0.6

/** 走查视口高度（页面高度设置项已移除，采集时整页自动适配，预览用固定基准高度） */
const WALK_VP_HEIGHT = 900

/** 走查结果标注工具：browse 仅浏览（抓手平移），其余可直接在结果图上绘制 */
type WalkTool = 'browse' | 'point' | 'rect' | 'text'

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

/** 空态插画：浏览器窗口 + 虚线选框 + 光标 + AI 角标（与设计稿一致的浅蓝渐变风） */
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
        <text x="148" y="106" textAnchor="middle" fontSize="14" fontWeight="700" fill="#ffffff" fontFamily="-apple-system, sans-serif">
          AI
        </text>
      </g>
      <path d="M40 96c-10 8-14 16-10 22" stroke="#9dbdf5" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 5" fill="none" />
      <circle cx="28" cy="120" r="3" fill="#9dbdf5" />
    </svg>
  )
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
  }
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
  /** 自动走查设置（Figma 连接 / 开发 URL 输入区）是否展开，由工作台顶部折叠按钮控制 */
  controlsOpen?: boolean
}

/**
 * 自动走查面板：
 * Figma 连接 + 开发 URL 填写 →「开始走查」自动打开独立开发浏览器窗口（视口宽度自动匹配 Figma 画板），
 * 页面加载完成后在弹窗底部点击「生成问题标注」回传采集结果 →
 * Figma 拉设计稿 → AI 视觉走查 + Token 规范校验 + 元素清单校验（可选 a11y）落库；
 * 结构化尺寸 diff 拆为「高级调试」子功能（默认关闭，弹窗手动运行），结果在自动走查 tab 内独立展示（不替换手动上传的双图）。
 */
export default function AutoWalkPanel({ page, issues, onWalkDone, focusIssue, onExitFocus, controlsOpen = true }: AutoWalkPanelProps) {
  const { t } = useTranslation('autoWalkPanel')
  const stageRef = useRef<HTMLDivElement>(null)
  // 弹窗回传监听只注册一次（模块级），页面切换后回传仍可达
  ensureWalkListener()

  const [figUrlInput, setFigUrlInput] = useState(page.figmaUrl ?? '')
  const [devUrlInput, setDevUrlInput] = useState(page.devUrl ?? '')
  // 初始即取页面已保存的 devUrl：进入面板自动加载（内嵌模式），无需手动点击
  const [loadedUrl, setLoadedUrl] = useState(page.devUrl ?? '')
  const [running, setRunning] = useState(false)
  /** 已发起走查，等待弹窗「生成问题标注」回传 */
  const [waiting, setWaiting] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pendingPairs, setPendingPairs] = useState<PendingPair[] | null>(null)
  /** 弹窗模式（走查统一使用独立内置浏览器弹窗；「显示方式」设置已移除，初始即 true 避免首帧挂载内嵌浏览器） */
  const [popupMode, setPopupMode] = useState(true)
  /** 自定义检查项与容差（config 持久化） */
  const [checkOptions, setCheckOptions] = useState<WalkCheckOptions>(DEFAULT_WALK_CHECK_OPTIONS)
  const [tolerance, setTolerance] = useState<ToleranceConfig>(DEFAULT_TOLERANCE)
  const [checkOpen, setCheckOpen] = useState(false)
  const [tolOpen, setTolOpen] = useState(false)
  /** 高级调试子开关（结构化尺寸 diff，默认关闭，config 持久化） */
  const [advancedDebug, setAdvancedDebug] = useState(false)
  /** 自动走查独立双图（tab 内展示，与手动上传隔离） */
  const [walkDesignUrl, setWalkDesignUrl] = useState('')
  const [walkShotUrl, setWalkShotUrl] = useState('')
  /** 开始走查时匹配到的 Figma 画板宽度（内嵌浏览器预览视口也跟随） */
  const [figmaWidth, setFigmaWidth] = useState<number | null>(null)
  /** 开始走查时匹配到的 Figma 画板高度（弹窗视口与预览高度默认取画板原始尺寸） */
  const [figmaHeight, setFigmaHeight] = useState<number | null>(null)
  const [stageWidth, setStageWidth] = useState(900)
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
  /** 结果面板手动标注工具（两画布共用）与共享缩放（设计稿/开发截图同步缩放） */
  const [walkTool, setWalkTool] = useState<WalkTool>('browse')
  const [walkZoom, setWalkZoom] = useState(1)
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

  // 当页面编辑弹窗保存后，page.figmaUrl / page.devUrl 会变化，同步更新本地状态
  useEffect(() => {
    setFigUrlInput(page.figmaUrl ?? '')
    setDevUrlInput(page.devUrl ?? '')
    setLoadedUrl(page.devUrl ?? '')
  }, [page.figmaUrl, page.devUrl])

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
      // 「显示方式」已由「AI 任务默认浏览器」取代：走查统一使用独立内置浏览器弹窗
      setPopupMode(true)
      setCheckOptions(checkOptionsFromConfig(c))
      setTolerance(toleranceFromConfig(c))
      setAdvancedDebug(c.walkAdvancedDebug === true)
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

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setStageWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** 自动走查 imgSet='walk' 的问题（与手动标注隔离） */
  const walkIssues = useMemo(() => issues.filter((i) => i.imgSet === 'walk'), [issues])
  /** 按层与分类筛选后的结果（画布标注与计数联动） */
  const filteredWalkIssues = useMemo(
    () =>
      walkIssues.filter(
        (i) =>
          (layerFilter === 'all' || i.source === layerFilter) &&
          (catFilter === 'all' || i.category === catFilter)
      ),
    [walkIssues, layerFilter, catFilter]
  )
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

  /** 内嵌浏览器预览视口：宽高默认匹配 Figma 画板（未匹配前 1440 × 900 兜底） */
  const previewVp = useMemo(
    () => ({ width: figmaWidth ?? 1440, height: figmaHeight ?? WALK_VP_HEIGHT }),
    [figmaWidth, figmaHeight]
  )
  const displayScale = Math.min(1, (stageWidth - 2) / previewVp.width)

  /** 走查序号：仅对自动走查组（imgSet='walk'）按创建时间编号，与问题清单（自动走查模式只列走查问题）口径一致 */
  const issueNos = useMemo(() => {
    const m = new Map<string, number>()
    ;[...walkIssues]
      .sort((a, b) => a.createdAt - b.createdAt)
      .forEach((i, idx) => m.set(i.id, idx + 1))
    return m
  }, [walkIssues])

  /** 批量落库（imgSet='walk'），并按来源去重：程序校验结果（Token/元素清单/a11y）优先，AI 视觉仅保留未被覆盖的 */
  const saveIssues = async (
    diffs: StyleDiff[],
    /** AI 视觉候选：已经 aiAnnotationsToIssues 转换为 Issue 行（测量换算 px、吸色已取样） */
    visualCandidates: Issue[],
    /** 额外去重基准：本次走查已先行落库的程序校验行（先于视觉轨落库） */
    specBase: Issue[] = []
  ): Promise<{ structured: number; visual: number }> => {
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
    return { structured: structuredRows.length, visual: rows.length - structuredRows.length }
  }

  // ===== 开始走查：校验 → Figma 画板宽度 → 打开弹窗 + 下发视口 → 等待弹窗回传 =====
  const startWalk = async () => {
    if (running || waiting) return
    const devUrl = resolveDevUrl(devUrlInput)
    if (!devUrl) {
      setMsg({ ok: false, text: t('errDevUrl') })
      return
    }
    const figUrl = figUrlInput.trim()
    if (!figUrl) {
      setMsg({ ok: false, text: t('errFigmaUrl') })
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
      // 1. 轻量读取画板宽度（视口宽度自动匹配）
      const size = await window.electronAPI.figmaNodeSize({ pat, figmaUrl: figUrl })
      if (!size.ok || !size.width) {
        setMsg({ ok: false, text: size.message })
        return
      }
      setFigmaWidth(size.width)
      if (size.height) setFigmaHeight(size.height)
      // 弹窗视口默认取 Figma 画板原始宽高（高度超出上限时收敛，整页采集时弹窗内会自动拉高）
      const vpHeight = Math.min(21600, Math.max(240, size.height ?? WALK_VP_HEIGHT))
      const vp = { width: size.width, height: vpHeight, autoWidth: true }
      // 2. 保存连接与 URL，打开开发浏览器弹窗并下发视口
      await db.pages.update(page.id, { figmaUrl: figUrl, devUrl, updatedAt: Date.now() })
      setLoadedUrl(devUrl)
      const opened = await window.electronAPI.openDevBrowser(devUrl)
      if (!opened.ok) {
        setMsg({ ok: false, text: opened.message })
        return
      }
      window.electronAPI.setDevViewport(vp)
      setWaiting(true)
      setMsg({
        ok: true,
        text: t('walkOpened', { w: vp.width, h: vp.height, name: size.nodeName ?? 'Frame' })
      })
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

  // ===== 弹窗回传采集结果 → 保存双图 → 程序轨校验（Token / 元素清单 / 可选 a11y）→ AI 视觉走查 =====
  const handleCaptured = async (cap: WalkCapture) => {
    setWaiting(false)
    setRunning(true)
    setMsg({ ok: true, text: t('capturedReading') })
    /** 后台任务 id（注册前出错时为 null，catch 里按需上报失败） */
    let taskId: string | null = null
    try {
      const cfg = await window.electronAPI.getConfig()
      const pat = patFromConfig(cfg)
      if (!pat) throw new Error(t('errNoPat'))
      const figUrl = figUrlInput.trim() || page.figmaUrl || ''
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
        }
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
      const { visual } = await saveIssues([], visualRows, [...specRows, ...elementRows, ...a11yRows])
      const total = res.issues?.length ?? 0
      let doneText = total
        ? t('visualDone', { count: visual, dup: total - visual })
        : t('visualDoneNone')
      if (specRows.length) doneText += ` ${t('specFound', { count: specRows.length })}`
      if (elementRows.length) doneText += ` ${t('elementFound', { count: elementRows.length })}`
      if (a11yRows.length) doneText += ` ${t('a11yFound', { count: a11yRows.length })}`
      useAiTasksStore.getState().finish(taskId, true, doneText)
      setMsg({ ok: true, text: doneText })
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
    if (!opts?.force && (running || waiting)) return
    const run = lastRunRef.current
    if (!run || !run.designRoot || !run.domRoot) {
      setMsg({ ok: false, text: t('structuredStale') })
      return
    }
    setRunning(true)
    setMsg({ ok: true, text: t('matching') })
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
        t('unmatched', { d: cmp.unmatchedDesignCount, e: cmp.unmatchedDomCount })
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

  /** 内嵌模式：回车加载下方预览浏览器 */
  const loadEmbedded = (): void => {
    const url = resolveDevUrl(devUrlInput)
    if (url) {
      setLoadedUrl(url)
      void db.pages.update(page.id, { devUrl: url })
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
    await db.issues.add({
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
    })
    void touchPage(page.id)
    setCreatingWalk(null)
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
  const busy = running || waiting || aiTaskRunning

  /** 分类标签（cat_* key，连字符转下划线） */
  const enumKey = (v: string) => v.replace(/-/g, '_')
  const catLabel = (c: Category) => t(`cat_${enumKey(c)}`)

  /** 结果面板标注工具定义（随界面语言生成） */
  const WALK_TOOLS: { value: WalkTool; title: string }[] = [
    { value: 'browse', title: t('tool_browse') },
    { value: 'point', title: t('tool_point') },
    { value: 'rect', title: t('tool_rect') },
    { value: 'text', title: t('tool_text') }
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
      {(controlsOpen || msg || waiting || aiTaskRunning) && (
      <div className="auto-walk-controls card">
        {controlsOpen && (
          <>
        <div className="auto-walk-row">
          <label className="field-label inline">{t('figmaConnLabel')}</label>
          <input
            className="input auto-walk-url"
            placeholder={t('figmaUrlPlaceholder')}
            value={figUrlInput}
            onChange={(e) => setFigUrlInput(e.target.value)}
          />
        </div>
        <div className="auto-walk-row">
          <label className="field-label inline">{t('devUrlLabel')}</label>
          <input
            className="input auto-walk-url"
            placeholder={t('devUrlPlaceholder')}
            value={devUrlInput}
            onChange={(e) => setDevUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadEmbedded()}
          />
        </div>
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
        {(msg || waiting || aiTaskRunning) && (
          <p className={`auto-walk-msg ${msg ? (msg.ok ? 'ok' : 'err') : 'ok'}`}>
            {msg
              ? msg.text
              : waiting
                ? t('waitingCapture')
                : t('aiTaskRunning')}
            {waiting && (
              <button
                type="button"
                className="auto-walk-cancel"
                onClick={() => {
                  setWaiting(false)
                  setMsg(null)
                }}
              >
                {t('cancelWait')}
              </button>
            )}
            {/* 完成类通知条支持手动关闭（AI 视觉走查完成 / 结构化分析完成等） */}
            {msg && !waiting && (
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
              {walkCategories.length > 0 && <span className="aw-filter-sep" />}
              {walkCategories.length > 0 && (
                <div className="aw-chip-group">
                  <button
                    type="button"
                    className={`aw-chip${catFilter === 'all' ? ' active' : ''}`}
                    onClick={() => setCatFilter('all')}
                  >
                    {t('catAll')}
                  </button>
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
              )}
            </div>
          )}
          {/* 聚焦查看提示条：双图只显示当前问题点位，可退出 */}
          {focusIssue && (
            <div className="aw-focus-bar">
              <span>
                {t('focusing', {
                  desc: focusIssue.description.length > 32 ? `${focusIssue.description.slice(0, 32)}…` : focusIssue.description
                })}
              </span>
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
                      targetImage="design"
                      noOf={(issue) => issueNos.get(issue.id) ?? 0}
                      focusId={focusIssue?.id ?? null}
                      onCreate={(rect, target) =>
                        setCreatingWalk({ rect, targetImage: target, shape: walkTool as AnnotationShape })
                      }
                      onMove={(issue, rect) => {
                        void db.issues.update(issue.id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
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
                      targetImage="screenshot"
                      noOf={(issue) => issueNos.get(issue.id) ?? 0}
                      focusId={focusIssue?.id ?? null}
                      onCreate={(rect, target) =>
                        setCreatingWalk({ rect, targetImage: target, shape: walkTool as AnnotationShape })
                      }
                      onMove={(issue, rect) => {
                        void db.issues.update(issue.id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
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
      ) : popupMode ? (
        <div className="auto-walk-empty card">
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
              : waiting
                ? t('waitingCaptureBtn')
                : aiTaskRunning
                  ? aiTasks.find((task) => task.status === 'running' && task.pageId === page.id)?.message ?? t('aiRecognizing')
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
      ) : (
        <>
          <div ref={stageRef} className="auto-walk-stage">
            <DevBrowser
              url={loadedUrl}
              viewport={previewVp}
              displayScale={displayScale}
              onFail={(m) => setMsg({ ok: false, text: m })}
            />
          </div>
          <button className="btn-primary aw-start-btn aw-start-inline" onClick={startWalk} disabled={busy}>
            {running
              ? t('preparing')
              : waiting
                ? t('waitingCaptureBtn')
                : aiTaskRunning
                  ? aiTasks.find((task) => task.status === 'running' && task.pageId === page.id)?.message ?? t('aiRecognizing')
                  : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M8 5.5v13l11-6.5z" />
                </svg>
                {t('startWalk')}
              </>
            )}
          </button>
        </>
      )}

      {pendingPairs && (
        <MatchConfirmDrawer
          items={pendingPairs}
          onConfirm={handleConfirmPairs}
          onClose={() => setPendingPairs(null)}
        />
      )}

      {checkOpen && (
        <WalkCheckOptionsModal initial={checkOptions} onSave={saveCheckOptions} onCancel={() => setCheckOpen(false)} />
      )}
      {tolOpen && (
        <WalkAdvancedModal
          initial={tolerance}
          debugEnabled={advancedDebug}
          canRun={!!(lastRunRef.current?.designRoot && lastRunRef.current?.domRoot) && !busy}
          busy={running || waiting}
          onSave={saveTolerance}
          onToggleDebug={toggleAdvancedDebug}
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
