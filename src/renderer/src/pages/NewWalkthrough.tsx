import { useLiveQuery } from 'dexie-react-hooks'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { db, genId, bySort, Platform, PLATFORM_LABELS, Folder } from '../db'
import DevBrowser, { type DevBrowserHandle } from '../components/DevBrowser'
import USelect from '../components/USelect'
import UTreeSelect, { type UTreeNode } from '../components/UTreeSelect'
import ProjectModal from '../components/ProjectModal'
import FolderModal from '../components/FolderModal'
import { SpecPlatIcon } from '../components/Layout'
import { FolderIconGlyph } from '../components/FolderIcon'

interface PickedImage {
  relativePath: string
  dataUrl: string
}

/** 文件夹下拉选项显示层级路径（如「设计规范 / AI 赋能」） */
function folderLabel(f: Folder, all: Folder[]): string {
  let label = f.name
  let cur = f
  const seen = new Set<string>()
  while (cur.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId)
    const parent = all.find((x) => x.id === cur.parentId)
    if (!parent) break
    label = `${parent.name} / ${label}`
    cur = parent
  }
  return label
}

/** 从应用配置读取 Figma PAT（与自动走查面板同源：启用中的 MCP 服务 → 旧版 figmaMcp 兜底） */
function patFromConfig(cfg: Record<string, unknown>): string {
  const mcps = (cfg.mcps as { pat?: string; enabled?: boolean }[] | undefined) ?? []
  // 仅读取已启用服务的 PAT（enabled 缺省视为启用）
  const withPat = mcps.find((m) => m.enabled !== false && m.pat && m.pat.trim())
  if (withPat) return withPat.pat!.trim()
  const legacy = cfg.figmaMcp as { pat?: string } | undefined
  return legacy?.pat?.trim() ?? ''
}

