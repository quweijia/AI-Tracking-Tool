/**
 * Figma REST 只读通道：
 * - GET /v1/files/{key}/nodes?ids= 拉取目标 Frame 图层树，归一化为 StyleNode
 * - GET /v1/images/{key} 渲染 Frame PNG 截图并下载转 dataUrl
 * 不修改 Figma 文件；PAT 复用 MCP 配置中的令牌。
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import type { Socket } from 'node:net'
import type { StyleNode } from '../shared/types'
import { figmaColorToHex } from '../shared/color'

const FIGMA_API = 'https://api.figma.com/v1'
/** 节点数量与深度上限：防止超大设计稿拖垮比对（超出部分跳过并在 message 提示） */
const MAX_NODES = 1500
const MAX_DEPTH = 12

/* ===== 代理自适应网络层（Node 原生 CONNECT 隧道，与 curl 行为一致）=====
 * 直连 figma.com / 其截图 CDN（s3-alpha.figma.com）在国内网络会被重置。
 * Electron session 代理对 ClashX 等本地代理会偶发 SSL 握手被重置（ERR_CONNECTION_RESET），
 * 故改用 Node http CONNECT 隧道 + TLS：依次尝试 自定义代理 → 环境变量代理 → 本机常用端口 → 直连。
 */
/** undefined = 未探测；探测成功后缓存复用，失败时清空重新探测 */
let cachedProxy: string | null | undefined
/** 用户在 MCP 管理中为服务配置的自定义代理（优先于系统代理），空串 = 未配置 */
let customProxy = ''

/** 设置自定义代理地址（每次 Figma 请求前由 ipc 层按配置刷新；仅当代理变更时清除探测缓存重新探测） */
export function setFigmaCustomProxy(proxy: string): void {
  const next = ((proxy ?? '').trim() || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '')
  if (next !== customProxy) {
    customProxy = next
    cachedProxy = undefined // 仅变更时清除缓存
  }
}

const stripScheme = (s: string) => s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '')

function proxyCandidates(): (string | null)[] {
  const env =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ''
  const list: (string | null)[] = []
  if (customProxy) list.push(customProxy) // 1. 用户自定义代理（MCP 管理配置）
  if (env) list.push(stripScheme(env)) // 2. 环境变量代理
  const local = '127.0.0.1:7890' // 3. 本机常用代理兜底（ClashX 等）
  if (!list.includes(local)) list.push(local)
  list.push(null) // 4. 直连兜底
  return list
}

/** 代理链提示文案（列出已尝试的策略，便于定位网络问题） */
function proxyChainHint(): string {
  const parts = proxyCandidates().map((p) => {
    if (!p) return '直连'
    if (p === '127.0.0.1:7890') return '本机代理 127.0.0.1:7890'
    return `代理 ${p}`
  })
  return (
    `已依次尝试 ${parts.join(' → ')}。` +
    '若浏览器能打开 Figma 而应用不行，通常是代理未作用于本应用：请在「设置 → MCP 管理」编辑 Figma 服务，填写可用代理地址（如 http://127.0.0.1:7890 或公司内网代理）后重试'
  )
}

/** 通过 HTTP 代理向目标发起 CONNECT 隧道，返回隧道原始 socket（与 curl 行为一致） */
function connectViaProxy(proxy: string, host: string, port: number, timeoutMs: number): Promise<Socket> {
  const idx = proxy.lastIndexOf(':')
  const ph = idx > 0 ? proxy.slice(0, idx) : proxy
  const pp = idx > 0 ? Number(proxy.slice(idx + 1)) : 80
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: ph,
      port: pp,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
      timeout: timeoutMs
    })
    req.once('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket)
      else {
        socket.destroy()
        reject(new Error(`代理 CONNECT 失败（HTTP ${res.statusCode}）`))
      }
    })
    req.once('timeout', () => req.destroy(new Error('代理连接超时')))
    req.once('error', reject)
    req.end()
  })
}

