import { ipcMain, shell } from 'electron'
import { createHash } from 'crypto'
import { getConfigData } from './ipc'

/**
 * 腾讯文档 / 金山文档导出：连接测试 + 创建报告文档。
 * 腾讯文档凭据为开放平台「开发者信息」三参数（client_id / access_token / open_id），
 * 创建走官方 v2 导入链路：报告内容先生成 docx，再经「预导入 → COS 上传 → 异步导入 → 轮询进度」
 * 导入为在线文档，内容（元信息 / 统计 / 问题明细 / 设计稿与截图）与飞书文档口径一致。
 * 金山文档凭据为 App ID / App Secret。接口失败时把服务端真实返回透给渲染层，绝不伪造成功。
 */

const TENCENT_BASE = 'https://docs.qq.com/openapi'
const KINGSOFT_BASE = 'https://openapi.wps.cn'

/** 腾讯文档开放平台凭据 */
interface TencentDocsConfig {
  clientId: string
  accessToken: string
  openId: string
}

/** 金山文档开放平台凭据 */
interface KingsoftDocsConfig {
  appId: string
  appSecret: string
}

/** 文档导出 payload（与飞书 feishu:createReport 一致的内容结构） */
interface DocExportPayload {
  title: string
  metaLines: string[]
  stats: { label: string; value: string }[]
  issues: {
    no: number
    title: string
    severityLabel: string
    categoryLabel: string
    sourceLabel: string
    targetLabel: string
    statusLabel: string
    suggestion?: { current: string; fix: string; properties?: string }
  }[]
  images: { name: string; dataUrl: string }[]
  htmlReport?: { name: string; dataUrl: string }
}

/** 腾讯文档 v2 鉴权请求头（官方文档头名：Client-Id / Open-Id / Access-Token） */
function tencentHeaders(cfg: TencentDocsConfig): Record<string, string> {
  return {
    'Client-Id': cfg.clientId,
    'Open-Id': cfg.openId,
    'Access-Token': cfg.accessToken
  }
}

function getTencentConfig(): TencentDocsConfig {
  const cfg = (getConfigData().tencentDocs ?? {}) as Partial<TencentDocsConfig>
  if (!cfg.clientId || !cfg.accessToken || !cfg.openId) {
    throw new Error('尚未配置腾讯文档凭据，请到「设置 → 应用授权」填写 Client ID / Access Token / Open ID')
  }
  return cfg as TencentDocsConfig
}

function getKingsoftConfig(): KingsoftDocsConfig {
  const cfg = (getConfigData().kingsoftDocs ?? {}) as Partial<KingsoftDocsConfig>
  if (!cfg.appId || !cfg.appSecret) {
    throw new Error('尚未配置金山文档凭据，请到「设置 → 应用授权」填写 App ID / App Secret')
  }
  return cfg as KingsoftDocsConfig
}

/** 金山文档开放平台：App ID / App Secret 换取应用 token（KOpen v2） */
async function getKingsoftToken(): Promise<string> {
  const cfg = getKingsoftConfig()
  const res = await fetch(`${KINGSOFT_BASE}/kopen/woa/v2/dev/app/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.appId, app_key: cfg.appSecret })
  })
  const text = await res.text()
  let data: { code?: number; token?: string; data?: { token?: string } } = {}
  try {
    data = JSON.parse(text) as typeof data
  } catch {
    throw new Error(`金山文档 token 接口返回异常（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }
  const token = data.token ?? data.data?.token
  if (res.status !== 200 || (data.code !== undefined && data.code !== 0) || !token) {
    throw new Error(
      `金山文档凭据验证失败（HTTP ${res.status}，code ${data.code ?? '-'}）：${text.slice(0, 200)}（请检查 App ID / App Secret，并确认应用已开通金山文档 API）`
    )
  }
  return token
}

/** 在响应 JSON 里递归找文档链接字段（url / doc_url），兼容 data 包裹层级 */
function findDocUrl(obj: unknown, depth = 0): string | null {
  if (depth > 4 || typeof obj !== 'object' || obj === null) return null
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if ((k === 'url' || k === 'doc_url') && typeof v === 'string' && v.startsWith('http')) return v
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const hit = findDocUrl(v, depth + 1)
    if (hit) return hit
  }
  return null
}

