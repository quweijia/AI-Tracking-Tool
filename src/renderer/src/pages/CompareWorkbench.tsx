import { useLiveQuery } from 'dexie-react-hooks'
import { useParams, Link, useSearchParams } from 'react-router-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import { db, genId, recordVisit, touchPage, Issue, Category, Severity, TargetImage, AnnotationShape, PLATFORM_LABELS } from '../db'
import AnnotationCanvas, { NormalizedRect } from '../components/AnnotationCanvas'
import EditPageModal from '../components/EditPageModal'
import IssueEditorModal from '../components/IssueEditorModal'
import IssueDrawer from '../components/IssueDrawer'
import ReverifyModal from '../components/ReverifyModal'
import { PlatformBadge } from '../components/PlatformBadge'
import USelect from '../components/USelect'

type ViewMode = 'side-by-side' | 'onion' | 'slider' | 'blink'

/** 标注工具取值：hand 为抓手（平移浏览），不产生标注 */
type ToolValue = AnnotationShape | 'hand'

const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: 'side-by-side', label: '并排' },
  { value: 'onion', label: '叠加（洋葱皮）' },
  { value: 'slider', label: '滑块' },
  { value: 'blink', label: '差异闪烁' }
]

/** SkillHub 技能（config.skills 存储结构） */
interface SkillItemLite {
  id: string
  name: string
  desc?: string
  url?: string
}

/** 工具图标（线性风格，随文字颜色继承） */
function ToolIcon({ name }: { name: ToolValue }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  switch (name) {
    case 'hand':
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
    case 'arrow':
      return (
        <svg {...common}>
          <path d="M5 19 19 5" />
          <path d="M13 5h6v6" />
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
      return (
        <svg {...common}>
          <path d="M3 9.5 9.5 3l11 11L14 20.5z" />
          <path d="M7.2 8.3l1.7 1.7M10 5.5l1.7 1.7M11.5 12.6l1.7 1.7M14.3 9.8l1.7 1.7" />
        </svg>
      )
    case 'picker':
      return (
        <svg {...common}>
          <path d="m2 22 1-1h3l9-9" />
          <path d="M3 21v-3l9-9" />
          <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" />
        </svg>
      )
  }
}

const TOOLS: { value: ToolValue; label: string; hint: string }[] = [
  { value: 'hand', label: '抓手', hint: '抓手：按住拖拽平移画布，配合缩放查看细节' },
  { value: 'point', label: '点位标注', hint: '点击图片放置点位标记' },
  { value: 'arrow', label: '箭头', hint: '拖拽绘制箭头指向' },
  { value: 'rect', label: '框选', hint: '拖拽框选问题区域' },
  { value: 'text', label: '文字标注', hint: '点击图片添加文字标注' },
  { value: 'measure', label: '测量', hint: '测量距离：点击第一个点拖到第二个点松开完成测量，尺寸数值可在详情中修改' },
  { value: 'picker', label: '吸色', hint: '吸色取样：点击图上位置，同时吸取设计稿与开发截图同一坐标的颜色，并在双图上分别标注对应色值' }
]

/** 顶部按钮 / 标题编辑 icon（线性风格，随文字颜色继承） */
function SparklesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3.5l1.9 5 5 1.9-5 1.9-1.9 5-1.9-5-5-1.9 5-1.9z" />
      <path d="M18.8 15.2l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z" />
    </svg>
  )
}

function ListIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </svg>
  )
}

function ExportIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v11" />
      <path d="m7.5 9.5 4.5 4.5 4.5-4.5" />
      <path d="M4 20h16" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  )
}

/** 该标注是否带坐标信息、需要渲染到图上（列表手加的问题无坐标不渲染） */
const renderOnCanvas = (i: Issue) =>
  i.shape === 'point' ||
  i.shape === 'text' ||
  i.shape === 'measure' ||
  i.shape === 'picker' ||
  i.width !== 0 ||
  i.height !== 0

/** rgb → #RRGGBB */
const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase()