/** 单次 HTTP(S) 请求（可经 CONNECT 隧道），跟随重定向，返回 web Response */
async function nodeFetchOnce(
  url: string,
  init: RequestInit & { headers?: Record<string, string> },
  proxy: string | null,
  timeoutMs: number,
  depth = 0
): Promise<Response> {
  const u = new URL(url)
  const isHttps = u.protocol === 'https:'
  const targetPort = Number(u.port) || (isHttps ? 443 : 80)
  const method = (init.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  const hasBody = typeof init.body === 'string'
  if (hasBody) headers['Content-Length'] = String(Buffer.byteLength(init.body as string))

  // 需要代理时先建立 CONNECT 隧道
  const tunnel = proxy ? await connectViaProxy(proxy, u.hostname, targetPort, timeoutMs) : undefined

  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      tunnel?.destroy()
      reject(new Error('请求超时'))
    }, timeoutMs)
    const opts: import('node:http').RequestOptions & { servername?: string } = {
      hostname: u.hostname,
      port: targetPort,
      path: `${u.pathname}${u.search}`,
      method,
      headers,
      agent: false,
      servername: u.hostname
    }
    if (tunnel) {
      // https 目标在隧道 socket 上做 TLS；http 目标直接使用隧道
      opts.createConnection = isHttps
        ? () => tlsConnect({ socket: tunnel, servername: u.hostname })
        : () => tunnel
    }
    const sender = isHttps ? httpsRequest : httpRequest
    const req = sender(opts as Parameters<typeof sender>[0] & typeof opts, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        clearTimeout(timer)
        const status = res.statusCode ?? 0
        const loc = res.headers.location
        if ([301, 302, 303, 307, 308].includes(status) && loc && depth < 3) {
          // 跟随重定向（最多 3 次）
          nodeFetchOnce(new URL(loc, url).toString(), init, proxy, timeoutMs, depth + 1).then(resolve, reject)
          return
        }
        resolve(
          new Response(Buffer.concat(chunks), {
            status,
            headers: res.headers as unknown as Record<string, string>
          })
        )
      })
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', (err) => {
      clearTimeout(timer)
      tunnel?.destroy()
      reject(err)
    })
    if (init.signal) {
      if (init.signal.aborted) req.destroy(new Error('请求已取消'))
      else init.signal.addEventListener('abort', () => req.destroy(new Error('请求已取消')), { once: true })
    }
    if (hasBody) req.write(init.body)
    req.end()
  })
}

/** 代理自适应 fetch：网络层失败自动换下一策略重试（每个策略 2 次），成功后缓存当前策略。
 *  init 透传标准 RequestInit（method/body/signal 等），供 AI 请求等 POST 场景复用。 */
export async function proxyFetch(
  url: string,
  init: RequestInit & { headers?: Record<string, string> } = {}
): Promise<Response> {
  const strategies = proxyCandidates()
  if (cachedProxy !== undefined) {
    try {
      return await nodeFetchOnce(url, init, cachedProxy, 30000)
    } catch (err) {
      // 缓存的策略失效（如代理关闭）：清空后重新探测
      console.log('[figma:proxy] 缓存策略失效:', String(err))
      cachedProxy = undefined
    }
  }
  let lastErr: unknown
  for (const proxy of strategies) {
    // 每个策略最多尝试 2 次：本地代理偶发瞬时失败，重试通常即可成功
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 400))
        console.log(`[figma:proxy] 尝试:`, proxy ?? '直连', attempt > 1 ? '(重试)' : '')
        const res = await nodeFetchOnce(url, init, proxy, 30000)
        console.log('[figma:proxy] 成功:', proxy ?? '直连')
        cachedProxy = proxy
        return res
      } catch (err) {
        console.log('[figma:proxy] 失败:', proxy ?? '直连', String(err))
        lastErr = err
      }
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
  throw new Error(`${msg}。${proxyChainHint()}`)
}