/** 腾讯文档 v2 业务返回码 → 可读提示（官方错误码表） */
function tencentRetMessage(ret: number, msg: string): string {
  const map: Record<number, string> = {
    10313: 'Access-Token 为空，请检查凭据填写',
    10302: 'Client-Id 与 Access-Token 不匹配，请检查应用 ID 是否填对',
    10303: 'Open-Id 与 Access-Token 不匹配，请检查 Open ID 是否填对',
    37019: 'Access-Token 校验失败（错误或已过期），请到开放平台重置后更新',
    10107: '导入文件过大（超过平台上限）',
    10108: '导入文件的格式不支持',
    10109: '导入的文件已损坏，请重试',
    10111: '不支持导入加密文件'
  }
  return map[ret] ?? `业务错误 ret ${ret}${msg ? `：${msg}` : ''}`
}

// ===== 最小 docx 生成（OOXML + store 模式 zip，无第三方依赖） =====

/** CRC32 查表（zip 校验用） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** store（不压缩）模式打 zip 包；docx 对压缩方式无要求，store 最简单可靠 */
function zipStore(files: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf-8')
    const crc = crc32(f.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4) // 解压所需版本
    lh.writeUInt16LE(0x0800, 6) // bit11：UTF-8 文件名
    lh.writeUInt16LE(0, 8) // store
    lh.writeUInt16LE(0, 10) // 时间（DOS，1980-01-01 00:00）
    lh.writeUInt16LE(0x21, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(f.data.length, 18)
    lh.writeUInt32LE(f.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    local.push(lh, name, f.data)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(0x21, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(f.data.length, 20)
    ch.writeUInt32LE(f.data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, name)
    offset += 30 + name.length + f.data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBuf, eocd])
}

const escXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

interface RunOpts {
  text: string
  bold?: boolean
  /** 字号（半磅，Word 惯例：21=10.5pt 正文） */
  sizeHalf?: number
  color?: string
}

/** 多 run 段落（一段内混排加粗 / 灰色小字等），pPr 可传居中 / 间距等段落属性 */
function wRuns(runs: RunOpts[], pPr = ''): string {
  const body = runs
    .map((r) => {
      const rpr: string[] = []
      if (r.bold) rpr.push('<w:b/>')
      if (r.color) rpr.push(`<w:color w:val="${r.color}"/>`)
      if (r.sizeHalf) rpr.push(`<w:sz w:val="${r.sizeHalf}"/><w:szCs w:val="${r.sizeHalf}"/>`)
      const rPr = rpr.length ? `<w:rPr>${rpr.join('')}</w:rPr>` : ''
      return `<w:r>${rPr}<w:t xml:space="preserve">${escXml(r.text)}</w:t></w:r>`
    })
    .join('')
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${body}</w:p>`
}

/** 单一样式文本段落 */
function wP(text: string, opts?: Omit<RunOpts, 'text'>, pPr = ''): string {
  return wRuns([{ text, ...opts }], pPr)
}

/** 表格单元格 */
interface TCellOpts {
  text: string
  bold?: boolean
  sizeHalf?: number
  color?: string
  /** 背景底纹色（表头 / 建议行） */
  fill?: string
  /** 跨列数（合并单元格） */
  span?: number
  /** 列宽（dxa） */
  width?: number
}

function wCell(c: TCellOpts): string {
  const rpr: string[] = []
  if (c.bold) rpr.push('<w:b/>')
  if (c.color) rpr.push(`<w:color w:val="${c.color}"/>`)
  if (c.sizeHalf) rpr.push(`<w:sz w:val="${c.sizeHalf}"/><w:szCs w:val="${c.sizeHalf}"/>`)
  const run = `<w:r>${rpr.length ? `<w:rPr>${rpr.join('')}</w:rPr>` : ''}<w:t xml:space="preserve">${escXml(c.text)}</w:t></w:r>`
  const tcPr: string[] = [`<w:tcW w:w="${c.width ?? 0}" w:type="dxa"/>`]
  if (c.span) tcPr.push(`<w:gridSpan w:val="${c.span}"/>`)
  if (c.fill) tcPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${c.fill}"/>`)
  tcPr.push('<w:vAlign w:val="center"/>')
  return `<w:tc><w:tcPr>${tcPr.join('')}</w:tcPr><w:p>${run}</w:p></w:tc>`
}

