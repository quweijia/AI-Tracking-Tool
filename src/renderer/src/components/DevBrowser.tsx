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

/** 登录页 URL 特征：路径或主机名含常见登录段（auth 语义过宽不参与，避免 /author 误报） */
const LOGIN_URL_RE =
  /(?:^|[/\-.])(?:login|log-in|signin|sign-in|sign_in|signup|sign-up|register|sso|passport|authenticate|session-new)(?:[/\-.]|$)/i

/** 判断 URL 是否疑似登录页（自动走查登录检测与登录窗口默认成功启发式共用） */
export function isLoginUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return LOGIN_URL_RE.test(u.pathname) || LOGIN_URL_RE.test(u.hostname)
  } catch {
    return false
  }
}

export interface DevBrowserHandle {
  /** 重新加载当前页面 */
  reload: () => void
  /** 执行一次采集：滚动置顶 →（整页模式临时拉高）→ DOM 采集 → 截图 → 还原；designHeight 为设计稿高度（如 Figma 画板高度），提供时整页截图严格按该高度采集 */
  runCapture: (fullPage: boolean, designHeight?: number) => Promise<CaptureResult>
  /** 当前页面 URL（含站内跳转） */
  getUrl: () => string
  /** webview guest 进程的 webContentsId（未挂载返回 -1） */
  getWebContentsId: () => number
  /** 在页面内执行 JS 并返回结果（带 30s 超时） */
  evaluate: (code: string) => Promise<unknown>
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
  /** 每次真实 loadURL 前的钩子（同域名走查注入会话 profile），失败不阻断加载 */
  beforeLoad?: () => Promise<void>
  /** 站内导航回调（did-navigate，自动走查用于登录页检测） */
  onNavigated?: (url: string) => void
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 带超时的 executeJavaScript */
async function execJs(webview: Electron.WebviewTag, code: string, timeoutMs = 30000): Promise<unknown> {
  return Promise.race([
    webview.executeJavaScript(code),
    new Promise((_r, reject) => setTimeout(() => reject(new Error(tr('scriptTimeout', 'devBrowser'))), timeoutMs))
  ])
}

/** 加载 dataURL 图片（读取截图真实像素尺寸 / 拼接时绘制用） */
function loadImageEl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(tr('screenshotEmpty', 'devBrowser')))
    img.src = dataUrl
  })
}

/** 校正互斥队列：加载期（dom-ready）与采集期校正可能并发，setZoomFactor 互相覆盖会让
 * 探测值抖动不收敛——同一时刻只允许一个校正流程执行（后者排队等待前者完成，前者抛错不阻断队列） */
let layoutCalibrationQueue: Promise<unknown> = Promise.resolve()

/** guest 宽度自适应重算通知：rem/flexible 类自适应脚本按「校正前的过宽布局」计算字号/尺寸
 * 且不监听 resize（或 setZoomFactor 不触发 guest resize 事件），zoom 校正后保持陈旧——
 * 实测：视口宽 1588、环境漂移下加载期布局 ≈1737，页面按 1737 算导航 = 64×1737/1588 = 70px，
 * 校正回 1588 后导航仍定格 70。校正收敛后补发 resize + orientationchange（flexible.js 监听
 * 后者）让自适应脚本按新 innerWidth 重新计算 */
const RESIZE_DISPATCH_SCRIPT =
  'window.dispatchEvent(new Event("resize"));window.dispatchEvent(new Event("orientationchange"));true'

/** guest 布局自校正：截图与标注必须同以设计基准宽（cssWidth）为坐标系，因此
 * guest 布局宽（innerWidth）必须等于 cssWidth。个别运行环境下嵌入器给 guest 的表面宽
 * 可能与元素布局尺寸失配（表面宽残留在缩放前值、zoom 与元素尺寸不同步等），此时页面会
 * 按更宽视口重排 → 截图内容相对设计稿整体缩小（实测：设计 64px 导航在开发截图中测出
 * 54px = 64×displayScale）。本函数按实测反推需要的 zoom（= 实测表面宽 / cssWidth，其中
 * 实测表面宽 = innerWidth × 当前 zoom 恒成立）重新应用，返回生效 zoom（调用方以
 * dpr × 该值作为采集像素密度）。健康环境（元素 = 视口×displayScale 且
 * zoom = displayScale）需要值恒等于现值，此处为无操作。
 *
 * allowFix 双语义（修复「点击捕捉瞬间页面放大一下 → 观感刷新 → 白屏」）：
 * - true（加载期，dom-ready 后调用）：最多 2 轮迭代收敛，把 zoom 跳变留在页面刚加载
 *   阶段完成（此时用户注意力在加载中，跳变不显眼）；不收敛不抛错（页面可能仍在渲染），
 *   交给采集期最终校验；
 * - false（采集期，runCapture 路径调用）：失配时仅允许一次校正 + 更长沉降等待后复验，
 *   仍失配即中止报错——绝不产出视口失真的截图（内容放大/缩小、白屏）。 */
