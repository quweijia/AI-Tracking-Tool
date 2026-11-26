import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import DevBrowser, { type DevBrowserHandle, isLoginUrl } from '../components/DevBrowser'
import { CAPTURE_STORAGE_SCRIPT, buildLoginProbeScript } from '../components/walkSessionScripts'
import USelect from '../components/USelect'
import { showScreenPermissionGuide } from '../components/ScreenPermissionGuide'

/** label 为 browserPopupPage ns 的 i18n key */
const VIEWPORT_PRESETS: { value: string; label: string; width: number; height: number }[] = [
  { value: '375', label: 'vpMobile', width: 375, height: 812 },
  { value: '768', label: 'vpTablet', width: 768, height: 1024 },
  { value: '1440', label: 'vpDesktop', width: 1440, height: 900 },
  { value: '1920', label: 'vpLarge', width: 1920, height: 1080 },
  { value: 'custom', label: 'vpCustom', width: 0, height: 0 }
]

const clampW = (n: number): number => Math.min(3840, Math.max(240, Math.round(n) || 1440))
const clampVp = (n: number): number => Math.min(21600, Math.max(240, Math.round(n) || 900))

/**
 * 独立开发浏览器弹窗页（/browser 裸路由，无侧边栏顶栏）：
 * - 自动走查模式：初始窗口尺寸自动填充 Figma 画板宽高，可切换预设/自定义尺寸与高度，
 *   页面加载完成后在底部操作条点击「生成问题标注」，采集结果回传主窗口
 * - 手动打开模式（未收到视口下发）：保留预设视口切换
 */