interface FigmaPaint {
  type: string
  visible?: boolean
  opacity?: number
  color?: { r: number; g: number; b: number; a?: number }
}

interface FigmaEffect {
  type: string
  visible?: boolean
  offset?: { x: number; y: number }
  radius?: number
  spread?: number
  color?: { r: number; g: number; b: number; a?: number }
}

interface FigmaTypeStyle {
  fontFamily?: string
  fontWeight?: number
  fontSize?: number
  lineHeightPx?: number
  letterSpacing?: number
  textAlignHorizontal?: string
}

interface FigmaNode {
  id: string
  name: string
  type: string
  visible?: boolean
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null
  fills?: FigmaPaint[]
  strokes?: FigmaPaint[]
  strokeWeight?: number
  effects?: FigmaEffect[]
  cornerRadius?: number
  rectangleCornerRadii?: number[]
  itemSpacing?: number
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL'
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  opacity?: number
  characters?: string
  style?: FigmaTypeStyle
  children?: FigmaNode[]
}

export interface FigmaDesignData {
  fileKey: string
  nodeId: string
  nodeName: string
  /** Frame 根节点（坐标原点） */
  root: StyleNode
  /** 全部节点扁平列表（深度优先） */
  nodes: StyleNode[]
  /** Frame 渲染截图（PNG dataUrl） */
  screenshotDataUrl: string
  frameSize: { width: number; height: number }
  /** 截图缩放倍率（Frame 尺寸 × scale = 截图像素） */
  scale: number
  /** 超限跳过的节点数 */
  skippedCount: number
}

export interface FigmaFetchOutcome {
  ok: boolean
  message: string
  data?: FigmaDesignData
}

/** 解析 Figma 链接中的 fileKey 与 node-id（支持 design/file/proto 前缀） */
export function parseFigmaUrl(url: string): { fileKey: string; nodeId: string } | null {
  if (!url) return null
  const m = url.match(/figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]+)/)
  if (!m) return null
  let nodeId = ''
  try {
    const raw = new URL(url).searchParams.get('node-id')
    if (raw) nodeId = raw.replace('-', ':')
  } catch {
    // 非标准 URL，忽略 node-id
  }
  return { fileKey: m[1], nodeId }
}