async function ensureGuestLayoutWidth(webview: Electron.WebviewTag, cssWidth: number, allowFix = false): Promise<number> {
  // 排队等待进行中的校正完成
  const prev = layoutCalibrationQueue
  let release = (): void => undefined
  layoutCalibrationQueue = new Promise<void>((resolveRelease) => {
    release = resolveRelease
  })
  await prev.catch(() => undefined)
  try {
    const probe = async (): Promise<{ iw: number; zoom: number }> => ({
      iw: Number(await execJs(webview, 'window.innerWidth')),
      zoom: webview.getZoomFactor()
    })
    let { iw, zoom } = await probe()
    // 已收敛（含健康环境）：直接返回现值，无操作、无视觉跳变
    if (Math.abs(iw - cssWidth) <= 2) return zoom
    const applyFix = async (): Promise<void> => {
      const needed = (iw * zoom) / cssWidth
      console.log(`[DevBrowser] guest 布局自校正: innerWidth=${iw} 目标=${cssWidth}，zoom ${zoom} -> ${needed}`)
      webview.setZoomFactor(needed)
      // 采集期给更长沉降时间：setZoom 引发 guest 重排 + 合成器重光栅化，等稳后再复验/截图
      await wait(allowFix ? 300 : 600)
      // 通知宽度自适应脚本按校正后的布局宽重算（见 RESIZE_DISPATCH_SCRIPT 注释），再留出
      // 重排沉降后复验——否则探测的 innerWidth 已收敛但页面内容仍按校正前宽度渲染
      await execJs(webview, RESIZE_DISPATCH_SCRIPT).catch(() => undefined)
      await wait(allowFix ? 150 : 300)
      ;({ iw, zoom } = await probe())
    }
    if (!allowFix) {
      // 采集期：一次校正机会（正常时加载期已收敛，此处仅为环境漂移兜底），复验失败即中止
      await applyFix()
      if (Math.abs(iw - cssWidth) > 2) {
        throw new Error(`${tr('guestLayoutMismatch', 'devBrowser')}（实测 innerWidth=${iw}，目标=${cssWidth}）`)
      }
      return zoom
    }
    // 加载期：最多 2 轮迭代收敛；不收敛不抛错（交给采集期最终校验）
    for (let round = 0; round < 2 && Math.abs(iw - cssWidth) > 2; round++) {
      await applyFix()
    }
    return zoom
  } finally {
    release()
  }
}

/** 截图期粘性/悬浮/平滑滚动抑制：fixed 转 absolute 钉在其 suppress 时刻的文档位置、
 * sticky 还原为文档位置静止渲染、html scroll-behavior 强制 auto（CSS smooth 会让
 * window.scrollTo 动画化，等待窗口内截图截在动画中途 → 切片重叠漂移，ant.design 台架实证）。
 * suppress 在 scrollY=0 时执行，fixed 的视口坐标即文档坐标，钉位后与浏览器顶部视角一致：
 * 导航栏等 fixed 内容整页只渲染一次、不再消失（旧实现 visibility:hidden 直接丢失内容，
 * deepseek 台架实证），且消除拼接输出在每个接缝重复头部条的问题。fixed 本就脱离文档流，
 * absolute 同样不改文档流，其余元素布局与 DOM 标注坐标不受影响 */
const STICKY_SUPPRESS_SCRIPT = `(() => {
  const saved = []
  const html = document.documentElement
  saved.push({ el: html, prop: 'scroll-behavior', orig: html.style.getPropertyValue('scroll-behavior') })
  html.style.setProperty('scroll-behavior', 'auto')
  // 关闭滚动锚定：截图前图片/字体解码 + 懒加载撑高页面时，浏览器会为「保持视觉位置」
  // 自动改写 scrollY（实测偏移量可达数十 px）→ 截图落点与目标不一致，拼接接缝重复。
  // overflow-anchor 不继承，html 与 body 都要关（个别页面滚动容器为 body）
  saved.push({ el: html, prop: 'overflow-anchor', orig: html.style.getPropertyValue('overflow-anchor') })
  html.style.setProperty('overflow-anchor', 'none')
  if (document.body) {
    saved.push({ el: document.body, prop: 'overflow-anchor', orig: document.body.style.getPropertyValue('overflow-anchor') })
    document.body.style.setProperty('overflow-anchor', 'none')
  }
  document.querySelectorAll('body, body *').forEach((el) => {
    const p = getComputedStyle(el).position
    if (p === 'fixed') {
      const cs = getComputedStyle(el)
      // 已不可见的 fixed 元素钉位无意义，跳过
      if (cs.display === 'none' || cs.visibility === 'hidden') return
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) return
      // 最近定位祖先（absolute 偏移基准）；无则相对文档（基准为 0）
      let anc = null
      for (let n = el.parentElement; n; n = n.parentElement) {
        if (getComputedStyle(n).position !== 'static') { anc = n; break }
      }
      const aR = anc ? anc.getBoundingClientRect() : null
      const top = Math.round(r.top - (aR ? aR.top : 0))
      const left = Math.round(r.left - (aR ? aR.left : 0))
      saved.push({
        el,
        styles: {
          position: el.style.getPropertyValue('position'),
          top: el.style.getPropertyValue('top'),
          left: el.style.getPropertyValue('left'),
          right: el.style.getPropertyValue('right'),
          bottom: el.style.getPropertyValue('bottom'),
          margin: el.style.getPropertyValue('margin'),
          width: el.style.getPropertyValue('width'),
          height: el.style.getPropertyValue('height')
        }
      })
      el.style.setProperty('position', 'absolute')
      el.style.setProperty('top', top + 'px')
      el.style.setProperty('left', left + 'px')
      // margin 置零让边框盒精确落在钉位坐标；宽高取计算值字符串（含 box-sizing 语义）保证尺寸一致
      el.style.setProperty('margin', '0')
      el.style.setProperty('width', cs.width)
      el.style.setProperty('height', cs.height)
      el.style.removeProperty('right')
      el.style.removeProperty('bottom')
    } else if (p === 'sticky') {
      saved.push({ el, prop: 'position', orig: el.style.getPropertyValue('position') })
      el.style.setProperty('position', 'static')
    }
  })
  window.__tjWalkShotSaved = saved
  return saved.length
})()`