/** 定宽表格：tblGrid 固定列宽 + 100% 页宽 + 单元格内边距，排版稳定不依赖内容自适应 */
function wGridTable(widths: number[], rows: string[][]): string {
  const border = (n: string) => `<w:${n} w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/>`
  const tblPr =
    '<w:tblPr><w:tblW w:w="5000" w:type="pct"/>' +
    `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>` +
    '<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>'
  const grid = `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`
  const trs = rows.map((cells) => `<w:tr>${cells.join('')}</w:tr>`).join('')
  return `<w:tbl>${tblPr}${grid}${trs}</w:tbl>`
}

/** 读取 PNG / JPEG 像素尺寸（读不出返回 0，由调用方按默认比例兜底） */
function imagePixelSize(buf: Buffer, ext: string): { w: number; h: number } {
  if (ext === 'png' && buf.length > 24) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  if (ext === 'jpg' || ext === 'jpeg') {
    let pos = 2
    while (pos + 9 < buf.length) {
      if (buf[pos] !== 0xff) break
      const marker = buf[pos + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: buf.readUInt16BE(pos + 7), h: buf.readUInt16BE(pos + 5) }
      }
      pos += 2 + buf.readUInt16BE(pos + 2)
    }
  }
  return { w: 0, h: 0 }
}

/** 把报告 payload 组装为 docx：标题 + 元信息 + 统计表 + 问题明细表 + 附图，图文口径与飞书文档一致 */
function buildReportDocx(p: DocExportPayload): Buffer {
  const body: string[] = []
  // 主标题：居中加粗，下留间距
  body.push(wRuns([{ text: p.title, bold: true, sizeHalf: 36 }], '<w:jc w:val="center"/><w:spacing w:after="200"/>'))
  // 元信息行：灰色小字，行距与段后间距拉开
  for (const line of p.metaLines) {
    body.push(wRuns([{ text: line, color: '595959', sizeHalf: 20 }], '<w:spacing w:after="60" w:line="312" w:lineRule="auto"/>'))
  }
  // 统计表：100% 页宽等宽格子，浅蓝底
  if (p.stats.length) {
    const seg = Math.floor(9026 / p.stats.length)
    const widths = p.stats.map((_, i) => (i === p.stats.length - 1 ? 9026 - seg * (p.stats.length - 1) : seg))
    body.push(
      wGridTable(
        widths,
        [p.stats.map((s, i) => wCell({ text: `${s.label}：${s.value}`, bold: true, sizeHalf: 20, width: widths[i], fill: 'E8EEF9' }))]
      )
    )
  }

  // 问题明细表：表头行 + 每问题一行属性，AI 建议以合并单元格行紧随其后
  if (p.issues.length) {
    body.push(wP('问题明细', { bold: true, sizeHalf: 28 }, '<w:spacing w:before="280" w:after="140"/>'))
    const COLS = [600, 3200, 950, 1150, 1150, 926, 1050]
    const head = (t: string, i: number) => wCell({ text: t, bold: true, sizeHalf: 18, width: COLS[i], fill: 'E8EEF9' })
    const rows: string[][] = [
      [head('编号', 0), head('标题', 1), head('严重度', 2), head('类别', 3), head('来源', 4), head('目标', 5), head('状态', 6)]
    ]
    for (const i of p.issues) {
      const c = (t: string, j: number) => wCell({ text: t, sizeHalf: 18, width: COLS[j] })
      rows.push([
        c(String(i.no), 0),
        c(i.title, 1),
        c(i.severityLabel, 2),
        c(i.categoryLabel, 3),
        c(i.sourceLabel, 4),
        c(i.targetLabel, 5),
        c(i.statusLabel, 6)
      ])
      if (i.suggestion) {
        rows.push([
          wCell({
            text: `建议　现状：${i.suggestion.current}　改法：${i.suggestion.fix}`,
            sizeHalf: 18,
            color: '595959',
            span: 7,
            fill: 'FAFBFD'
          })
        ])
      }
    }
    body.push(wGridTable(COLS, rows))
  }

  // 附图：解析 dataUrl → media 文件 + 关系 + inline drawing（按页宽等比缩放）
  const media: { name: string; data: Buffer }[] = []
  const rels: string[] = []
  let imgIdx = 0
  for (const img of p.images) {
    if (imgIdx === 0) body.push(wP('附图', { bold: true, sizeHalf: 28 }, '<w:spacing w:before="280" w:after="140"/>'))
    const m = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(img.dataUrl.trim())
    if (!m) continue
    const ext = m[1]
    const data = Buffer.from(m[2], 'base64')
    imgIdx += 1
    const fileName = `image${imgIdx}.${ext}`
    const rid = `rIdImg${imgIdx}`
    rels.push(
      `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fileName}"/>`
    )
    media.push({ name: `word/media/${fileName}`, data })
    let { w, h } = imagePixelSize(data, ext)
    if (!w || !h) {
      w = 1200
      h = 800
    }
    // A4 内容区宽约 15.9cm ≈ 5,700,000 EMU；1px = 9525 EMU
    const px = w * 9525
    const scale = Math.min(1, 5700000 / px)
    const cx = Math.round(px * scale)
    const cy = Math.round(h * 9525 * scale)
    body.push(wP(img.name, { bold: true, sizeHalf: 22, color: '404040' }, '<w:spacing w:before="160" w:after="80"/>'))
    body.push(
      `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${imgIdx}" name="Picture ${imgIdx}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${imgIdx}" name="Picture ${imgIdx}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    )
  }

  if (p.htmlReport) {
    body.push(
      wRuns(
        [
          {
            text: '注：交互式 HTML 报告（图上标注定位、研发回应与修改报告导出）无法作为附件随腾讯文档携带，请在应用「导出报告」页点「导出 HTML 报告」获取完整版本。',
            color: '808080',
            sizeHalf: 18
          }
        ],
        '<w:spacing w:before="240"/>'
      )
    )
  }

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>' +
    body.join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>'
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="jpeg" ContentType="image/jpeg"/></Types>'
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  const docRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`

  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf-8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf-8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf-8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(docRels, 'utf-8') },
    ...media
  ])
}

