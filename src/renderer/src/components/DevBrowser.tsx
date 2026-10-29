import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { StyleNode } from '../../../shared/types'
import { tr } from '../i18n'
import { getDomCollectScript } from './devCollectScript'

export interface CaptureResult {
  domRoot: StyleNode
  screenshotDataUrl: string
  viewport: { width: number; height: number }
  collected: number
  skipped: number
}

export interface DevBrowserHandle {
  /** 重新加载当前页面 */
  reload: () => void
  /** 执行一次采集：滚动置顶 →（整页模式临时拉高）→ DOM 采集 → 截图 → 还原 */
  runCapture: (fullPage: boolean) => Promise<CaptureResult>
}

interface DevBrowserProps {
  /** 目标 URL（外部输入后传入触发加载） */
  url: string
  /** 视口尺寸（CSS px） */
  viewport: { width: number; height: number }
  /** 显示缩放（面板宽 / 视口宽，≤1） */
  displayScale: number
  /** 加载失败回调 */
  onFail?: (message: string) => void
  /** 加载状态变化 */
  onLoadingChange?: (loading: boolean) => void
  /** 隐藏顶部地址条（独立弹窗内由外层顶栏承载 URL 输入） */
  hideBar?: boolean
  /** 隐藏 webview 页面滚动条（页面仍可滚动，仅不显示滑块） */
  hideScrollbar?: boolean
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 带超时的 executeJavaScript */
async function execJs(webview: Electron.WebviewTag, code: string, timeoutMs = 30000): Promise<unknown> {
  return Promise.race([
    webview.executeJavaScript(code),
    new Promise((_r, reject) => setTimeout(() => reject(new Error(tr('scriptTimeout', 'devBrowser'))), timeoutMs))
  ])
}

/**
 * 内置浏览器（Electron webview 封装）：
 * - persist 分区保持登录态（内网页面手动登录一次即可）
 * - 自定义视口 + 等比缩放显示
 * - 注入采集脚本 + capturePage 截图（视口/整页）
 *
 * 事件一律在挂载后用 addEventListener 手动挂接：
 * React 18 对自定义元素的 onXxx-dashed 属性不会真正注册监听（dom-ready 等收不到），
 * 且 attach 完成前调用 loadURL 会触发同步 IPC 死锁（白屏卡死），必须等 did-attach。
 */
const DevBrowser = forwardRef<DevBrowserHandle, DevBrowserProps>(function DevBrowser(
  { url, viewport, displayScale, onFail, onLoadingChange, hideBar, hideScrollbar },
  ref
) {
  const { t } = useTranslation('devBrowser')
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  /** 整页截图时临时拉高的高度（px） */
  const captureHeight = useRef<number | null>(null)
  /** 触发重渲染用（captureHeight 在 ref 中） */
  const [, forceRender] = useState(0)
  /** 当前显示的 URL（含站内跳转） */
  const [currentUrl, setCurrentUrl] = useState(url)
  /** 初始 src 只在挂载时生效；about:blank 确保 webview 挂载时即 attach（空 src 永不 attach，did-attach 不会触发导致 URL 永远挂起） */
  const initialSrc = useRef(url || 'about:blank')
  /** 最近一次真实请求加载的 URL（'' = 尚未发起真实加载，初始 about:blank 的 dom-ready 不视为就绪） */
  const requestedUrlRef = useRef('')
  /** webview 是否已完成 guest 进程挂载 */
  const attachedRef = useRef(false)
  /** attach 前到达的待加载 URL */
  const pendingUrlRef = useRef('')
  /** 等待 dom-ready 的等待者（采集前确保页面加载完成） */
  const readyWaiters = useRef<{ resolve: () => void; reject: (e: Error) => void }[]>([])
  /** ERR_FAILED(-2) 自动重试标记（成功加载后复位） */
  const retryRef = useRef(false)
  /** 已尝试「切直连」兜底（系统代理拦截时） */
  const directTriedRef = useRef(false)

  const setLoadingState = (v: boolean): void => {
    setLoading(v)
    onLoadingChange?.(v)
  }

  const markReady = (): void => {
    setReady(true)
    setError('')
    retryRef.current = false
    directTriedRef.current = false
    setLoadingState(false)
    readyWaiters.current.forEach((w) => w.resolve())
    readyWaiters.current = []
  }

  const failLoad = (msg: string): void => {
    setError(msg)
    setLoadingState(false)
    readyWaiters.current.forEach((w) => w.reject(new Error(msg)))
    readyWaiters.current = []
  }

  const doLoad = (wv: Electron.WebviewTag, target: string): void => {
    requestedUrlRef.current = target
    setReady(false)
    setLoadingState(true)
    wv.loadURL(target).catch((err: unknown) => {
      const msg = t('loadFailedReason', { reason: err instanceof Error ? err.message : String(err) })
      failLoad(msg)
      onFail?.(msg)
    })
  }

  useEffect(() => {
    setCurrentUrl(url)
  }, [url])

  // URL 变化 → loadURL 导航；attach 完成前先挂起（did-attach 触发或 1.5s 兜底后加载）
  useEffect(() => {
    const wv = webviewRef.current
    if (!url || !wv) return
    if (attachedRef.current) {
      doLoad(wv, url)
      return
    }
    pendingUrlRef.current = url
    const fallback = setTimeout(() => {
      if (pendingUrlRef.current === url && webviewRef.current) {
        attachedRef.current = true
        doLoad(webviewRef.current, url)
        pendingUrlRef.current = ''
      }
    }, 1500)
    return () => clearTimeout(fallback)
  }, [url])

  // 统一挂接 webview 事件（组件挂载一次，HMR 重建组件时随 remount 重新挂接）
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const handleAttach = (): void => {
      attachedRef.current = true
      if (pendingUrlRef.current) {
        doLoad(wv, pendingUrlRef.current)
        pendingUrlRef.current = ''
      }
    }
    const handleDomReady = (): void => {
      // 初始 about:blank 的 dom-ready 不算加载完成
      if (requestedUrlRef.current) markReady()
      // 隐藏页面滚动条滑块（每次导航后需重新注入；页面仍可滚动）
      if (hideScrollbar) {
        wv.insertCSS('::-webkit-scrollbar{width:0!important;height:0!important}').catch(() => undefined)
      }
    }
    const handleStartLoading = (): void => setLoadingState(true)
    const handleStopLoading = (): void => setLoadingState(false)
    const handleNavigate = (e: Electron.DidNavigateEvent): void => {
      setCurrentUrl(e.url)
      if (hideScrollbar) {
        wv.insertCSS('::-webkit-scrollbar{width:0!important;height:0!important}').catch(() => undefined)
      }
    }
    const handleFailLoad = (e: Electron.DidFailLoadEvent): void => {
      if (e.errorCode === -3) return // 用户主动中断
      // ERR_FAILED(-2)：外部站点常见于系统代理不可达/拦截，三级恢复：重载 → 切直连重载 → 报错
      if (e.errorCode === -2 && requestedUrlRef.current) {
        if (!retryRef.current) {
          retryRef.current = true
          window.setTimeout(() => webviewRef.current?.reload(), 600)
          return
        }
        if (!directTriedRef.current) {
          directTriedRef.current = true
          void window.electronAPI
            .setBrowserDirectProxy()
            .catch(() => undefined)
            .then(() => {
              window.setTimeout(() => webviewRef.current?.reload(), 300)
            })
          return
        }
      }
      const msg =
        e.errorCode === -2
          ? t('loadFailedNetwork')
          : t('loadFailedCode', {
              code: e.errorCode,
              description: e.errorDescription || t('checkUrlNetwork')
            })
      failLoad(msg)
      onFail?.(msg)
    }
    wv.addEventListener('did-attach', handleAttach)
    wv.addEventListener('dom-ready', handleDomReady)
    wv.addEventListener('did-start-loading', handleStartLoading)
    wv.addEventListener('did-stop-loading', handleStopLoading)
    wv.addEventListener('did-navigate', handleNavigate)
    wv.addEventListener('did-fail-load', handleFailLoad)
    return () => {
      wv.removeEventListener('did-attach', handleAttach)
      wv.removeEventListener('dom-ready', handleDomReady)
      wv.removeEventListener('did-start-loading', handleStartLoading)
      wv.removeEventListener('did-stop-loading', handleStopLoading)
      wv.removeEventListener('did-navigate', handleNavigate)
      wv.removeEventListener('did-fail-load', handleFailLoad)
    }
  }, [t])