/** 等待隐藏采集画板挂载（首次点击后 React 提交 + webview 创建） */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export default function NewWalkthrough() {
  const { t } = useTranslation('newWalkthrough')
  /** 路由携带项目时（/project/:projectId/new）为指定项目；/new 为通用入口（需先选择项目） */
  const routeProjectId = useParams<{ projectId: string }>().projectId
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initialFolderId = searchParams.get('folderId') ?? ''

  const projects = useLiveQuery(async () => (await db.projects.toArray()).filter((p) => !p.deletedAt), [])
  const [projectId, setProjectId] = useState(routeProjectId ?? '')
  const effectiveProjectId = routeProjectId ?? projectId

  const folders = useLiveQuery(
    async () =>
      effectiveProjectId
        ? (await db.folders.where('projectId').equals(effectiveProjectId).toArray()).filter((f) => !f.deletedAt)
        : [],
    [effectiveProjectId]
  )

  const [folderId, setFolderId] = useState(initialFolderId)
  const [pageName, setPageName] = useState('')
  const [platform, setPlatform] = useState<Platform>('h5')
  const [figmaUrl, setFigmaUrl] = useState('')
  /** 开发环境页面 URL（可选，自动走查用） */
  const [devUrl, setDevUrl] = useState('')
  const [design, setDesign] = useState<PickedImage | null>(null)
  const [screenshot, setScreenshot] = useState<PickedImage | null>(null)
  /** 下拉内快捷新建：项目 / 文件夹弹窗开关（创建成功后自动选中最新一条） */
  const [creatingProject, setCreatingProject] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  /** 新建文件夹的父级：节点「+」带入当前文件夹 id，footer 快捷新建为根级 */
  const [createParentId, setCreateParentId] = useState<string>()

  /** 项目弹窗保存完成：自动选中刚创建（createdAt 最新）的项目 */
  const afterProjectCreated = async () => {
    setCreatingProject(false)
    // Table.orderBy 需索引字段（createdAt 未建索引会抛错致选中失效），Table 也无 sortBy，故全量取出后按 createdAt 排序取最新
    const all = await db.projects.toArray()
    const latest = all.sort((a, b) => a.createdAt - b.createdAt)[all.length - 1]
    if (latest) setProjectId(latest.id)
  }

  /** 文件夹弹窗保存完成：自动选中当前项目下刚创建（createdAt 最新）的文件夹 */
  const afterFolderCreated = async () => {
    setCreatingFolder(false)
    if (!effectiveProjectId) return
    const created = await db.folders.where('projectId').equals(effectiveProjectId).sortBy('createdAt')
    const latest = created[created.length - 1]
    if (latest) setFolderId(latest.id)
  }

  /** 通用入口切换项目时清空文件夹选择（避免残留其他项目的文件夹） */
  useEffect(() => {
    setFolderId(routeProjectId ? initialFolderId : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveProjectId])

  /** 文件夹树形选项：同层按 bySort 排序、按 parentId 递归组树，首项为「未分组」 */
  const folderTree = useMemo<UTreeNode[]>(() => {
    const sorted = [...(folders ?? [])].sort(bySort)
    const build = (parentId?: string): UTreeNode[] =>
      sorted
        .filter((f) => (f.parentId ?? undefined) === parentId)
        .map((f) => {
          const children = build(f.id)
          return {
            value: f.id,
            label: f.name,
            icon: (
              // 无自定义色时回退 primary，与文件夹卡片（.folder-glyph）保持一致
              <span style={{ color: f.color ?? 'var(--primary)' }}>
                <FolderIconGlyph icon={f.icon} size={14} color={f.color} />
              </span>
            ),
            children: children.length ? children : undefined
          }
        })
    return [{ value: '', label: t('ungroupedOption') }, ...build(undefined)]
  }, [folders, t])

  /** 按钮回显沿用层级全路径文案（如「设计规范 / AI 赋能」） */
  const selectedFolder = (folders ?? []).find((f) => f.id === folderId)
  const folderDisplay = selectedFolder ? folderLabel(selectedFolder, folders ?? []) : undefined

  const pickImage = async (target: 'design' | 'screenshot') => {
    const result = await window.electronAPI.selectImage()
    if (!result) return
    if (target === 'design') setDesign(result)
    else setScreenshot(result)
  }

  /* ===== 自动采集（选择图片按钮右侧）===== */
  const devRef = useRef<DevBrowserHandle | null>(null)
  /** Figma 自动采集成功时记录画板尺寸，供开发 URL 采集对齐视口宽与整页基准高 */
  const figmaFrameSizeRef = useRef<{ width: number; height: number } | null>(null)
  const [figmaBusy, setFigmaBusy] = useState(false)
  const [devBusy, setDevBusy] = useState(false)
  const [captureErr, setCaptureErr] = useState('')
  /** 首次点击「开发 URL 采集」后挂载的隐藏采集画板（fixed + 透明 + 不挡交互，采集管线与自动走查一致） */
  const [devCaptureUrl, setDevCaptureUrl] = useState('')
  const [devViewport, setDevViewport] = useState({ width: 1440, height: 900 })
  /** 窗口可视尺寸（resize 同步）：webview 元素超出窗口的部分不参与合成，capturePage 只能
      截到合成区内容 → 拼接把切片拉伸到声明尺寸 → 内容整体放大且模糊（自动走查面板同款机制） */
  const [stageWin, setStageWin] = useState({ w: window.innerWidth, h: window.innerHeight })
  useEffect(() => {
    const onResize = (): void => setStageWin({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  /** 画板视觉缩放：容器与 webview 元素按 devViewport × stageScale 摆放（完整落在窗口合成区内），
      guest 内容经 zoom=stageScale 缩小渲染，布局宽仍等于设计基准宽 */
  const devStageScale = useMemo(
    () => Math.min(1, stageWin.w / devViewport.width, stageWin.h / devViewport.height),
    [stageWin, devViewport]
  )

  /** Figma 自动采集：拉取画板截图落盘并回填设计稿 */
  const captureDesign = async () => {
    const figRaw = figmaUrl.trim()
    if (!figRaw || figmaBusy) return
    setCaptureErr('')
    setFigmaBusy(true)
    try {
      const cfg = await window.electronAPI.getConfig()
      const pat = patFromConfig(cfg)
      if (!pat) throw new Error(t('errNoPat'))
      const figmaUrl2 = /^https?:\/\//i.test(figRaw) ? figRaw : `https://${figRaw}`
      const res = await window.electronAPI.figmaFetchDesign({ pat, figmaUrl: figmaUrl2 })
      if (!res.ok || !res.data) throw new Error(res.message || t('captureFailed'))
      const buf = await (await fetch(res.data.screenshotDataUrl)).arrayBuffer()
      const relPath = await window.electronAPI.saveImage(buf, 'png')
      figmaFrameSizeRef.current = res.data.frameSize
      setDesign({ relativePath: relPath, dataUrl: res.data.screenshotDataUrl })
    } catch (e) {
      setCaptureErr(e instanceof Error ? e.message : t('captureFailed'))
    } finally {
      setFigmaBusy(false)
    }
  }

  /** 开发 URL 自动采集：隐藏挂载 DevBrowser 加载页面 → runCapture 整页截图（视口对齐 Figma 画板，缺省 1440×900） */
  const captureDevShot = async () => {
    const raw = devUrl.trim()
    if (!raw || devBusy) return
    setCaptureErr('')
    setDevBusy(true)
    try {
      // 视口优先 Figma 画板尺寸：自动采集设计稿时已记录；否则按链接轻量读取；都没有时回退 1440×900
      let frame = figmaFrameSizeRef.current
      if (!frame) {
        const figRaw = figmaUrl.trim()
        if (figRaw) {
          const cfg = await window.electronAPI.getConfig()
          const pat = patFromConfig(cfg)
          if (pat) {
            const figmaUrl2 = /^https?:\/\//i.test(figRaw) ? figRaw : `https://${figRaw}`
            const size = await window.electronAPI.figmaNodeSize({ pat, figmaUrl: figmaUrl2 })
            if (size.ok && size.width) frame = { width: size.width, height: size.height ?? 0 }
          }
        }
      }
      // 视口高钳到窗口可视高（单片高度只影响切片大小，整页总高由设计基准高独立控制，
      // 与自动走查面板 stageVp 同口径）；整页基准高仍传 frame.height
      setDevViewport({ width: frame?.width || 1440, height: Math.min(900, stageWin.h) })
      setDevCaptureUrl(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)
      // 首次采集需等 React 提交 + webview 创建；页面就绪由 runCapture 内部等待（20s 超时）
      for (let i = 0; i < 100 && !devRef.current; i++) await wait(100)
      const browser = devRef.current
      if (!browser) throw new Error(t('captureFailed'))
      const cap = await browser.runCapture(true, frame?.height || undefined)
      if (!cap.screenshotDataUrl) throw new Error(t('captureFailed'))
      const buf = await (await fetch(cap.screenshotDataUrl)).arrayBuffer()
      const relPath = await window.electronAPI.saveImage(buf, 'png')
      setScreenshot({ relativePath: relPath, dataUrl: cap.screenshotDataUrl })
    } catch (e) {
      setCaptureErr(e instanceof Error ? e.message : t('captureFailed'))
    } finally {
      setDevBusy(false)
    }
  }

  /** 双图已传齐，或已填写 Figma 链接 + 开发环境 URL（自动走查可现场采集）时即可创建 */
  const hasUrls = figmaUrl.trim() !== '' && devUrl.trim() !== ''

  /** 同层级命名查重：同一项目、同一文件夹下的其他页面同名时提示并支持跳转 */
  const duplicatePage = useLiveQuery(() => {
    const t = pageName.trim()
    if (!effectiveProjectId || !t) return undefined
    return db.pages
      .filter(
        (p) =>
          p.projectId === effectiveProjectId &&
          (p.folderId ?? '') === (folderId || '') &&
          p.pageName === t
      )
      .first()
  }, [pageName, effectiveProjectId, folderId])

  const canSubmit =
    effectiveProjectId !== '' && pageName.trim() !== '' && !duplicatePage &&
    ((design !== null && screenshot !== null) || hasUrls)

  const handleSubmit = async () => {
    if (!effectiveProjectId || !canSubmit) return
    // Figma 链接非必填；未带协议时自动补 https://
    const trimmedUrl = figmaUrl.trim()
    const normalizedUrl =
      trimmedUrl && !/^https?:\/\//i.test(trimmedUrl) ? `https://${trimmedUrl}` : trimmedUrl
    const trimmedDev = devUrl.trim()
    const normalizedDev =
      trimmedDev && !/^https?:\/\//i.test(trimmedDev) ? `http://${trimmedDev}` : trimmedDev
    const pageId = genId()
    await db.pages.add({
      id: pageId,
      folderId: folderId || undefined,
      projectId: effectiveProjectId,
      pageName: pageName.trim(),
      platform,
      figmaUrl: normalizedUrl || undefined,
      devUrl: normalizedDev || undefined,
      designImagePath: design?.relativePath ?? '',
      screenshotPath: screenshot?.relativePath ?? '',
      status: 'reviewing',
      createdAt: Date.now()
    })
    navigate(`/project/${effectiveProjectId}/page/${pageId}`)
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="settings-head-left">
          {/* 返回按钮：样式与设置页一致，返回进入前的页面（如最近访问） */}
          <button type="button" className="settings-close" title={t('back')} onClick={() => navigate(-1)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <h1>{t('title')}</h1>
        </div>
      </div>

      <div className="card wizard-body">
        {/* 通用入口（/new）：先选择项目（下拉底部可快捷新建），再选择所属文件夹 */}
        {!routeProjectId && (
          <>
            <label className="field-label">{t('projectLabel')}</label>
            <USelect
              value={projectId}
              onChange={setProjectId}
              placeholder={t('selectProjectFirst')}
              options={[
                { value: '', label: t('selectProjectFirst') },
                ...[...(projects ?? [])].sort(bySort).map((p) => ({ value: p.id, label: p.name }))
              ]}
              footer={
                <button type="button" className="btn-text u-select-create" onClick={() => setCreatingProject(true)}>
                  ＋ {t('createProject')}
                </button>
              }
            />
          </>
        )}

        <label className="field-label">{t('folderLabel')}</label>
        <UTreeSelect
          value={folderId}
          onChange={setFolderId}
          placeholder={effectiveProjectId ? t('ungrouped') : t('selectProjectFirst')}
          displayLabel={folderDisplay}
          nodes={folderTree}
          // 节点右侧「+」：在当前文件夹下新建子文件夹（footer 快捷新建为根级）
          onNodeCreate={(v) => {
            setCreateParentId(v)
            setCreatingFolder(true)
          }}
          footer={
            <button
              type="button"
              className="btn-text u-select-create"
              disabled={!effectiveProjectId}
              title={effectiveProjectId ? undefined : t('selectProjectFirst')}
              onClick={() => {
                setCreateParentId(undefined)
                setCreatingFolder(true)
              }}
            >
              ＋ {t('createFolder')}
            </button>
          }
        />

        <label className="field-label">{t('pageNameLabel')}</label>
        <input
          className="input"
          placeholder={t('pageNamePlaceholder')}
          value={pageName}
          onChange={(e) => setPageName(e.target.value)}
        />
        {duplicatePage && (
          <div className="dup-hint">
            <span>{t('duplicatePageMsg')}</span>
            <button
              type="button"
              className="btn-text"
              onClick={() => navigate(`/project/${effectiveProjectId}/page/${duplicatePage.id}`)}
            >
              {t('openPage')}
            </button>
          </div>
        )}

        <label className="field-label">{t('platformLabel')}</label>
        <div className="segmented">
          {(Object.keys(PLATFORM_LABELS) as Platform[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`segment-item${platform === k ? ' active' : ''}`}
              onClick={() => setPlatform(k)}
            >
              <SpecPlatIcon platformKey={k} />
              {t(`platform_${k}`)}
            </button>
          ))}
        </div>

        <label className="field-label">{t('figmaLabel')}</label>
        <input
          className="input"
          placeholder={t('figmaPlaceholder')}
          value={figmaUrl}
          onChange={(e) => setFigmaUrl(e.target.value)}
        />

        <label className="field-label">{t('devUrlLabel')}</label>
        <input
          className="input"
          placeholder={t('devUrlPlaceholder')}
          value={devUrl}
          onChange={(e) => setDevUrl(e.target.value)}
        />

        <div className="upload-row">
          <div className="upload-box">
            <p className="field-label">{t('designLabel')}</p>
            <div className="upload-actions">
              <button className="btn-primary" onClick={() => pickImage('design')}>
                {t('chooseImage')}
              </button>
              {/* 填写 Figma 链接后可一键自动采集设计稿 */}
              <button
                className="btn-secondary"
                disabled={!figmaUrl.trim() || figmaBusy}
                title={figmaUrl.trim() ? undefined : t('captureNeedFigmaUrl')}
                onClick={captureDesign}
              >
                {figmaBusy ? t('capturing') : t('captureFromFigma')}
              </button>
            </div>
            {design && (
              <div className="image-preview">
                <img src={design.dataUrl} alt={t('designAlt')} />
                <span className="ok-label">{t('uploaded')}</span>
              </div>
            )}
          </div>
          <div className="upload-box">
            <p className="field-label">{t('screenshotLabel')}</p>
            <div className="upload-actions">
              <button className="btn-primary" onClick={() => pickImage('screenshot')}>
                {t('chooseImage')}
              </button>
              {/* 填写开发 URL 后可一键自动采集开发截图（与自动走查同一采集管线） */}
              <button
                className="btn-secondary"
                disabled={!devUrl.trim() || devBusy}
                title={devUrl.trim() ? undefined : t('captureNeedDevUrl')}
                onClick={captureDevShot}
              >
                {devBusy ? t('capturing') : t('captureFromDev')}
              </button>
            </div>
            {screenshot && (
              <div className="image-preview">
                <img src={screenshot.dataUrl} alt={t('screenshotAlt')} />
                <span className="ok-label">{t('uploaded')}</span>
              </div>
            )}
          </div>
        </div>
        {captureErr && <div className="capture-err">{captureErr}</div>}

        <div className="wizard-actions">
          <button className="btn-secondary" onClick={() => navigate(-1)}>
            {t('cancel')}
          </button>
          <button className="btn-primary" onClick={handleSubmit} disabled={!canSubmit}>
            {t('startWalkthrough')}
          </button>
        </div>
      </div>

      {/* 下拉内快捷新建：复用项目 / 文件夹完整创建弹窗，成功后自动选中新条目 */}
      {creatingProject && (
        <ProjectModal onDone={afterProjectCreated} onCancel={() => setCreatingProject(false)} />
      )}
      {creatingFolder && effectiveProjectId && (
        <FolderModal projectId={effectiveProjectId} parentId={createParentId} onDone={afterFolderCreated} onCancel={() => setCreatingFolder(false)} />
      )}

      {/* 隐藏采集画板：开发 URL 自动采集用。容器与 webview 元素按 devViewport × stageScale 摆放
          （元素完整落在窗口合成区内——超窗部分不参与合成，capturePage 截不到），guest 内容经
          zoom=stageScale 缩小渲染，布局宽仍为设计基准宽，与自动走查隐藏画板同一套已验证配置。
          采集走 DevBrowser 内置管线（整页拼接 / guest 布局自校正），加载失败透传到采集错误提示 */}
      {devCaptureUrl && (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            left: 0,
            top: 0,
            width: devViewport.width * devStageScale,
            height: devViewport.height * devStageScale,
            opacity: 0,
            pointerEvents: 'none',
            zIndex: -1,
            overflow: 'hidden'
          }}
        >
          <DevBrowser
            ref={devRef}
            url={devCaptureUrl}
            viewport={devViewport}
            displayScale={devStageScale}
            hideBar
            hideScrollbar
            onFail={setCaptureErr}
          />
        </div>
      )}
    </div>
  )
}