const STICKY_RESTORE_SCRIPT = `(() => {
  ;(window.__tjWalkShotSaved || []).forEach((item) => {
    if (item.styles) {
      Object.keys(item.styles).forEach((prop) => {
        const orig = item.styles[prop]
        if (orig) item.el.style.setProperty(prop, orig)
        else item.el.style.removeProperty(prop)
      })
    } else if (item.prop) {
      if (item.orig) item.el.style.setProperty(item.prop, item.orig)
      else item.el.style.removeProperty(item.prop)
    }
  })
  const mo = document.getElementById('__tjWalkMotionOff')
  if (mo) mo.remove()
  window.__tjWalkShotSaved = null
  return true
})()`

/** 动画瞬时化：滚动入场动画（IntersectionObserver 触发的 CSS 渐显/位移等）在截图瞬间
 * 尚未播完会截到半透明/偏移中间态 → footer 等内容看似「缺失」（deepseek 台架实证）。
 * 强制所有 CSS 动画/过渡时长为 0s，元素一旦触发立即呈现终态；还原时随 STICKY_RESTORE
 * 移除该样式。JS 逐帧驱动的动画（framer-motion 等）不受 CSS 时长影响，由 SETTLE_WAIT
 * 沉降等待覆盖（once:true 的入场动画在等待期间播完） */
const MOTION_OFF_SCRIPT = `(() => {
  if (document.getElementById('__tjWalkMotionOff')) return true
  const s = document.createElement('style')
  s.id = '__tjWalkMotionOff'
  s.textContent =
    '*,*::before,*::after{animation-duration:0s !important;animation-delay:0s !important;transition-duration:0s !important;transition-delay:0s !important}'
  document.head.appendChild(s)
  return true
})()`

/** 采集沉降等待：截图前确保页面进入稳定终态——字体加载完成（字体切换引发重排/文字闪变）、
 * 图片解码完成（未解码截到空白块）、渲染帧提交；各项带竞速上限（字体 1s / 图片 1.5s /
 * 末尾沉降 800ms），卡死资源不阻塞采集。必须在预热滚动之后、内容高实测之前调用
 * （动画与图片加载可能继续撑高页面，contentSh 依赖其后实测） */
const SETTLE_WAIT_SCRIPT = `(async () => {
  const done = (ms) => new Promise((r) => setTimeout(r, ms))
  try { await Promise.race([document.fonts ? document.fonts.ready : null, done(1000)]) } catch (e) {}
  const decodeAll = Promise.all(
    Array.from(document.images || []).map((img) =>
      new Promise((r) => { try { img.decode().catch(() => {}).then(() => r(null)) } catch (e) { r(null) } }))
  )
  try { await Promise.race([decodeAll, done(1500)]) } catch (e) {}
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
  await done(800)
  return true
})()`

/** 内容实际高度探测（html/body scrollHeight 取大） */
const SH_PROBE = 'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)'

/** 滚动到位校验：CSS/JS 平滑滚动、滚动锚定会让 scrollTo 后 scrollY 偏离目标——
 * 截图截在动画/偏移中途 → 拼接接缝内容漂移重复（ant.design 台架与用户环境均实证）。
 * 轮询 scrollTo 直至连续两次读数一致（稳定）或已等于目标（最多 12 次 × 120ms），返回最终落点 */
const scrollLandedScript = (target: number): string =>
  `(async()=>{let yy=0,prev=NaN;for(let i=0;i<12;i++){window.scrollTo(0,${target});await new Promise(r=>setTimeout(r,120));yy=window.scrollY||0;if(Math.abs(yy-${target})<=1||yy===prev)break;prev=yy}return yy})()`

/** 合成器沉降等待：主线程 scrollY 已落位 ≠ 合成器表面已呈现新帧——大距离瞬时跳变后
 * 立即 capturePage 会拿到跳变前旧帧（台架实证：滚回顶部后首片捕到页尾 footer 放到页顶）。
 * 双 RAF 确保渲染器完成新帧布局绘制，再等 150ms 供合成器呈现 */
const COMPOSITOR_SETTLE_SCRIPT =
  '(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,150))))})()'

/** 合成器活性探针标记：3×3px 半透明黑点钉在视口左上角（fixed 不占布局、z-index 最大、
 * pointer-events:none 不影响页面交互）。注入/移除各截一帧做位图差分——标记变化必然产生
 * 像素差异，是「合成器是否正在呈现页面变化」的可测命题。标记只存在于被丢弃的探针帧中，
 * 采纳帧已移除标记，输出图无残留 */
const SHOT_MARK_ON_SCRIPT = `(() => {
  let d = document.getElementById('__tjShotMark')
  if (!d) {
    d = document.createElement('div')
    d.id = '__tjShotMark'
    d.style.cssText = 'position:fixed;left:0;top:0;width:3px;height:3px;z-index:2147483647;pointer-events:none;background:rgba(0,0,0,0.03)'
    document.documentElement.appendChild(d)
  }
  return true
})()`
const SHOT_MARK_OFF_SCRIPT = `(() => { const d = document.getElementById('__tjShotMark'); if (d) d.remove(); return true })()`

/** 新鲜帧截图（合成器活性探针）：主动差分验证，消灭「惰性旧帧」盲区。
 * 旧 captureStable 的「连续两帧位图一致 = 已稳定」存在固有盲区：合成器完全未呈现任何
 * 新帧时，连续两帧都是同一旧帧 → 位图一致被误判为「已收敛」→ 截图内容停留在上一个
 * 滚动位置（如页顶 hero），拼接输出把同一段内容整片重复（deepseek 重页面 + 隐藏采集
 * 画板 opacity:0 下 guest 合成器对不可见图层的重光栅化惰性，1:1 webview 台架实证）。
 * 改为：注入标记截 A、移除标记截 B——A≠B 证明合成器正在呈现页面变化，B 必然是标记
 * 移除后的新鲜帧（采纳 B）；A==B 说明合成器未呈现任何变化，截到的可能是任意旧帧 →
 * 等待重试；达上限仍惰性 → 中止报错，绝不产出内容重复的截图。
 * 页面存在持续动画时 A 与 B 因动画本身必不一致，行为等价于取最新帧 */