/** 腾讯文档 v2 form-urlencoded POST */
async function tencentForm(
  cfg: TencentDocsConfig,
  path: string,
  params: Record<string, string>
): Promise<{ status: number; data: { ret?: number; msg?: string; data?: Record<string, unknown> } }> {
  const res = await fetch(`${TENCENT_BASE}${path}`, {
    method: 'POST',
    headers: { ...tencentHeaders(cfg), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  })
  const text = await res.text()
  let data: { ret?: number; msg?: string; data?: Record<string, unknown> } = {}
  try {
    data = JSON.parse(text) as typeof data
  } catch {
    // 非 JSON（网关错误页等），保留空对象由调用方按 status/ret 判定
  }
  return { status: res.status, data }
}

function registerDocExportHandlers(): void {
  // 腾讯文档连接测试：请求「查询文档元信息」端点（官方 GET /openapi/drive/v2/files/{fileID}/metadata，
  // 传一个不存在的 fileID）——鉴权失败返回 401/403 或鉴权类业务码（10302/10303/10313/37019），
  // 文件不存在等其他业务码说明鉴权层已通过；不创建任何文档
  ipcMain.handle('tencent:test', async (): Promise<{ ok: boolean; message: string }> => {
    try {
      const cfg = getTencentConfig()
      const res = await fetch(`${TENCENT_BASE}/drive/v2/files/__uwt_conn_check__/metadata`, {
        headers: tencentHeaders(cfg)
      })
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          message: `鉴权失败（HTTP ${res.status}）：请检查 Client ID / Access Token / Open ID 是否正确、token 是否已过期`
        }
      }
      let ret = 0
      let msg = ''
      try {
        const data = (await res.json()) as { ret?: number; msg?: string }
        ret = Number(data.ret ?? 0)
        msg = String(data.msg ?? '')
      } catch {
        // 非 JSON 返回（网关错误页等），按 HTTP 状态判断
        if (!res.ok) return { ok: false, message: `腾讯文档服务异常（HTTP ${res.status}）` }
      }
      if ([10302, 10303, 10313, 37019].includes(ret)) {
        return { ok: false, message: `鉴权失败：${tencentRetMessage(ret, msg)}` }
      }
      return { ok: true, message: '腾讯文档凭据验证通过' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // 腾讯文档创建报告文档：报告内容生成 docx → 官方 v2 导入链路（预导入 /drive/v2/files/upload →
  // COS PUT → 异步导入 /drive/v2/files/async-import → 轮询 import-progress），导入为在线文档，
  // 内容与飞书文档同口径；成功后自动打开
  ipcMain.handle(
    'tencent:createReport',
    async (_e, payload: DocExportPayload): Promise<{ ok: boolean; url?: string; message: string }> => {
      try {
        const cfg = getTencentConfig()
        const docx = buildReportDocx(payload)
        const md5 = createHash('md5').update(docx).digest('hex')
        const fileName = `${payload.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 36)}.docx`

        // 1. 预导入：换取腾讯云 COS 上传链接
        const pre = await tencentForm(cfg, '/drive/v2/files/upload', {
          fileMD5: md5,
          fileName,
          fileSize: String(docx.length)
        })
        if (pre.data.ret !== 0) {
          return {
            ok: false,
            message: `预导入失败：${tencentRetMessage(pre.data.ret ?? -1, pre.data.msg ?? '')}`
          }
        }
        const cos = pre.data.data as
          | { COSPutURL?: string; COSFileKey?: string; CustomHeader?: Record<string, string> }
          | undefined
        if (!cos?.COSPutURL || !cos.COSFileKey) {
          return { ok: false, message: `预导入返回异常：${JSON.stringify(pre.data).slice(0, 200)}` }
        }

        // 2. 上传报告文件到 COS（CustomHeader 为签名约定头，需原样携带）
        const put = await fetch(cos.COSPutURL, {
          method: 'PUT',
          headers: cos.CustomHeader ?? {},
          body: new Uint8Array(docx)
        })
        if (!put.ok) {
          const errText = await put.text().catch(() => '')
          return { ok: false, message: `报告文件上传失败（COS HTTP ${put.status}）：${errText.slice(0, 200)}` }
        }

        // 3. 触发异步导入
        const imp = await tencentForm(cfg, '/drive/v2/files/async-import', {
          fileMD5: md5,
          fileName,
          COSFileKey: cos.COSFileKey
        })
        if (imp.data.ret !== 0) {
          return {
            ok: false,
            message: `导入失败：${tencentRetMessage(imp.data.ret ?? -1, imp.data.msg ?? '')}`
          }
        }
        const progressQueryID = (imp.data.data as { progressQueryID?: string } | undefined)?.progressQueryID
        if (!progressQueryID) {
          return { ok: false, message: `导入返回异常：${JSON.stringify(imp.data).slice(0, 200)}` }
        }

        // 4. 轮询导入进度（1.5s 一次，最长约 75s）
        let url: string | undefined
        for (let i = 0; i < 50; i++) {
          await new Promise((r) => setTimeout(r, 1500))
          const q = await fetch(
            `${TENCENT_BASE}/drive/v2/files/import-progress?progressQueryID=${encodeURIComponent(progressQueryID)}`,
            { headers: tencentHeaders(cfg) }
          )
          const text = await q.text()
          let jd: { ret?: number; msg?: string; data?: { progress?: number; url?: string } } = {}
          try {
            jd = JSON.parse(text) as typeof jd
          } catch {
            continue
          }
          if (jd.ret !== undefined && jd.ret !== 0) {
            return { ok: false, message: `导入失败：${tencentRetMessage(jd.ret, jd.msg ?? '')}` }
          }
          if (jd.data?.progress === 100) {
            url = jd.data.url
            break
          }
        }
        if (!url) {
          return { ok: false, message: '导入超时：可稍后在腾讯文档「我的文档」中查看结果后重试' }
        }
        await shell.openExternal(url).catch(() => undefined)
        return { ok: true, url, message: '腾讯文档已创建（含完整报告内容），浏览器将自动打开' }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // 金山文档连接测试：App ID / App Secret 换取应用 token 验证凭据
  ipcMain.handle('kingsoft:test', async (): Promise<{ ok: boolean; message: string }> => {
    try {
      await getKingsoftToken()
      return { ok: true, message: '金山文档凭据验证通过' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // 金山文档创建报告文档，成功后自动打开
  ipcMain.handle(
    'kingsoft:createReport',
    async (_e, payload: { title: string }): Promise<{ ok: boolean; url?: string; message: string }> => {
      try {
        const token = await getKingsoftToken()
        const res = await fetch(`${KINGSOFT_BASE}/kopen/woa/v2/dev/files/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: payload.title, type: 'document' })
        })
        const text = await res.text()
        if (!res.ok) {
          return { ok: false, message: `金山文档创建接口 HTTP ${res.status}：${text.slice(0, 300)}` }
        }
        let data: unknown
        try {
          data = JSON.parse(text)
        } catch {
          return { ok: false, message: `金山文档返回非 JSON：${text.slice(0, 300)}` }
        }
        const url = findDocUrl(data)
        if (!url) {
          return { ok: false, message: `金山文档返回中未找到文档链接：${text.slice(0, 300)}` }
        }
        await shell.openExternal(url).catch(() => undefined)
        return { ok: true, url, message: '金山文档已创建，浏览器将自动打开' }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}

export { registerDocExportHandlers }