export default function CompareWorkbench() {
  const { projectId, pageId } = useParams<{ projectId: string; pageId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const page = useLiveQuery(() => db.pages.get(pageId!), [pageId])
  const project = useLiveQuery(() => db.projects.get(projectId!), [projectId])
  const issues = useLiveQuery(() => db.issues.where('pageId').equals(pageId!).toArray(), [pageId])

  const [designUrl, setDesignUrl] = useState('')
  const [shotUrl, setShotUrl] = useState('')
  const [mode, setMode] = useState<ViewMode>('side-by-side')
  const [zoom, setZoom] = useState(1)
  const [syncScroll, setSyncScroll] = useState(true)
  const [sliderPos, setSliderPos] = useState(50)
  /** 滑块模式：是否显示分界线（隐藏后画布分界线与调整滑杆都收起） */
  const [showDivider, setShowDivider] = useState(true)
  /** 当前标注工具，默认抓手（浏览/平移），选择标注工具后可直接绘制 */
  const [tool, setTool] = useState<ToolValue>('hand')
  /** 问题清单抽屉 */
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 问题清单点击卡片 → 画布上对应标注闪烁定位（约 2.2s 后自动清除）
  const [flashId, setFlashId] = useState<string | null>(null)
  const flashTimer = useRef<number | null>(null)
  /** 编辑页面信息弹窗 */
  const [editPageOpen, setEditPageOpen] = useState(false)
  /** 编辑中的已有问题 / 新建草稿（null = 弹窗关闭） */
  const [editingIssue, setEditingIssue] = useState<Issue | null>(null)

  /** 在标注图上高亮闪烁指定标注（重复点击重置计时） */
  const handleFlash = (issue: Issue) => {
    setFlashId(issue.id)
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlashId(null), 2300)
  }
  const [creating, setCreating] = useState<{
    rect: NormalizedRect
    targetImage: 'design' | 'screenshot'
    shape: AnnotationShape
  } | null>(null)
  /** 复验弹窗 */
  const [reverifyIssue, setReverifyIssue] = useState<Issue | null>(null)
  const [oldScreenshotUrl, setOldScreenshotUrl] = useState<string | null>(null)

  // ===== AI 识别 =====
  /** 默认 AI 模型（未配置为 null） */
  const [aiModel, setAiModel] = useState<{ id: string; name: string } | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiMsg, setAiMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [skills, setSkills] = useState<SkillItemLite[]>([])
  const [skillId, setSkillId] = useState('')

  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      const models = (cfg.aiModels as { id: string; name: string }[] | undefined) ?? []
      const defId = (cfg.aiDefaultModelId as string | undefined) ?? models[0]?.id ?? ''
      setAiModel(models.find((m) => m.id === defId) ?? models[0] ?? null)
      // SkillHub 技能列表：AI 识别时可选一个技能作为走查指引
      setSkills((cfg.skills as SkillItemLite[] | undefined) ?? [])
    })
  }, [])

  // 记录一次页面访问（30 分钟去重），供「最近访问」页统计
  useEffect(() => {
    if (pageId && projectId) recordVisit(pageId, projectId)
  }, [pageId, projectId])

  const designRef = useRef<HTMLDivElement>(null)
  const shotRef = useRef<HTMLDivElement>(null)
  const overlayCanvasRef = useRef<HTMLDivElement>(null)
  /** 叠加模式滚动容器（抓手/空格平移用） */
  const overlayPanelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (page?.designImagePath) {
      window.electronAPI.readImage(page.designImagePath).then((url) => setDesignUrl(url ?? ''))
    }
    if (page?.screenshotPath) {
      window.electronAPI.readImage(page.screenshotPath).then((url) => setShotUrl(url ?? ''))
    }
  }, [page])

  // ===== 重新上传设计稿 / 开发截图（替换文件并清理旧图） =====
  const handleReupload = async (target: 'design' | 'screenshot') => {
    if (!pageId) return
    const result = await window.electronAPI.selectImage()
    if (!result) return
    const oldPath = target === 'design' ? page?.designImagePath : page?.screenshotPath
    if (oldPath && oldPath !== result.relativePath) {
      await window.electronAPI.deleteImage(oldPath).catch(() => undefined)
    }
    await db.pages.update(
      pageId,
      target === 'design'
        ? { designImagePath: result.relativePath, updatedAt: Date.now() }
        : { screenshotPath: result.relativePath, updatedAt: Date.now() }
    )
  }

  // 从问题清单「定位」跳转：?issue=<id>，打开对应编辑弹窗
  const focusIssueId = searchParams.get('issue')
  useEffect(() => {
    if (!focusIssueId || !issues) return
    const target = issues.find((i) => i.id === focusIssueId)
    if (target) {
      setEditingIssue(target)
      setSearchParams({}, { replace: true })
    }
  }, [focusIssueId, issues, setSearchParams])

  // ===== 空格键按住 → 画布平移模式（仅并排、非标注时）=====
  const [spaceHeld, setSpaceHeld] = useState(false)
  useEffect(() => {
    const isTypingTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null
      return !!el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
    }
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      if (isTypingTarget(e.target)) return
      e.preventDefault()
      setSpaceHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      setSpaceHeld(false)
    }
  }, [])

  const handleScroll = (source: 'design' | 'shot') => {
    if (!syncScroll || mode !== 'side-by-side') return
    const from = source === 'design' ? designRef.current : shotRef.current
    const to = source === 'design' ? shotRef.current : designRef.current
    if (from && to) {
      to.scrollTop = from.scrollTop
      to.scrollLeft = from.scrollLeft
    }
  }

  // 按住空格或使用抓手工具时拖拽：把鼠标位移转成 scroll 位移（并排双图 / 叠加面板通用）
  const handlePanStart = (e: React.MouseEvent, source: 'design' | 'shot' | 'overlay') => {
    if (!spaceHeld && tool !== 'hand') return
    const el =
      source === 'design' ? designRef.current : source === 'shot' ? shotRef.current : overlayPanelRef.current
    if (!el) return
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop }
    const move = (ev: MouseEvent) => {
      el.scrollLeft = start.scrollLeft - (ev.clientX - start.x)
      el.scrollTop = start.scrollTop - (ev.clientY - start.y)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // ===== 滑块模式：直接拖动分割线 =====
  const startSliderDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    const canvas = overlayCanvasRef.current
    if (!canvas) return
    const move = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const pct = ((ev.clientX - rect.left) / rect.width) * 100
      setSliderPos(Math.min(100, Math.max(0, pct)))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // 全局统一编号：跨双图按创建时间排序，与问题清单、导出报告口径一致
  const issueNos = useMemo(() => {
    const m = new Map<string, number>()
    ;[...(issues ?? [])]
      .sort((a, b) => a.createdAt - b.createdAt)
      .forEach((i, idx) => m.set(i.id, idx + 1))
    return m
  }, [issues])

  const designIssues = (issues ?? []).filter((i) => i.targetImage === 'design' && renderOnCanvas(i))
  const shotIssues = (issues ?? []).filter((i) => i.targetImage === 'screenshot' && renderOnCanvas(i))

  const handleCreate = async (fields: {
    description: string
    severity: Issue['severity']
    category: Issue['category']
    status: Issue['status']
    targetImage: Issue['targetImage']
    color?: string
  }) => {
    if (!creating || !pageId) return
    const issue: Issue = {
      id: genId(),
      pageId,
      targetImage: creating.targetImage,
      x: creating.rect.x,
      y: creating.rect.y,
      width: creating.rect.width,
      height: creating.rect.height,
      shape: creating.shape,
      description: fields.description,
      severity: fields.severity,
      category: fields.category,
      status: 'pending',
      color: fields.color,
      createdAt: Date.now()
    }
    await db.issues.add(issue)
    void touchPage(pageId)
    setCreating(null)
  }

  const handleUpdate = async (fields: {
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
      // AI 候选经人工编辑保存后视为采纳
      ...(editingIssue.isAISuggested && !editingIssue.aiConfirmed ? { aiConfirmed: true } : {})
    })
    void touchPage(editingIssue.pageId)
    setEditingIssue(null)
  }

  // ===== 快速创建（不弹窗）：测量距离 / 吸色取样 =====
  // 吸色离屏画布缓存：url → 已绘制的离屏 canvas（点击时同步取双图像素）
  const sampleCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map())
  useEffect(() => {
    ;[designUrl, shotUrl].forEach((url) => {
      if (!url || sampleCacheRef.current.has(url)) return
      const img = new Image()
      img.src = url
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        canvas.getContext('2d', { willReadFrequently: true })?.drawImage(img, 0, 0)
        sampleCacheRef.current.set(url, canvas)
      }
    })
  }, [designUrl, shotUrl])

  /** 在指定图片上取归一化坐标处的像素色（hex），画布未就绪返回 null */
  const sampleColorAt = (url: string, nx: number, ny: number): string | null => {
    const canvas = sampleCacheRef.current.get(url)
    const ctx = canvas?.getContext('2d', { willReadFrequently: true })
    if (!canvas || !ctx || !canvas.width || !canvas.height) return null
    const px = Math.min(canvas.width - 1, Math.max(0, Math.round(nx * canvas.width)))
    const py = Math.min(canvas.height - 1, Math.max(0, Math.round(ny * canvas.height)))
    try {
      const d = ctx.getImageData(px, py, 1, 1).data
      return rgbToHex(d[0], d[1], d[2])
    } catch {
      return null
    }
  }

  const handleQuickCreate = async (
    rect: { x: number; y: number; width: number; height: number },
    target: 'design' | 'screenshot',
    data: { measurePx?: number; colorHex?: string }
  ) => {
    if (!pageId) return
    let issue: Issue
    if (data.measurePx !== undefined) {
      issue = {
        id: genId(),
        pageId,
        targetImage: target,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        shape: 'measure',
        description: `尺寸标注 ${Math.round(data.measurePx)}px`,
        severity: 'suggestion',
        category: 'spacing',
        status: 'pending',
        measureValue: `${Math.round(data.measurePx)}px`,
        createdAt: Date.now()
      }
    } else {
      // 吸色：一次点击同时取设计稿与开发截图同一坐标的颜色，双图各生成一条吸色标注
      const ownHex = data.colorHex ?? sampleColorAt(target === 'design' ? designUrl : shotUrl, rect.x, rect.y)
      const otherHex = sampleColorAt(target === 'design' ? shotUrl : designUrl, rect.x, rect.y)
      const now = Date.now()
      const rows: Issue[] = []
      if (ownHex) {
        rows.push({
          id: genId(),
          pageId,
          targetImage: target,
          x: rect.x,
          y: rect.y,
          width: 0,
          height: 0,
          shape: 'picker',
          description: ownHex,
          severity: 'suggestion',
          category: 'color',
          status: 'pending',
          ...(target === 'design' ? { sampleA: ownHex } : { sampleB: ownHex }),
          createdAt: now
        })
      }
      if (otherHex) {
        const otherTarget: TargetImage = target === 'design' ? 'screenshot' : 'design'
        rows.push({
          id: genId(),
          pageId,
          targetImage: otherTarget,
          x: rect.x,
          y: rect.y,
          width: 0,
          height: 0,
          shape: 'picker',
          description: otherHex,
          severity: 'suggestion',
          category: 'color',
          status: 'pending',
          ...(otherTarget === 'design' ? { sampleA: otherHex } : { sampleB: otherHex }),
          createdAt: now + 1
        })
      }
      if (rows.length) {
        await db.issues.bulkAdd(rows)
        void touchPage(pageId)
      }
      return
    }
    await db.issues.add(issue)
    void touchPage(pageId)
  }

  /** 拖拽移动标注后提交新位置 */
  const handleMove = async (issue: Issue, rect: NormalizedRect) => {
    await db.issues.update(issue.id, {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    })
    void touchPage(issue.pageId)
  }

  const handleDelete = async () => {
    if (!editingIssue) return
    await db.issues.delete(editingIssue.id)
    void touchPage(editingIssue.pageId)
    setEditingIssue(null)
  }

  // 抽屉：快速添加问题
  const handleQuickAdd = (fields: { description: string; severity: Severity; category: Category; targetImage: TargetImage }) => {
    if (!pageId) return
    void db.issues.add({
      id: genId(),
      pageId,
      targetImage: fields.targetImage,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      description: fields.description,
      severity: fields.severity,
      category: fields.category,
      status: 'pending',
      createdAt: Date.now()
    })
    void touchPage(pageId)
  }

  // 抽屉：复验
  const openReverify = async (issue: Issue) => {
    setReverifyIssue(issue)
    setOldScreenshotUrl(null)
    const p = await db.pages.get(pageId!)
    if (p?.screenshotPath) {
      const url = await window.electronAPI.readImage(p.screenshotPath)
      setOldScreenshotUrl(url)
    }
  }

  // ===== AI 自动识别走查问题 =====
  const runAIAnnotate = async () => {
    if (!pageId || !designUrl || !shotUrl || !aiModel || aiLoading) return
    const candidates = (issues ?? []).filter((i) => i.isAISuggested && !i.aiConfirmed)
    if (
      candidates.length > 0 &&
      !window.confirm(`将覆盖当前 ${candidates.length} 条未审核的 AI 候选，重新识别吗？`)
    ) {
      return
    }
    setAiLoading(true)
    setAiMsg(null)
    try {
      // 选中的技能说明作为走查指引注入请求
      const skill = skills.find((s) => s.id === skillId)
      const skillGuide = skill
        ? `${skill.name}${skill.desc ? `：${skill.desc}` : ''}${skill.url ? `（参考：${skill.url}）` : ''}`
        : ''
      const res = await window.electronAPI.aiAnnotate({
        modelId: aiModel.id,
        pageName: page?.pageName ?? '',
        platformLabel: page ? PLATFORM_LABELS[page.platform] : '',
        designDataUrl: designUrl,
        shotDataUrl: shotUrl,
        skillGuides: skillGuide ? [skillGuide] : undefined
      })
      if (!res.ok) {
        setAiMsg({ ok: false, text: res.message })
        return
      }
      // 覆盖旧候选（仅删除未采纳的）
      if (candidates.length) await db.issues.bulkDelete(candidates.map((i) => i.id))
      const now = Date.now()
      const rows: Issue[] = (res.issues ?? []).map((a, idx) => ({
        id: genId(),
        pageId,
        targetImage: a.targetImage,
        x: a.x,
        y: a.y,
        width: a.width,
        height: a.height,
        shape: a.shape,
        description: a.description,
        severity: a.severity,
        category: a.category,
        status: 'pending',
        isAISuggested: true,
        aiConfirmed: false,
        aiSuggestion: a.suggestion,
        createdAt: now + idx
      }))
      if (rows.length) await db.issues.bulkAdd(rows)
      if (rows.length) void touchPage(pageId)
      setAiMsg({
        ok: true,
        text: rows.length
          ? `AI 识别完成：${rows.length} 条候选，请在问题清单中逐条审核`
          : 'AI 识别完成：未发现明显差异'
      })
      if (rows.length) setDrawerOpen(true)
    } catch (err) {
      setAiMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setAiLoading(false)
    }
  }

  const isOverlay = mode !== 'side-by-side'

  /** 抓手工具下仅平移浏览，不进入标注绘制态 */
  const activeTool: AnnotationShape | null = tool === 'hand' ? null : tool
  const panMode = tool === 'hand'

  return (
    <div className="page compare-page">
      <div className="compare-topbar">
        <Link to={`/project/${projectId}`} className="breadcrumb">
          <span className="crumb-parent">{project?.name ?? '项目'}</span>
          <span className="crumb-sep">/</span>
          <span className="crumb-current">{page?.pageName ?? '...'}</span>
        </Link>
        <div className="topbar-actions">
          {skills.length > 0 && (
            <div className="topbar-skill-select" title="选择一个 SkillHub 技能，AI 识别时将按该技能要点走查">
              <USelect
                value={skillId}
                onChange={setSkillId}
                options={[
                  { value: '', label: '不使用技能' },
                  ...skills.map((s) => ({ value: s.id, label: s.name }))
                ]}
              />
            </div>
          )}
          <button
            className={`btn-secondary btn-ai${aiLoading ? ' loading' : ''}`}
            onClick={runAIAnnotate}
            disabled={aiLoading || !designUrl || !shotUrl || !aiModel}
            title={
              !aiModel
                ? '请先到「AI 模型管理」配置默认模型'
                : !designUrl || !shotUrl
                  ? '需要设计稿与开发截图'
                  : 'AI 对比双图，生成候选标注'
            }
          >
            <span className="ai-spark">
              <SparklesIcon />
            </span>
            {aiLoading ? 'AI 识别中...' : 'AI 识别'}
          </button>
          <button
            className={`btn-secondary${drawerOpen ? ' active' : ''}`}
            onClick={() => setDrawerOpen(!drawerOpen)}
          >
            <ListIcon />
            问题清单
          </button>
          <Link to={`/project/${projectId}/page/${pageId}/export`} className="btn-primary">
            <ExportIcon />
            导出报告
          </Link>
        </div>
      </div>

      {aiMsg && (
        <p className={`ai-msg ${aiMsg.ok ? 'ok' : 'err'}`}>
          {aiMsg.ok ? '✓ ' : '✕ '}
          {aiMsg.text}
        </p>
      )}

      <div className="workbench-header">
        <div className="workbench-head-main">
          <div className="workbench-title-row">
            <h2>{page?.pageName ?? '...'}</h2>
            <button
              className="title-edit-btn"
              onClick={() => setEditPageOpen(true)}
              disabled={!page}
              title="编辑页面信息"
            >
              <PencilIcon />
            </button>
          </div>
          <div className="workbench-meta">
            {page && <PlatformBadge platform={page.platform} />}
            {page?.figmaUrl && (
              <a className="figma-link" href={page.figmaUrl} target="_blank" rel="noreferrer" title={page.figmaUrl}>
                <LinkIcon />
                <span>Figma 设计稿</span>
              </a>
            )}
          </div>
        </div>
        <div className="workbench-tools">
          {!isOverlay && (
            <label className="inline-label">
              <input
                type="checkbox"
                checked={syncScroll}
                onChange={(e) => setSyncScroll(e.target.checked)}
              />
              同步滚动
            </label>
          )}
          {mode === 'slider' && (
            <>
              <label className="inline-label">
                分割线
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={sliderPos}
                  onChange={(e) => setSliderPos(Number(e.target.value))}
                />
              </label>
              <label className="inline-label">
                <input
                  type="checkbox"
                  checked={showDivider}
                  onChange={(e) => setShowDivider(e.target.checked)}
                />
                显示分界线
              </label>
            </>
          )}
          <label className="inline-label zoom-label">
            缩放
            <input
              type="range"
              min={0.25}
              max={3}
              step={0.05}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
            {Math.round(zoom * 100)}%
          </label>
          <div className="segmented">
            {VIEW_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                className={`segment-item ${mode === m.value ? 'active' : ''}`}
                onClick={() => setMode(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="compare-body">
        {isOverlay ? (
          <div
            ref={overlayPanelRef}
            className={`card overlay-panel ${panMode ? 'hand-pan' : ''} ${spaceHeld ? 'space-pan' : ''}`}
            onMouseDown={(e) => handlePanStart(e, 'overlay')}
          >
            <div className="panel-title">
              {mode === 'onion' && '叠加对比：开发截图 50% 透明叠在设计稿上'}
              {mode === 'slider' && '滑块对比：拖动分割线查看左右两侧'}
              {mode === 'blink' && '差异闪烁：开发截图与设计稿交替闪烁'}
            </div>
            <div ref={overlayCanvasRef} className="overlay-canvas" style={{ width: `${zoom * 100}%` }}>
              {designUrl && <img src={designUrl} alt="设计稿" className="overlay-base" />}
              {shotUrl && (
                <img
                  src={shotUrl}
                  alt="开发截图"
                  className={
                    mode === 'onion'
                      ? 'overlay-top onion'
                      : mode === 'blink'
                        ? 'overlay-top blink-anim'
                        : 'overlay-top'
                  }
                  style={mode === 'slider' ? { clipPath: `inset(0 0 0 ${sliderPos}%)` } : undefined}
                />
              )}
              {/* 叠加模式同样显示开发截图的标注，并可直接标注（坐标对齐开发截图图层） */}
              {shotUrl && (
                <AnnotationCanvas
                  overlay
                  dataUrl={shotUrl}
                  alt="开发截图标注层"
                  issues={shotIssues}
                  tool={activeTool}
                  panMode={panMode}
                  spacePan={spaceHeld}
                  targetImage="screenshot"
                  noOf={(issue) => issueNos.get(issue.id) ?? 0}
                  onCreate={(rect, target) =>
                    setCreating({ rect, targetImage: target, shape: activeTool! })
                  }
                  onQuickCreate={handleQuickCreate}
                  onMove={handleMove}
                  onEdit={(issue) => setEditingIssue(issue)}
                  flashId={flashId}
                />
              )}
              {mode === 'slider' && showDivider && (
                <div
                  className="slider-divider"
                  style={{ left: `${sliderPos}%` }}
                  onMouseDown={startSliderDrag}
                >
                  <div className="slider-handle" />
                </div>
              )}
            </div>
            <p className="annotation-hint">叠加 / 滑块 / 闪烁模式下标注显示在开发截图图层上，可直接标注</p>
          </div>
        ) : (
          <div className="compare-container">
            <div className="compare-panel card">
              <div className="panel-title">
                设计稿
                <span className="panel-count">{designIssues.length} 个标注</span>
                <button
                  className="panel-upload"
                  onClick={() => handleReupload('design')}
                  title="重新选择设计稿图片"
                >
                  重新上传
                </button>
              </div>
              <div
                ref={designRef}
                className={`canvas-area ${panMode ? 'hand-pan' : ''} ${spaceHeld ? 'space-pan' : ''}`}
                onScroll={() => handleScroll('design')}
                onMouseDown={(e) => handlePanStart(e, 'design')}
              >
                {designUrl && (
                  <div style={{ width: `${zoom * 100}%` }}>
                    <AnnotationCanvas
                      dataUrl={designUrl}
                      alt="设计稿"
                      issues={designIssues}
                      tool={activeTool}
                      panMode={panMode}
                  spacePan={spaceHeld}
                      targetImage="design"
                      noOf={(issue) => issueNos.get(issue.id) ?? 0}
                      onCreate={(rect, target) =>
                        setCreating({ rect, targetImage: target, shape: activeTool! })
                      }
                      onQuickCreate={handleQuickCreate}
                      onMove={handleMove}
                      onEdit={(issue) => setEditingIssue(issue)}
                      flashId={flashId}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="compare-panel card">
              <div className="panel-title">
                开发截图
                <span className="panel-count">{shotIssues.length} 个标注</span>
                <button
                  className="panel-upload"
                  onClick={() => handleReupload('screenshot')}
                  title="重新选择开发截图"
                >
                  重新上传
                </button>
              </div>
              <div
                ref={shotRef}
                className={`canvas-area ${panMode ? 'hand-pan' : ''} ${spaceHeld ? 'space-pan' : ''}`}
                onScroll={() => handleScroll('shot')}
                onMouseDown={(e) => handlePanStart(e, 'shot')}
              >
                {shotUrl && (
                  <div style={{ width: `${zoom * 100}%` }}>
                    <AnnotationCanvas
                      dataUrl={shotUrl}
                      alt="开发截图"
                      issues={shotIssues}
                      tool={activeTool}
                      panMode={panMode}
                  spacePan={spaceHeld}
                      targetImage="screenshot"
                      noOf={(issue) => issueNos.get(issue.id) ?? 0}
                      onCreate={(rect, target) =>
                        setCreating({ rect, targetImage: target, shape: activeTool! })
                      }
                      onQuickCreate={handleQuickCreate}
                      onMove={handleMove}
                      onEdit={(issue) => setEditingIssue(issue)}
                      flashId={flashId}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {drawerOpen && (
          <IssueDrawer
            issues={issues ?? []}
            onHighlight={handleFlash}
            onEdit={(issue) => setEditingIssue(issue)}
            onReverify={openReverify}
            onAdd={handleQuickAdd}
            onClose={() => setDrawerOpen(false)}
          />
        )}
      </div>

      <div className="anno-toolbar-wrap">
        <div className="anno-toolbar">
          {TOOLS.map((t) => (
            <button
              key={t.value}
              type="button"
              className={`anno-tool ${tool === t.value ? 'active' : ''}`}
              onClick={() => setTool(t.value)}
            >
              <ToolIcon name={t.value} />
              {t.label}
            </button>
          ))}
        </div>
        <p className="anno-toolbar-hint">
          {TOOLS.find((t) => t.value === tool)?.hint}；按住已有标注可拖动移动位置，松开后弹出详情
        </p>
      </div>

      {creating && (
        <IssueEditorModal
          mode="create"
          issue={{
            id: '',
            pageId: pageId!,
            targetImage: creating.targetImage,
            x: creating.rect.x,
            y: creating.rect.y,
            width: creating.rect.width,
            height: creating.rect.height,
            description: '',
            severity: 'minor',
            category: 'spacing',
            status: 'pending',
            createdAt: 0
          }}
          onSave={handleCreate}
          onCancel={() => setCreating(null)}
        />
      )}

      {editingIssue && (
        <IssueEditorModal
          mode="edit"
          issue={editingIssue}
          onSave={handleUpdate}
          onDelete={handleDelete}
          onCancel={() => setEditingIssue(null)}
        />
      )}

      {reverifyIssue && (
        <ReverifyModal
          issue={reverifyIssue}
          oldScreenshotUrl={oldScreenshotUrl}
          onClose={() => setReverifyIssue(null)}
        />
      )}

      {editPageOpen && page && (
        <EditPageModal
          page={page}
          onSave={(fields) => {
            db.pages.update(pageId!, { ...fields, updatedAt: Date.now() })
            setEditPageOpen(false)
          }}
          onCancel={() => setEditPageOpen(false)}
        />
      )}
    </div>
  )
}