async function captureFresh(
  webview: Electron.WebviewTag,
  rect: Electron.Rectangle,
  maxRounds = 6
): Promise<Electron.NativeImage> {
  for (let round = 1; round <= maxRounds; round++) {
    await execJs(webview, SHOT_MARK_ON_SCRIPT)
    await execJs(webview, COMPOSITOR_SETTLE_SCRIPT)
    const withMark = await webview.capturePage(rect)
    await execJs(webview, SHOT_MARK_OFF_SCRIPT)
    await execJs(webview, COMPOSITOR_SETTLE_SCRIPT)
    const withoutMark = await webview.capturePage(rect)
    // 差分数据源用 PNG dataURL 字符串（而非 toBitmap/toPNG 原始字节）：实测部分环境
    // （GPU 读回路径）下对 capturePage 图像调 toBitmap/toPNG 提取原始像素会触发渲染
    // 进程 V8 致命错误（v8_initializer.cc Empty MaybeLocal，exitCode 5 → 整窗白屏），
    // dataURL 提取路径正常。同帧两幅图 PNG 编码字节恒一致，字符串比较差分语义不变
    const a = withMark.toDataURL()
    const b = withoutMark.toDataURL()
    const fresh = a !== b
    if (fresh) return withoutMark
    // 合成器惰性：等待后重试（重页面光栅化排满时合成器需要更长时间唤醒）
    if (round < maxRounds) await wait(300)
  }
  console.log(`[DevBrowser] 合成器活性探针 ${maxRounds} 轮未通过，中止截图避免内容重复`)
  throw new Error(tr('compositorStale', 'devBrowser'))
}

/**
 * 滚动分段截图 + 纵向拼接（不拉伸 webview，保持原始视口布局）：
 * 拉伸 webview 会导致 flex/grid/sticky 等布局重排，DOM 坐标与原始布局不符 → 标注错位。
 * 改为：webview 保持原始视口 → 滚动到目标位置 → 截取视口区域 → 拼成整页图。
 * DOM 采集在正常视口下进行（getBoundingClientRect + scrollY = 文档坐标），与截图布局完全一致。
 *
 * 为什么不用 CDP「整页单帧」：guest 合成器只完整光栅化可视窗口区域，捕获表面（Emulation
 * 扩视口 / captureBeyondViewport）超出该区域时以旧视口 tile 平铺填充——页面越长越必现，
 * 且与 dpr、deviceScaleFactor 无关（台架实证见 debug-dev-shot-repeat.md 第 4 轮），
 * 故整页一律走滚动拼接。
 *
 * 拼接质量四件套：
 * 1. 预热滚动：整页先滚一遍触发懒加载/瀑布流展开，复测内容实际高（懒加载常使复测高于
 *    首测，必须以复测为准，否则页尾截断）；
 * 2. 粘性抑制 + 动画瞬时化 + 沉降等待：fixed 转 absolute 钉在 suppress 时刻的文档位置
 *    （不再隐藏，导航栏等 fixed 内容与浏览器顶部视角一致）、CSS 动画/过渡时长归零、
 *    字体/图片解码沉降——见 STICKY_SUPPRESS_SCRIPT / MOTION_OFF_SCRIPT / SETTLE_WAIT_SCRIPT；
 * 3. 首片实测校正：capturePage(rect) 返回图片高度受「可合成区」限制——隐藏画板虽已钳制
 *    到 window.innerHeight，真实合成区仍可能更小（标题栏/安全区遮挡等），返回图片比声明
 *    rect 矮，若按声明高度拼接会把矮图拉伸 → 整图垂直畸变 → 标注越往下越偏上。以首片
 *    图片宽高反推实际可用视口高度（pxScale = 图片宽/cssWidth，realVh = 图片高/pxScale），
 *    后续单片与拼接统一按实测高度；健康环境 realVh ≈ vh 行为不变。首片直接复用为第 0 片。
 * 4. 滚动到位校验 + 实测落点取样：每片用 scrollLandedScript 轮询到稳定落点后截图，并在
 *    截图后复测真实 scrollY（滚动锚定 / 页面 JS 惯性滚动会在截图期间改写滚动位置）。
 *    拼接按「目标起点 - 截图实际起点」计算片内取样偏移：正常 0（取顶部段）、目标超过
 *    最大滚动位（钳底）取偏下段、截图漂移时自动跳过 / 钳顶对齐——旧实现只做 fromBottom
 *    二元判定，中间片未真正到位时仍取顶部段 → 接缝重复一段（用户环境实证）。
 *    同时在抑制脚本里关闭 overflow-anchor，从源头消除懒加载撑高页面引起的 scrollY 漂移。
 *
 * 捕获总高语义：captureHeight 由调用方给定（设计基准高或实测内容高），输出图严格等于
 * 该高度；内容实际高独立追踪——捕获区 < 内容 → 按基准截断；捕获区 > 内容 → 超出段按
 * 页面背景色填充；返回 scrollHeight 恒等于 captureHeight（= 归一化分母），标注与截图
 * 基准恒一致。
 */
