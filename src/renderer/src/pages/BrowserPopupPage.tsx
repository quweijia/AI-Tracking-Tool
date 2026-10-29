import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import DevBrowser, { type DevBrowserHandle } from '../components/DevBrowser'
import USelect from '../components/USelect'

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

  // 独立窗口：原生标题栏显示「内置浏览器」（覆盖 index.html 的应用标题）
  useEffect(() => {
    document.title = t('builtinBrowser')
  }, [t])

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
        <span className="bp-title">{t('builtinBrowser')}</span>
        <input
          className="input bp-url"
          placeholder={t('urlPlaceholder')}
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
        />
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
      {walkVp && (
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
      )}
    </div>
  )
}