/** Figma REST 通用 GET（供走查与规范 Token 解析共用；走代理自适应链路） */
export async function figmaApi<T>(path: string, pat: string): Promise<T> {
  let res: Response
  try {
    res = await proxyFetch(`${FIGMA_API}${path}`, { headers: { 'X-Figma-Token': pat } })
  } catch (err) {
    // proxyFetch 已经包含了代理链提示，直接包装即可
    throw new Error(
      `无法连接 Figma API：${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!res.ok) {
    let detail = ''
    try {
      const j = (await res.json()) as { err?: string; message?: string; status?: number }
      // 403 缺 scope 时 Figma 把说明放在 message（如 requires the file_variables:read scope）
      const raw = j?.err || j?.message || ''
      if (raw) detail = `：${raw.slice(0, 200)}`
      else if (j?.status !== undefined) detail = `：状态码 ${j.status}`
    } catch {
      // 忽略解析失败
    }
    if (res.status === 403) detail = detail || '：PAT 无效或无该文件访问权限'
    else if (res.status === 404) detail = detail || '：文件不存在或 fileKey 错误'
    else if (res.status === 429) detail = detail || '：请求过于频繁，请稍后重试'
    throw new Error(`Figma API 请求失败（${res.status}）${detail}`)
  }
  return (await res.json()) as T
}

/** 轻量读取 Figma 文件元信息（depth=0 不拉节点树），用于规范「检查更新」比对 last_modified */
export async function fetchFigmaFileMeta(
  fileKey: string,
  pat: string
): Promise<{ ok: boolean; message: string; lastModified?: number; fileName?: string }> {
  try {
    const meta = await figmaApi<{ last_modified?: string; name?: string }>(
      `/files/${encodeURIComponent(fileKey)}?depth=0`,
      pat
    )
    const ts = meta.last_modified ? Date.parse(meta.last_modified) : NaN
    return {
      ok: true,
      message: '',
      lastModified: Number.isNaN(ts) ? undefined : ts,
      fileName: meta.name
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

const normType = (t: string): StyleNode['type'] => {
  switch (t) {
    case 'TEXT':
      return 'text'
    case 'GROUP':
      return 'group'
    case 'RECTANGLE':
      return 'rect'
    case 'ELLIPSE':
      return 'ellipse'
    case 'COMPONENT':
    case 'COMPONENT_SET':
    case 'INSTANCE':
      return 'component'
    default:
      return 'frame'
  }
}

/** 跳过无视觉意义的节点类型（矢量路径、切片、辅助线等） */
const SKIPPED_TYPES = new Set(['VECTOR', 'LINE', 'SLICE', 'GUIDE', 'BOOLEAN_OPERATION', 'STAR', 'REGULAR_POLYGON'])

function firstSolidHex(paints: FigmaPaint[] | undefined): string | null {
  const paint = paints?.find((p) => p.type === 'SOLID' && p.visible !== false && p.color)
  return paint ? figmaColorToHex(paint.color, paint.opacity ?? 1) : null
}

function effectsToCss(effects: FigmaEffect[] | undefined): string | undefined {
  const shadows = (effects ?? []).filter((e) => e.type === 'DROP_SHADOW' && e.visible !== false && e.color)
  if (!shadows.length) return undefined
  return shadows
    .map((e) => {
      const { r, g, b } = e.color!
      const a = Math.round(((e.color as { a?: number }).a ?? 1) * 100) / 100
      return `${Math.round(e.offset?.x ?? 0)}px ${Math.round(e.offset?.y ?? 0)}px ${Math.round(e.radius ?? 0)}px ${Math.round(e.spread ?? 0)}px rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`
    })
    .join(', ')
}

/** Figma 图层树 → 归一化 StyleNode 树（坐标转为相对根 Frame） */
function walkNode(
  node: FigmaNode,
  origin: { x: number; y: number },
  depth: number,
  out: StyleNode[],
  counter: { skipped: number }
): StyleNode | null {
  if (node.visible === false || SKIPPED_TYPES.has(node.type)) return null
  const bbox = node.absoluteBoundingBox
  if (!bbox) return null

  const style: StyleNode = {
    id: node.id,
    name: node.name,
    type: normType(node.type),
    x: Math.round((bbox.x - origin.x) * 100) / 100,
    y: Math.round((bbox.y - origin.y) * 100) / 100,
    width: Math.round(bbox.width * 100) / 100,
    height: Math.round(bbox.height * 100) / 100,
    figmaNodeId: node.id
  }

  const fill = firstSolidHex(node.fills)
  if (fill) style.fill = fill
  if (node.type === 'TEXT') {
    style.textColor = fill ?? undefined
    if (style.textColor) delete style.fill
    style.text = (node.characters ?? '').slice(0, 200)
    const st = node.style
    if (st?.fontSize) style.fontSize = st.fontSize
    if (st?.fontWeight) style.fontWeight = st.fontWeight
    if (st?.fontFamily) style.fontFamily = st.fontFamily
    if (st?.lineHeightPx) style.lineHeight = Math.round(st.lineHeightPx * 100) / 100
    if (st?.letterSpacing) style.letterSpacing = Math.round(st.letterSpacing * 100) / 100
    if (st?.textAlignHorizontal && st.textAlignHorizontal !== 'LEFT') style.textAlign = st.textAlignHorizontal.toLowerCase()
  }
  // 圆角：单值或 4 角
  if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
    style.borderRadius = [node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius]
  } else if (node.rectangleCornerRadii?.some((r) => r > 0)) {
    style.borderRadius = node.rectangleCornerRadii
  }
  const stroke = firstSolidHex(node.strokes)
  if (stroke && (node.strokeWeight ?? 0) > 0) {
    style.borderWidth = Math.round(node.strokeWeight! * 100) / 100
    style.borderColor = stroke
  }
  const shadow = effectsToCss(node.effects)
  if (shadow) style.boxShadow = shadow
  if (node.layoutMode && node.layoutMode !== 'NONE') {
    if (typeof node.itemSpacing === 'number' && node.itemSpacing > 0) style.gap = node.itemSpacing
    const pad = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft]
    if (pad.some((v) => typeof v === 'number' && v > 0)) {
      style.paddingTop = node.paddingTop || 0
      style.paddingRight = node.paddingRight || 0
      style.paddingBottom = node.paddingBottom || 0
      style.paddingLeft = node.paddingLeft || 0
    }
  }
  if (typeof node.opacity === 'number' && node.opacity < 1) style.opacity = Math.round(node.opacity * 100) / 100
  // 匹配主色：文本取文字色，其余取背景填充
  style.dominantColor = style.fill ?? style.textColor
  if (style.width > 0 && style.height > 0) {
    style.aspectRatio = Math.round((style.width / style.height) * 1000) / 1000
  }

  out.push(style)
  if (out.length > MAX_NODES || depth >= MAX_DEPTH) {
    counter.skipped++
    return style
  }
  if (node.children?.length) {
    const children: StyleNode[] = []
    for (const child of node.children) {
      const c = walkNode(child, origin, depth + 1, out, counter)
      if (c) children.push(c)
    }
    if (children.length) style.children = children
  }
  return style
}

/** 渲染 Frame 截图并下载为 dataUrl */
async function fetchFrameScreenshot(
  pat: string,
  fileKey: string,
  nodeId: string,
  scale: number
): Promise<string> {
  const j = await figmaApi<{ images?: Record<string, string | null>; err?: string }>(
    `/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`,
    pat
  )
  const url = j.images?.[nodeId]
  if (!url) throw new Error('Figma 截图渲染失败：节点可能过大或包含不支持的图层数据，请稍后重试')
  let imgRes: Response
  try {
    // 截图 URL 在 Figma CDN（s3-alpha），同样走代理自适应
    imgRes = await proxyFetch(url)
  } catch (err) {
    throw new Error(
      `Figma 截图下载失败：${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!imgRes.ok) throw new Error(`Figma 截图下载失败（HTTP ${imgRes.status}）`)
  const buf = Buffer.from(await imgRes.arrayBuffer())
  if (buf.byteLength === 0) throw new Error('Figma 截图内容为空，请稍后重试')
  return `data:image/png;base64,${buf.toString('base64')}`
}

/**
 * 拉取 Figma 设计数据（图层样式树 + Frame 截图）。
 * figmaUrl 需包含 node-id（Figma 中选中 Frame → 右键 Copy link）。
 */
export async function fetchFigmaDesign(input: {
  pat: string
  figmaUrl?: string
  scale?: number
}): Promise<FigmaFetchOutcome> {
  const { pat, figmaUrl = '' } = input
  if (!pat) return { ok: false, message: '未配置 Figma PAT：请在「设置 → MCP 管理」中填写带令牌的 MCP 条目' }
  const parsed = parseFigmaUrl(figmaUrl)
  if (!parsed) return { ok: false, message: 'Figma 链接无法识别：请在 Figma 选中目标 Frame 后右键 Copy link，并确保链接包含 node-id' }
  if (!parsed.nodeId) return { ok: false, message: 'Figma 链接缺少 node-id：请在 Figma 选中目标 Frame 后重新 Copy link' }
  const { fileKey, nodeId } = parsed
  const scale = input.scale ?? 2

  try {
    const j = await figmaApi<{
      nodes?: Record<string, { document?: FigmaNode }>
    }>(`/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`, pat)
    const entry = j.nodes?.[nodeId] ?? Object.values(j.nodes ?? {})[0]
    let doc = entry?.document
    if (!doc) return { ok: false, message: '未找到 node-id 对应的图层：请确认链接取自当前文件中的 Frame' }
    // 链接取的是页面/文档层级时，下钻到第一个可见 Frame
    if (doc.type === 'DOCUMENT' || doc.type === 'PAGE') {
      const firstFrame = (doc.children ?? []).find((c) => c.visible !== false && c.absoluteBoundingBox)
      if (!firstFrame) return { ok: false, message: '该页面下没有可用的 Frame，请在 Figma 中选中具体 Frame 后 Copy link' }
      doc = firstFrame
    }
    const bbox = doc.absoluteBoundingBox
    if (!bbox || bbox.width <= 0 || bbox.height <= 0) {
      return { ok: false, message: '目标图层没有有效尺寸，请选择带内容的 Frame' }
    }

    const nodes: StyleNode[] = []
    const counter = { skipped: 0 }
    const root = walkNode(doc, { x: bbox.x, y: bbox.y }, 0, nodes, counter)
    if (!root) return { ok: false, message: '图层树解析失败，请重试或更换 Frame' }

    const screenshotDataUrl = await fetchFrameScreenshot(pat, fileKey, root.figmaNodeId!, scale)
    return {
      ok: true,
      message: counter.skipped > 0 ? `设计稿读取完成（超出上限跳过 ${counter.skipped} 个图层）` : '设计稿读取完成',
      data: {
        fileKey,
        nodeId: root.figmaNodeId!,
        nodeName: root.name,
        root,
        nodes,
        screenshotDataUrl,
        frameSize: { width: root.width, height: root.height },
        scale,
        skippedCount: counter.skipped
      }
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 轻量读取 Frame 尺寸（自动走查视口宽度自动匹配用）：只拉节点树解析 bbox，不渲染截图。
 * 链接取页面层级时与 fetchFigmaDesign 一致地下钻到第一个可见 Frame。
 */
export async function fetchFigmaNodeSize(input: {
  pat: string
  figmaUrl?: string
}): Promise<{ ok: boolean; message: string; width?: number; height?: number; nodeName?: string }> {
  const { pat, figmaUrl = '' } = input
  if (!pat) return { ok: false, message: '未配置 Figma PAT：请在「设置 → MCP 管理」中填写带令牌的 MCP 条目' }
  const parsed = parseFigmaUrl(figmaUrl)
  if (!parsed) return { ok: false, message: 'Figma 链接无法识别：请在 Figma 选中目标 Frame 后右键 Copy link' }
  if (!parsed.nodeId) return { ok: false, message: 'Figma 链接缺少 node-id：请重新 Copy link' }
  try {
    const j = await figmaApi<{ nodes?: Record<string, { document?: FigmaNode }> }>(
      `/files/${parsed.fileKey}/nodes?ids=${encodeURIComponent(parsed.nodeId)}`,
      pat
    )
    const entry = j.nodes?.[parsed.nodeId] ?? Object.values(j.nodes ?? {})[0]
    let doc = entry?.document
    if (!doc) return { ok: false, message: '未找到 node-id 对应的图层：请确认链接取自当前文件中的 Frame' }
    if (doc.type === 'DOCUMENT' || doc.type === 'PAGE') {
      const firstFrame = (doc.children ?? []).find((c) => c.visible !== false && c.absoluteBoundingBox)
      if (!firstFrame) return { ok: false, message: '该页面下没有可用的 Frame，请选中具体 Frame 后 Copy link' }
      doc = firstFrame
    }
    const bbox = doc.absoluteBoundingBox
    if (!bbox || bbox.width <= 0 || bbox.height <= 0) {
      return { ok: false, message: '目标图层没有有效尺寸，请选择带内容的 Frame' }
    }
    return {
      ok: true,
      message: 'ok',
      width: Math.round(bbox.width),
      height: Math.round(bbox.height),
      nodeName: doc.name
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