async function captureTallPage(
  webview: Electron.WebviewTag,
  cssWidth: number,
  captureHeight: number,
  dpr: number,
  viewportHeight: number,
  displayScale: number
): Promise<{ dataUrl: string; scrollHeight: number }> {
  // guest 布局自校正（见 ensureGuestLayoutWidth）：未校正时漂移环境下页面按更宽视口
  // 重排，截图内容相对设计稿整体缩小；生效 zoom 同时决定采集像素密度
  const effZoom = await ensureGuestLayoutWidth(webview, cssWidth)
  // 捕获总高：输出 canvas 高度（设计基准高或实测内容高），恒为正
  const total = Math.max(1, Math.floor(captureHeight))
  // 单片高度先按声明视口取初值，预热后按内容覆盖高校正
  let vh = Math.max(1, Math.floor(Math.min(total, viewportHeight > 0 ? viewportHeight : total)))

  // 粘性/悬浮抑制套用（结束在 finally 还原）
  await execJs(webview, STICKY_SUPPRESS_SCRIPT)
  try {
    // 动画瞬时化：CSS 动画/过渡时长归零，预热滚动触发的入场动画立即呈现终态
    await execJs(webview, MOTION_OFF_SCRIPT)
    // 1. 预热滚动：逐屏滚到底触发懒加载；滚过当前底部且高度连续两屏不变 → 展开完毕
    let prev = -1
    let y = 0
    const step = Math.max(300, Math.floor(vh * 0.8))
    for (let guard = 0; guard < 80; guard++) {
      await execJs(webview, `window.scrollTo(0, ${y}); true`)
      await wait(100)
      const sh = Math.floor(Number(await execJs(webview, SH_PROBE)))
      if (y >= sh && sh === prev) break
      prev = sh
      y += step
    }
    // 采集沉降：字体/图片解码与渲染帧就绪后再继续（动画/图片加载可能继续撑高页面，
    // contentSh 必须在其后实测，否则页尾截断或截到渐显中间态）
    await execJs(webview, SETTLE_WAIT_SCRIPT)
    // 内容实际高：懒加载展开后的真实整页高度（独立于捕获总高追踪）
    let contentSh = Math.max(1, Math.floor(Number(await execJs(webview, SH_PROBE))))
    // 内容覆盖高：捕获区内实际有内容的部分（捕获区 > 内容时超出段按背景填充）
    let contentCover = Math.min(total, contentSh)
    vh = Math.max(1, Math.floor(Math.min(contentCover, viewportHeight > 0 ? viewportHeight : contentCover)))

    // 首片落位硬校验：滚回顶部必须真正到位（重试 3 轮），且截图时刻 scrollY 仍为 0——
    // 否则首片会把页尾/中段内容放到页顶，后续全部错位
    let probeLanded = -1
    let probeShot = -1
    let probeUrl = ''
    for (let i = 0; i < 3; i++) {
      probeLanded = Math.floor(Number(await execJs(webview, scrollLandedScript(0))))
      if (probeLanded > 1) continue
      await execJs(webview, COMPOSITOR_SETTLE_SCRIPT)
      probeUrl = (await captureFresh(webview, { x: 0, y: 0, width: cssWidth, height: vh })).toDataURL()
      if (!probeUrl || probeUrl.length < 1000) throw new Error(tr('screenshotEmpty', 'devBrowser'))
      probeShot = Math.floor(Number(await execJs(webview, 'window.scrollY||0')))
      if (probeShot <= 1) break
    }
    if (probeLanded > 1 || probeShot > 1) throw new Error(tr('scrollTopStuck', 'devBrowser'))
    const probeImg = await loadImageEl(probeUrl)
    const pxScale = probeImg.naturalWidth > 0 ? probeImg.naturalWidth / cssWidth : 0
    const realVh = pxScale > 0 ? Math.floor(probeImg.naturalHeight / pxScale) : 0
    if (realVh > 0 && realVh < vh) vh = Math.max(1, realVh)

    const slices: { url: string; cssHeight: number; startCss: number }[] = [
      { url: probeUrl, cssHeight: Math.min(vh, contentCover), startCss: 0 }
    ]
    let offset = Math.min(vh, contentCover)
    let sliceGuard = 0

    while (offset < contentCover) {
      // 兜底防死循环：页面滚动被外部脚本持续干扰时，单页切片段数不应超过该上限
      if (++sliceGuard > 120) {
        console.warn('[DevBrowser] 截图分段超出上限，停止采集（页面滚动可能被外部脚本锁定）')
        break
      }
      let h = Math.min(vh, contentCover - offset)
      let url = ''
      let shotScroll = 0
      // 每片：落位 → 等合成器出新帧 → 截图 → 复测截图时刻真实 scrollY。滚动锚定或页面
      // 自带的 JS 惯性滚动会在截图期间偷偷改写 scrollY（实测偏移可达数十 px），若仍按
      // 目标 offset 截段就会把相邻内容叠进来 → 接缝重复；偏离目标则重新落位重截
      for (let attempt = 0; attempt < 3; attempt++) {
        const landed = Math.floor(Number(await execJs(webview, scrollLandedScript(offset))))
        await execJs(webview, COMPOSITOR_SETTLE_SCRIPT)
        const image = await captureFresh(webview, { x: 0, y: 0, width: cssWidth, height: vh })
        url = image.toDataURL()
        if (!url || url.length < 1000) throw new Error(tr('screenshotEmpty', 'devBrowser'))
        shotScroll = Math.floor(Number(await execJs(webview, 'window.scrollY||0')))
        // 截图前后都要求落在目标上：前者保证截的是当前位置，后者保证截图期间没漂
        if (Math.abs(landed - offset) <= 1 && Math.abs(shotScroll - offset) <= 1) break
        console.warn(`[DevBrowser] 截图落点漂移：目标 ${offset}，截图前 ${landed}、截图后 ${shotScroll}，重试`)
      }
      // 视口内取样起点 = 目标起点 - 截图实际起点：正常为 0；目标超过最大滚动位被钳底时
      // 为正值（取视口偏下段，等价旧 fromBottom）；过冲（截图为更下方内容）为负 → 钳 0。
      // 未到位且视口内可用高度不足 h 时，本片只填能正确取样的部分，余量留给下一片
      // （偏移 h 后继续循环），避免重复采样
      let startCss = Math.max(0, offset - shotScroll)
      if (startCss > vh - h) {
        h = Math.max(1, vh - startCss)
        startCss = Math.min(startCss, Math.max(0, vh - h))
      }
      slices.push({ url, cssHeight: h, startCss })
      offset += h
      // 每片后重测内容高（懒加载可能在截图过程中继续展开），钳底判定与覆盖范围随之更新
      const shNow = Math.floor(Number(await execJs(webview, SH_PROBE)))
      if (shNow > contentSh) {
        contentSh = shNow
        contentCover = Math.min(total, contentSh)
      }
    }

    // 还原粘性/悬浮抑制（DOM 采集在还原后的原始视口下进行，坐标与截图严格同帧）
    await execJs(webview, STICKY_RESTORE_SCRIPT)
    // 滚回顶部
    await execJs(webview, scrollLandedScript(0))

    // 拼接输出：超高时等比缩小（标注坐标为归一化 0~1 值，与分辨率无关）。
    // 采集像素密度 = dpr × 生效 zoom（guest setZoomFactor 后每页面 CSS px 渲染为
    // dpr×zoom 物理像素，首片 pxScale 探针实测同值），按它输出即 1:1 拷贝无插值；
    // displayScale 仅作校正流程异常时的兜底
    const maxSide = 16000
    const outScale = Math.min((dpr || 1) * (effZoom || displayScale || 1), maxSide / total)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(cssWidth * outScale)
    canvas.height = Math.round(total * outScale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    // 关闭图像平滑（最近邻）：outScale 与片内实际缩放比非严格相等（逐片 Math.round 取整 +
    // 校正 zoom/dpr 非整数）时，双线性平滑会把每个像素与邻居混合 → 整图颜色系统性偏移 1~2，
    // 设计稿/开发截图吸色标注的色值对不上；最近邻直接取源像素值，吸色所见即所得
    ctx.imageSmoothingEnabled = false
    // 捕获总高 > 内容实际高时，超出段按页面背景色填充（body 优先、html 兜底、白底保底，
    // 与旧整页单帧行为一致）
    let bg = '#ffffff'
    try {
      const probed = String(
        await execJs(
          webview,
          `(function(){function bgOf(el){if(!el)return null;try{var c=getComputedStyle(el).backgroundColor;return c&&c!=='rgba(0, 0, 0, 0)'&&c!=='transparent'?c:null}catch(e){return null}}return bgOf(document.body)||bgOf(document.documentElement)||'#ffffff'})()`
        )
      )
      if (probed) bg = probed
    } catch {
      // 保底白色
    }
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    let y2 = 0
    for (const slice of slices) {
      const img = await loadImageEl(slice.url)
      const dy0 = Math.round(y2 * outScale)
      const dy1 = Math.round((y2 + slice.cssHeight) * outScale)
      // 源图实际缩放比 = 像素高 / 视口 css 高；按该片实测取样起点（startCss）取段，
      // 钳底片取视口偏下段、普通片取顶部段、过冲片钳顶部——保证接缝不重复不跳段
      const srcScale = img.naturalHeight / vh
      const syCss = Math.min(Math.max(0, slice.startCss), Math.max(0, vh - slice.cssHeight))
      const sy = Math.round(syCss * srcScale)
      const sh = Math.min(img.naturalHeight - sy, Math.max(1, Math.round(slice.cssHeight * srcScale)))
      ctx.drawImage(img, 0, sy, img.naturalWidth, sh, 0, dy0, canvas.width, Math.max(1, dy1 - dy0))
      y2 += slice.cssHeight
    }
    // 返回 scrollHeight = 捕获总高（= 归一化分母），标注与截图基准恒一致
    const out = canvas.toDataURL('image/png')
    return { dataUrl: out, scrollHeight: total }
  } finally {
    // 抑制未还原（中途抛错）时兜底还原；页面已跳转时脚本为空操作
    await execJs(webview, STICKY_RESTORE_SCRIPT).catch(() => undefined)
  }
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
  { url, viewport, displayScale, onFail, onLoadingChange, hideBar, hideScrollbar, beforeLoad, onNavigated },
  ref
) {
  const { t } = useTranslation('devBrowser')
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  /** 当前显示的 URL（含站内跳转） */
  const [currentUrl, setCurrentUrl] = useState(url)
  /** 初始 src 固定 about:blank：确保挂载即 attach（空 src 永不 attach）；真实 URL 一律经 url-effect
   *  → did-attach → doLoad 加载，保证首次加载也走 beforeLoad 注入（会话 profile） */
  const initialSrc = useRef('about:blank')
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
  /** 加载序号：beforeLoad 异步钩子完成后校验，防止旧的异步加载覆盖新的导航 */
  const loadSeqRef = useRef(0)
  /** 回调经 ref 转发，避免闭包过期（父组件每次渲染更新） */
  const beforeLoadRef = useRef(beforeLoad)
  beforeLoadRef.current = beforeLoad
  const onNavigatedRef = useRef(onNavigated)
  onNavigatedRef.current = onNavigated
  /** 显示缩放 ref：事件回调（deps [t] 的挂载 effect）内取最新值，避免陈旧闭包 */
  const displayScaleRef = useRef(displayScale)
  displayScaleRef.current = displayScale
  /** 视口 ref：dom-ready 加载期布局校正用（同上，effect 注册时闭包会过期） */
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport

  /** guest 内容缩放 = 显示缩放：webview 元素已按视觉尺寸摆放（无 transform），guest 布局宽
   * = 元素宽 / zoom 恒等于设计视口宽；仅缩放渲染密度，不改变布局与 DOM 坐标 */
  const applyZoom = (wv: Electron.WebviewTag): void => {
    try {
      wv.setZoomFactor(displayScaleRef.current)
    } catch {
      // attach 前调用会抛错：忽略，did-attach 后会再应用
    }
  }

  /** displayScale 变化时同步 guest 缩放：zoom 原本只在 dom-ready 应用一次，而舞台尺寸
   * 测量（ResizeObserver）晚于首次加载时二者失配（innerWidth ≠ 设计视口宽），直到采集时
   * ensureGuestLayoutWidth 才集中校正——表现为点击截图瞬间页面可见地放大/缩小一下。
   * 实时跟随同步后校正恒等于现值（无操作），消除采集瞬间的跳变 */
  useEffect(() => {
    const wv = webviewRef.current
    if (ready && wv) applyZoom(wv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayScale, ready])

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

  const doLoad = async (wv: Electron.WebviewTag, target: string): Promise<void> => {
    if (!target) return
    const seq = ++loadSeqRef.current
    requestedUrlRef.current = target
    setReady(false)
    setLoadingState(true)
    // 真实加载前钩子：同域名走查注入会话 profile（Cookie + CDP 存储恢复脚本）
    if (beforeLoadRef.current) {
      try {
        await beforeLoadRef.current()
      } catch {
        // 注入失败不阻断加载（persist 分区可能仍有旧登录态）
      }
    }
    if (seq !== loadSeqRef.current) return // 期间发起了新的加载，本次作废
    wv.loadURL(target).catch((err: unknown) => {
      // ERR_FAILED(-2)：loadURL promise 与 did-fail-load 事件双路径同时触发；
      // 事件侧已有三级静默恢复（600ms 重载 → 切直连重载 → 才报错），
      // promise 侧保持静默，避免重试即将成功前先闪错误横幅
      const raw = err instanceof Error ? err.message : String(err)
      if (raw.includes('ERR_FAILED (-2)')) return
      const msg = t('loadFailedReason', { reason: raw })
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
      void doLoad(wv, url)
      return
    }
    pendingUrlRef.current = url
    const fallback = setTimeout(() => {
      if (pendingUrlRef.current === url && webviewRef.current) {
        attachedRef.current = true
        void doLoad(webviewRef.current, url)
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
      applyZoom(wv)
      if (pendingUrlRef.current) {
        void doLoad(wv, pendingUrlRef.current)
        pendingUrlRef.current = ''
      }
    }
    const handleDomReady = (): void => {
      // 每次导航后重新应用 guest 缩放（防个别页面/导航重置 zoom），先于布局校正保证
      // 校正探测时 zoom 已是基准值
      applyZoom(wv)
      // 初始 about:blank 的 dom-ready 不算加载完成
      if (requestedUrlRef.current) {
        markReady()
        // 加载期 guest 布局校正（E1 环境防御）：把 zoom 收敛放在页面刚加载阶段完成。
        // 若拖到点击捕捉时才校正，setZoomFactor 会让内容视觉尺寸连跳两次（「放大一下」），
        // 重排叠加滚顶/预热滚动被感知为「页面重新刷新」，中途 reload 还会导致切片白屏
        void ensureGuestLayoutWidth(wv, viewportRef.current.width, true).catch(() => undefined)
      }
      // 隐藏页面滚动条滑块（每次导航后需重新注入；页面仍可滚动）
      if (hideScrollbar) {
        wv.insertCSS('::-webkit-scrollbar{width:0!important;height:0!important}').catch(() => undefined)
      }
    }
    const handleStartLoading = (): void => setLoadingState(true)
    const handleStopLoading = (): void => setLoadingState(false)
    const handleNavigate = (e: Electron.DidNavigateEvent): void => {
      setCurrentUrl(e.url)
      onNavigatedRef.current?.(e.url)
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

  // displayScale 变化（窗口/面板 resize）→ 同步 guest zoom（元素尺寸由 JSX 同步，布局宽随之不变）
  useEffect(() => {
    const wv = webviewRef.current
    if (wv) applyZoom(wv)
  }, [displayScale])

  useImperativeHandle(ref, () => ({
    reload: () => {
      const webview = webviewRef.current
      if (!webview) return
      // 已加载真实页面：走 doLoad 重新加载，保证 beforeLoad（会话注入）再次执行；
      // 尚未真实加载（about:blank）：直接 reload
      let cur = ''
      try {
        cur = webview.getURL() || ''
      } catch {
        cur = ''
      }
      if (cur && cur !== 'about:blank') void doLoad(webview, cur)
      else webview.reload()
    },
    getUrl: () => {
      try {
        return webviewRef.current?.getURL() || ''
      } catch {
        return ''
      }
    },
    getWebContentsId: () => {
      try {
        return webviewRef.current?.getWebContentsId() ?? -1
      } catch {
        return -1
      }
    },
    evaluate: (code: string) => {
      const webview = webviewRef.current
      if (!webview) return Promise.reject(new Error(t('browserNotCreated')))
      return execJs(webview, code)
    },
    runCapture: async (fullPage: boolean, designHeight?: number): Promise<CaptureResult> => {
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
      // 0. 记录当前文档导航起点（performance.timeOrigin）：采集过程若 guest 发生
      //    reload/导航会更换文档，切片截图可能采到未渲染文档（白屏），截图完成后复查
      const timeOriginBefore = await execJs(webview, 'performance.timeOrigin')
        .then((v) => Number(v))
        .catch(() => 0)
      // 1. 滚动到顶部，保证坐标与截图一致
      await execJs(webview, 'window.scrollTo(0, 0); true')
      await wait(300)
      // 2. 获取文档实际高度（整页模式用）。
      //    拼接总高（= 归一化分母）按设计基准优先：传入 designHeight（Figma 画板/上传图
      //    高度）时整页截图严格按该高度采集——内容超出按基准截断、不足按页面背景填充，
      //    输出尺寸与设计稿画板一致；未传入时按实测内容高（手动整页截图行为不变）
      const contentSh = fullPage ? Math.min((await execJs(webview, SH_PROBE)) as number, 20000) : null
      const stitchTarget =
        fullPage && designHeight && designHeight > 0
          ? Math.min(Math.round(designHeight), 20000)
          : contentSh && contentSh > viewport.height
            ? contentSh
            : 0
      // webview 保持原始视口（不拉伸）：避免 flex/grid/sticky 布局重排导致 DOM 坐标偏移
      try {
        // 3. 截图（先截图后采 DOM）：CDP 整页单帧截图可能短暂触发视口重排，
        //    DOM 在截图完成、布局还原后的原始视口下采集，坐标与截图严格同帧
        let screenshotDataUrl: string
        let resultViewport: { width: number; height: number }
        const dpr = window.devicePixelRatio || 1
        if (stitchTarget > 0) {
          // 整页模式：滚动分段截图拼接（唯一主路径）。CDP captureBeyondViewport / Emulation
          // 扩视口的「整页单帧」会触发 guest 合成器表面光栅化限制——超出可视区的捕获表面以
          // 旧视口 tile 平铺填充，页面越长越必现且与 dpr/dsf 无关（台架实证
          // debug-dev-shot-repeat.md 第 4 轮 V14a-V14c），单帧路径整体废弃；
          // 预热滚动 + 粘性抑制 + 滚动到位校验消除拼接类伪影，详见 captureTallPage 注释。
          const stitched = await captureTallPage(
            webview,
            viewport.width,
            stitchTarget,
            dpr,
            viewport.height,
            displayScale
          )
          screenshotDataUrl = stitched.dataUrl
          // captureTallPage 返回 scrollHeight = 捕获总高（设计基准优先）= 归一化分母
          resultViewport = { width: viewport.width, height: stitched.scrollHeight || stitchTarget }
        } else {
          // 视口模式：单次截图（先做与整页模式一致的 guest 布局自校正）
          await ensureGuestLayoutWidth(webview, viewport.width)
          const image = await webview.capturePage()
          screenshotDataUrl = image.toDataURL()
          if (!screenshotDataUrl || screenshotDataUrl.length < 1000) {
            throw new Error(t('screenshotEmpty'))
          }
          // 以截图宽高比反推实际视口高（合成区小于声明视口时防止归一化分母偏大 → 标注偏上）
          const vpImg = await loadImageEl(screenshotDataUrl)
          const vpH =
            vpImg.naturalWidth > 0
              ? Math.round((vpImg.naturalHeight * viewport.width) / vpImg.naturalWidth)
              : viewport.height
          resultViewport = { width: viewport.width, height: vpH > 0 ? vpH : viewport.height }
        }
        // 3.5 reload 检测：文档已更换（导航起点变化）说明截图期间页面重新加载，截图内容
        //     不可信（白屏/半渲染）——中止报错让用户重试，绝不产出白屏图
        if (timeOriginBefore > 0) {
          const nowOrigin = await execJs(webview, 'performance.timeOrigin')
            .then((v) => Number(v))
            .catch(() => 0)
          if (nowOrigin > 0 && nowOrigin !== timeOriginBefore) throw new Error(t('captureReloaded'))
        }
        // 4. DOM 采集（截图完成后在原始视口下采集，坐标 = getBoundingClientRect + scrollY = 文档坐标）
        const raw = (await execJs(webview, getDomCollectScript())) as string
        const parsed = JSON.parse(raw) as {
          ok: boolean
          message?: string
          root?: StyleNode
          collected?: number
          skipped?: number
        }
        if (!parsed.ok || !parsed.root) throw new Error(parsed.message ?? t('domCollectFailed'))
        return {
          domRoot: parsed.root,
          screenshotDataUrl,
          viewport: resultViewport,
          collected: parsed.collected ?? 0,
          skipped: parsed.skipped ?? 0
        }
      } finally {
        // 滚回顶部（captureTallPage 内部已滚动，保险起见）
        await execJs(webview, 'window.scrollTo(0, 0); true').catch(() => undefined)
      }
    }
  }))

  const displayHeight = viewport.height * displayScale

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
      {/* 舞台与 webview 元素均按视觉尺寸摆放（不用 transform：Electron v33 嵌入器按元素
          变换后 boundingRect 给 guest setBounds，transform: scale 会把 guest 视口缩成
          视口宽×displayScale（如 1920→≈1617），采集被钳到该宽后再拉伸回画布 → 内容整体
          放大且右/底裁失。改为 setZoomFactor(displayScale) 缩放 guest 内容：guest 布局宽
          = 元素宽 / zoom = 设计视口宽不变，视觉缩小由 guest 渲染完成，采集宽=元素宽 */}
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
            width: viewport.width * displayScale,
            height: viewport.height * displayScale
          }}
        />
        {!url && <div className="dev-browser-empty">{t('emptyUrlHint')}</div>}
        {error && <div className="dev-browser-error">{error}</div>}
      </div>
    </div>
  )
})

export default DevBrowser