  useImperativeHandle(ref, () => ({
    reload: () => {
      webviewRef.current?.reload()
    },
    runCapture: async (fullPage: boolean): Promise<CaptureResult> => {
      const webview = webviewRef.current
      if (!webview) throw new Error(t('browserNotCreated'))
      // 页面可能仍在加载：等待 dom-ready；事件未触发时用 isLoading 轮询兜底
      if (!ready) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            clearInterval(poll)
            reject(
              new Error(t('loadTimeout', { url: currentUrl || t('emptyAddress') }))
            )
          }, 20000)
          const poll = setInterval(() => {
            const wv = webviewRef.current
            if (!wv) return
            const u = wv.getURL() || ''
            if (!wv.isLoading() && u !== '' && u !== 'about:blank') {
              clearTimeout(timer)
              clearInterval(poll)
              markReady()
              resolve()
            }
          }, 500)
          readyWaiters.current.push({
            resolve: () => {
              clearTimeout(timer)
              clearInterval(poll)
              resolve()
            },
            reject: (e) => {
              clearTimeout(timer)
              clearInterval(poll)
              reject(e)
            }
          })
        })
      }
      // 1. 滚动到顶部，保证坐标与截图一致
      await execJs(webview, 'window.scrollTo(0, 0); true')
      await wait(300)
      // 2. 整页模式：临时把 webview 高度拉到文档总高，等布局稳定
      if (fullPage) {
        const docHeight = (await execJs(
          webview,
          'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)'
        )) as number
        captureHeight.current = Math.min(Math.max(docHeight, viewport.height), 20000)
        forceRender((n) => n + 1)
        await wait(800)
      }
      try {
        // 3. DOM 采集（脚本内部已等待渲染帧）
        const raw = (await execJs(webview, getDomCollectScript())) as string
        const parsed = JSON.parse(raw) as {
          ok: boolean
          message?: string
          root?: StyleNode
          viewport?: { width: number; height: number }
          collected?: number
          skipped?: number
        }
        if (!parsed.ok || !parsed.root) throw new Error(parsed.message ?? t('domCollectFailed'))
        // 4. 截图
        const image = await webview.capturePage()
        const screenshotDataUrl = image.toDataURL()
        if (!screenshotDataUrl || screenshotDataUrl.length < 1000) {
          throw new Error(t('screenshotEmpty'))
        }
        return {
          domRoot: parsed.root,
          screenshotDataUrl,
          viewport: parsed.viewport ?? viewport,
          collected: parsed.collected ?? 0,
          skipped: parsed.skipped ?? 0
        }
      } finally {
        // 5. 还原高度
        if (captureHeight.current !== null) {
          captureHeight.current = null
          forceRender((n) => n + 1)
        }
      }
    }
  }))

  const displayHeight = (captureHeight.current ?? viewport.height) * displayScale

  return (
    <div className="dev-browser">
      {!hideBar && (
        <div className="dev-browser-bar">
          <span className={`dev-browser-dot ${loading ? 'loading' : ''}`} />
          <span className="dev-browser-url" title={currentUrl}>
            {currentUrl || t('notLoaded')}
          </span>
          <button className="btn-text dev-browser-reload" disabled={!ready} onClick={() => webviewRef.current?.reload()}>
            {t('refresh')}
          </button>
        </div>
      )}
      {/* 舞台宽度 = 视觉宽度（webview 布局占位大于缩放后视觉尺寸，由 overflow 裁剪），保证居中且无多余空白 */}
      <div
        className="dev-browser-stage"
        style={{ width: viewport.width * displayScale, height: displayHeight }}
      >
        <webview
          ref={webviewRef}
          src={initialSrc.current}
          partition="persist:walkthrough"
          allowpopups={'true' as unknown as boolean}
          style={{
            width: viewport.width,
            height: captureHeight.current ?? viewport.height,
            transform: `scale(${displayScale})`,
            transformOrigin: 'top left'
          }}
        />
        {!url && <div className="dev-browser-empty">{t('emptyUrlHint')}</div>}
        {error && <div className="dev-browser-error">{error}</div>}
      </div>
    </div>
  )
})

export default DevBrowser