export default function BrowserPopupPage() {
  const { t } = useTranslation('browserPopupPage')
  const [searchParams] = useSearchParams()
  const initialUrl = useMemo(() => {
    const raw = (searchParams.get('url') ?? '').trim()
    if (!raw) return ''
    // file://（本地导出的 HTML 报告）原样保留，其余自动补 http://
    if (/^file:\/\//i.test(raw)) return raw
    return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  }, [searchParams])

  const devRef = useRef<DevBrowserHandle>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [urlInput, setUrlInput] = useState(initialUrl)
  const [loadedUrl, setLoadedUrl] = useState(initialUrl)
  /** webview 页面加载完成（底部「生成问题标注」可用前提） */
  const [pageLoaded, setPageLoaded] = useState(false)
  /** 自动走查视口（主窗口下发：宽度自动匹配 Figma） */
  const [walkVp, setWalkVp] = useState<{ width: number; height: number } | null>(null)
  /** 窗口尺寸切换：figma = 自动走查下发的 Figma 画板尺寸；custom = 自定义宽高 */
  const [vpKey, setVpKey] = useState('figma')
  const [customW, setCustomW] = useState(1440)
  const [customH, setCustomH] = useState(900)
  const [stageWidth, setStageWidth] = useState(1200)
  const [stageHeight, setStageHeight] = useState(640)
  const [fullPage, setFullPage] = useState(true)
  /** 样机外壳类型已移除；放大查看：1 = 适应窗口，2/3 = 放大倍率（可滚动查看细节） */
  const [zoom, setZoom] = useState(1)
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // 消息 10 秒后自动消失
  const prevMsgTextRef = useRef('')
  useEffect(() => {
    if (!msg || msg.text === prevMsgTextRef.current) return
    prevMsgTextRef.current = msg.text
    const timer = setTimeout(() => setMsg(null), 10000)
    return () => clearTimeout(timer)
  }, [msg])

  // ===== 登录模式（自动走查检测到登录页时唤起）：手动登录 → 命中「登录成功标识」→ 抓取上下文 → 保存会话 profile =====
  /** 登录成功标识：css:选择器 / url:关键词 / 页面文本关键词；留空走默认启发式 */
  const loginMode = searchParams.get('mode') === 'login'
  // ===== 产品标注 URL 采集模式（来自产品标注新建页面）：仅显示三种截图按钮 =====
  const captureMode = searchParams.get('mode') === 'capture'
  /** 采集用途：newPage=新建页面（来自项目详情页），replaceImage=替换画布图片（来自画布页 hover 按钮） */
  const capturePurpose = (searchParams.get('purpose') as 'newPage' | 'replaceImage') || 'newPage'
  console.log('[BrowserPopupPage] mode=search:', searchParams.get('mode'), 'captureMode:', captureMode, 'purpose:', capturePurpose, 'hash:', window.location.hash)
  const [marker, setMarker] = useState('')
  /** 登录流程状态文案（等待/保存中/已保存） */
  const [loginStatus, setLoginStatus] = useState('')
  /** 登录保存中（防重复触发） */
  const loginSavingRef = useRef(false)

  // 登录模式：预填该域名上次使用的登录成功标识
  useEffect(() => {
    if (!loginMode || !initialUrl) return
    void window.electronAPI
      .walkSessionLoad(initialUrl)
      .then((res) => {
        if (res?.profile?.marker) setMarker(res.profile.marker)
      })
      .catch(() => undefined)
  }, [loginMode, initialUrl])

  /** 默认成功启发式：同一目标域名下离开登录 URL 且无可见密码框 */
  const loginHit = (probe: { url: string; pw: boolean; sel: boolean; text: string }): boolean => {
    const m = marker.trim()
    if (m) {
      if (m.startsWith('css:')) return probe.sel
      if (m.startsWith('url:')) return probe.url.includes(m.slice(4).trim())
      return probe.text.includes(m)
    }
    try {
      const sameHost = new URL(probe.url).host === new URL(initialUrl).host
      return sameHost && !isLoginUrl(probe.url) && !probe.pw
    } catch {
      return false
    }
  }

  /** 抓取 webview 上下文并加密保存会话 profile，通知主窗口恢复走查后自动关窗 */
  const finishLogin = async (): Promise<void> => {
    if (loginSavingRef.current) return
    loginSavingRef.current = true
    setLoginStatus(t('loginSaving'))
    try {
      const dev = devRef.current
      let snap: { ls?: Record<string, string>; ss?: Record<string, string>; idb?: unknown[]; message?: string } = {}
      if (dev) {
        const raw = String(await dev.evaluate(CAPTURE_STORAGE_SCRIPT))
        snap = JSON.parse(raw) as typeof snap
        // 快照超 20MB 时丢弃 indexedDB（异常站点缓存过大，保存优先保障登录态核心）
        if (raw.length > 20_000_000) snap.idb = []
      }
      const cur = dev?.getUrl() || initialUrl
      const res = await window.electronAPI.walkSessionSave({
        url: cur || initialUrl,
        marker: marker.trim() || undefined,
        ls: snap.ls,
        ss: snap.ss,
        idb: snap.idb
      })
      if (!res?.ok) throw new Error(res?.message || 'save failed')
      setLoginStatus(t('loginSaved'))
      window.electronAPI.popupSendLoginResult()
      // 结果已回传主窗口：延迟关闭弹窗（等待消息发出）
      setTimeout(() => window.close(), 600)
    } catch (err) {
      loginSavingRef.current = false
      setLoginStatus('')
      setMsg({ ok: false, text: t('loginSaveFail', { msg: err instanceof Error ? err.message : String(err) }) })
    }
  }

  // 登录模式：轮询探测登录成功（命中标识自动抓取保存，无需用户手动确认）
  useEffect(() => {
    if (!loginMode) return
    let stopped = false
    const tick = async (): Promise<void> => {
      if (stopped || loginSavingRef.current) return
      const dev = devRef.current
      if (!dev) return
      try {
        const cur = dev.getUrl()
        if (!cur || cur === 'about:blank') return
        const m = marker.trim()
        const probeRaw = String(await dev.evaluate(buildLoginProbeScript(m.startsWith('css:') ? m.slice(4) : '')))
        const probe = JSON.parse(probeRaw) as { url: string; pw: boolean; sel: boolean; text: string }
        if (stopped || loginSavingRef.current) return
        if (loginHit(probe)) void finishLogin()
      } catch {
        // 页面跳转中/脚本未就绪：下一轮重试
      }
    }
    const timer = window.setInterval(() => void tick(), 1500)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [loginMode, marker])

  // 拉取已下发的视口 + 监听后续下发（规避「先发送后加载」竞态：挂载时主动拉一次）
  useEffect(() => {
    void window.electronAPI.popupGetViewport().then((vp) => {
      if (vp && vp.autoWidth) setWalkVp({ width: vp.width, height: vp.height })
    })
    const off = window.electronAPI.popupOnViewport((vp) => {
      if (vp.autoWidth) setWalkVp({ width: vp.width, height: vp.height })
    })
    return off
  }, [])

  // Figma 视口到达后即为默认窗口尺寸（无需手动填充）

  const vpOptions = useMemo(() => {
    const base = VIEWPORT_PRESETS.map((p) => ({ value: p.value, label: t(p.label) }))
    return walkVp
      ? [{ value: 'figma', label: t('figmaViewport', { width: walkVp.width, height: walkVp.height }) }, ...base]
      : base
  }, [walkVp, t])

  const vp = useMemo(() => {
    if (vpKey === 'figma') {
      return walkVp ? { width: walkVp.width, height: walkVp.height } : { width: 1440, height: 900 }
    }
    const preset = VIEWPORT_PRESETS.find((p) => p.value === vpKey)
    if (preset && preset.value !== 'custom') return { width: preset.width, height: preset.height }
    return { width: clampW(customW), height: clampVp(customH) }
  }, [vpKey, walkVp, customW, customH])

  // 独立窗口：原生标题栏显示「内置浏览器」/「登录 · 内置浏览器」（覆盖 index.html 的应用标题）
  useEffect(() => {
    document.title = loginMode ? t('loginTitle') : t('builtinBrowser')
  }, [t, loginMode])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect?.width) setStageWidth(rect.width)
      if (rect?.height) setStageHeight(rect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** 显示缩放：宽度撑满舞台、高度超出时按高度收敛；放大查看时整体乘以倍率（舞台可滚动看细节） */
  const displayScale = Math.min(1, (stageWidth - 2) / vp.width, stageHeight / vp.height) * zoom

  /** 归一化 URL：file:// 原样放行，其余自动补 http:// 并拦截应用自身地址（防嵌套假死） */
  const resolveUrl = (raw: string): string | null => {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const url = /^https?:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
    try {
      if (new URL(url).origin === window.location.origin) {
        setMsg({ ok: false, text: t('cannotLoadSelfUrl') })
        return null
      }
    } catch {
      // 非法 URL 交给页面加载流程报错
    }
    return url
  }

  // 主窗口导航指令
  useEffect(() => {
    const offNavigate = window.electronAPI.popupOnNavigate((u) => {
      setUrlInput(u)
      setLoadedUrl(u)
      setPageLoaded(false)
    })
    return offNavigate
  }, [])

  const load = (): void => {
    const url = resolveUrl(urlInput)
    if (url) {
      setPageLoaded(false)
      setLoadedUrl(url)
    }
  }

  /** 将采集截图缩回 CSS 像素坐标系：webview.capturePage 按（宿主 DPR × zoom）输出物理像素，
   * 按返回 viewport 的 CSS 宽反推像素密度后 canvas 重绘；密度 ≈1 或加载失败时原图返回 */
  const normalizeCaptureScale = (dataUrl: string, cssWidth: number): Promise<string> => {
    if (!cssWidth || cssWidth <= 0) return Promise.resolve(dataUrl)
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        const density = img.naturalWidth / cssWidth
        if (!(density > 1.01)) return resolve(dataUrl)
        const w = Math.round(cssWidth)
        const h = Math.max(1, Math.round(img.naturalHeight / density))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) return resolve(dataUrl)
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/png'))
      }
      img.onerror = () => resolve(dataUrl)
      img.src = dataUrl
    })
  }

  /** 产品标注 URL 采集：三种截图方式，根据 purpose 选择回传通道 */
  const handleCapture = async (type: 'full' | 'visible' | 'region'): Promise<void> => {
    setSending(true)
    setMsg(null)
    try {
      let dataUrl: string
      if (type === 'region') {
        const result = await window.electronAPI.captureRegion()
        if (!result?.ok) {
          // macOS 录屏权限未授权：弹出 TRAE CN 风格权限引导
          if (result && !result.ok && result.reason === 'permission') showScreenPermissionGuide()
          setSending(false)
          return
        }
        dataUrl = result.dataUrl
      } else {
        const cap = await devRef.current!.runCapture(type === 'full')
        // 采集图按宿主 DPR × zoom 输出物理像素，缩回 CSS 像素坐标系与本地上传图（1:1）一致，
        // 否则画布按图像自然宽归一时内容被放大（实测 64px 导航条显示成 104px）
        dataUrl = await normalizeCaptureScale(cap.screenshotDataUrl, cap.viewport.width)
      }
      // 从网页 <title> 获取页面名称
      let name = '页面'
      try {
        const titleResult = await devRef.current!.evaluate('document.title')
        if (titleResult && typeof titleResult === 'string' && titleResult.trim()) {
          name = titleResult.trim()
        }
      } catch {
        // 获取失败，使用默认值
      }
      // 根据用途选择不同的回传通道
      console.log('[BrowserPopupPage] 捕捉完成回传:', capturePurpose, 'dataUrl 长度:', dataUrl?.length ?? 0)
      if (capturePurpose === 'replaceImage') {
        window.electronAPI.urlCaptureResult({ dataUrl, name })
      } else {
        window.electronAPI.newPageResult({ dataUrl, name })
      }
      setTimeout(() => window.close(), 400)
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setSending(false)
    }
  }

  /** 生成问题标注：本页采集 DOM + 截图，回传主窗口走查面板 */
  const generateAnnotations = async (): Promise<void> => {
    if (sending) return
    setSending(true)
    setMsg(null)
    try {
      const cap = await devRef.current!.runCapture(fullPage)
      window.electronAPI.popupSendWalkResult(cap)
      // 结果已回传主窗口：延迟关闭弹窗（等待消息发出），主窗口接手后续 AI 走查流程
      setTimeout(() => window.close(), 400)
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="browser-popup">
      <div className="bp-topbar">
        <span className="bp-title">{loginMode ? t('loginTitle') : t('builtinBrowser')}</span>
        <input
          className="input bp-url"
          placeholder={t('urlPlaceholder')}
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
        />
        {loginMode && (
          <input
            className="input bp-marker"
            placeholder={t('loginMarkerPlaceholder')}
            title={t('loginMarker')}
            value={marker}
            onChange={(e) => setMarker(e.target.value)}
          />
        )}
        <button
          className="btn-secondary"
          disabled={!urlInput.trim()}
          onClick={() => {
            // 输入的 URL 与当前页不同 → 导航；相同 → 重新加载当前页
            const next = resolveUrl(urlInput)
            if (next && next !== loadedUrl) {
              setPageLoaded(false)
              setLoadedUrl(next)
            } else {
              devRef.current?.reload()
            }
          }}
        >
          {t('refresh')}
        </button>
        {!loginMode && (
          <div className="bp-vp">
            <USelect value={vpKey} onChange={setVpKey} options={vpOptions} />
            {vpKey === 'custom' && (
              <>
                <span className="auto-walk-custom-vp">
                  {t('widthLabel')}
                  <input
                    className="input input-sm"
                    type="number"
                    min={240}
                    max={3840}
                    value={customW}
                    onChange={(e) => setCustomW(Number(e.target.value))}
                  />
                </span>
                <span className="auto-walk-custom-vp">
                  {t('heightLabel')}
                  <input
                    className="input input-sm"
                    type="number"
                    min={240}
                    max={21600}
                    value={customH}
                    onChange={(e) => setCustomH(Number(e.target.value))}
                  />
                </span>
              </>
            )}
          </div>
        )}
        {sending && <span className="bp-capturing">{t('capturing')}</span>}
      </div>
      {msg && <p className={`auto-walk-msg ${msg.ok ? 'ok' : 'err'} bp-msg`}>{msg.text}</p>}
      <div ref={stageRef} className={`bp-stage${zoom > 1 ? ' bp-stage-zoom' : ''}`}>
        <DevBrowser
          ref={devRef}
          url={loadedUrl}
          viewport={vp}
          displayScale={displayScale}
          hideBar
          hideScrollbar
          onFail={(m) => setMsg({ ok: false, text: m })}
          onLoadingChange={(loading) => setPageLoaded(!loading)}
        />
      </div>
      {loginMode ? (
        <div className="bp-actionbar">
          <span className="bp-actionbar-hint">
            {loginStatus || t('loginHint')}
          </span>
          <button className="btn-primary" disabled={loginSavingRef.current} onClick={() => void finishLogin()}>
            {loginSavingRef.current ? t('loginSaving') : t('loginManual')}
          </button>
        </div>
      ) : captureMode ? (
        <div className="bp-actionbar">
          <span className="bp-actionbar-hint">
            {pageLoaded ? t('captureHint') : t('hintWaiting')}
          </span>
          <button
            className="btn-secondary"
            disabled={!pageLoaded || sending}
            onClick={() => void handleCapture('full')}
          >
            {t('captureFullPage')}
          </button>
          <button
            className="btn-secondary"
            disabled={!pageLoaded || sending}
            onClick={() => void handleCapture('visible')}
          >
            {t('captureVisible')}
          </button>
          <button
            className="btn-primary"
            disabled={sending}
            onClick={() => void handleCapture('region')}
          >
            {t('captureRegion')}
          </button>
        </div>
      ) : (
        walkVp && (
          <div className="bp-actionbar">
          <label className="inline-label">
            <input type="checkbox" checked={fullPage} onChange={(e) => setFullPage(e.target.checked)} />
            {t('fullPage')}
          </label>
          <div className="aw-panel-tools" title={t('zoomHint')}>
            <button
              type="button"
              className="aw-tool-btn"
              title={t('zoomOutTitle')}
              disabled={zoom <= 1}
              onClick={() => setZoom((z) => Math.max(1, Math.round((z - 0.5) * 2) / 2))}
            >
              −
            </button>
            <span className="aw-zoom-val">×{zoom}</span>
            <button
              type="button"
              className="aw-tool-btn"
              title={t('zoomInTitle')}
              disabled={zoom >= 3}
              onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.5) * 2) / 2))}
            >
              ＋
            </button>
          </div>
          <span className="bp-actionbar-hint">
            {pageLoaded ? t('hintLoaded') : t('hintWaiting')}
          </span>
          <button
            className="btn-primary"
            disabled={!pageLoaded || sending}
            onClick={() => void generateAnnotations()}
          >
            {sending ? t('generating') : t('generateAnnotations')}
          </button>
          </div>
        )
      )}
    </div>
  )
}
