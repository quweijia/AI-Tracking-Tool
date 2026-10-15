import { ipcMain, shell } from 'electron'
import { getConfigData } from './ipc'

const FEISHU_BASE = 'https://open.feishu.cn/open-apis'

interface FeishuConfig {
  appId: string
  appSecret: string
}

/** 渲染进程组装好的报告载荷（文案已在渲染层格式化） */
interface FeishuReportPayload {
  title: string
  metaLines: string[]
  stats: { label: string; value: string }[]
  issues: {
    no: number
    title: string
    severityLabel: string
    categoryLabel: string
    targetLabel: string
    statusLabel: string
    suggestion?: { current: string; fix: string; properties?: string }
  }[]
  images: { name: string; dataUrl: string }[]
  /** 导出的交互式 HTML 报告，作为附件块挂到文档末尾 */
  htmlReport?: { name: string; dataUrl: string }
}

async function getTenantToken(): Promise<string> {
  const config = getConfigData()
  const feishu = (config.feishu ?? {}) as Partial<FeishuConfig>
  if (!feishu.appId || !feishu.appSecret) {
    throw new Error('尚未配置飞书应用，请到「设置 → 应用授权」填写 App ID / App Secret')
  }
  const res = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: feishu.appId, app_secret: feishu.appSecret })
  })
  const data = (await res.json()) as { code: number; msg: string; tenant_access_token?: string }
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败（${data.code}）：${data.msg}`)
  }
  return data.tenant_access_token
}

async function feishuJson<T>(token: string, url: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const data = (await res.json()) as { code: number; msg: string; data?: T }
  if (data.code !== 0) {
    throw new Error(`飞书 API（${data.code}）：${data.msg}`)
  }
  return data.data as T
}

/** 限频/瞬态错误自动退避重试（表格逐块写入调用较多，避免偶发限频直接失败） */
async function feishuRetry<T>(fn: () => Promise<T>, times = 3): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i <= times; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      const m = /飞书 API（(\d+)）/.exec(msg)
      const code = m ? Number(m[1]) : 0
      const retryable = /频率|rate limit|too many|99991400|12542\d\d/i.test(msg) || code === 99991400
      if (!retryable || i === times) throw err
      await new Promise((r) => setTimeout(r, 600 * (i + 1)))
    }
  }
  throw lastErr
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  return Buffer.from(base64, 'base64')
}

type TextElement = { text_run: { content: string; text_element_style?: { bold?: boolean; link?: { url: string } } } }
type Block =
  | { block_type: 2; text: { elements: TextElement[] } }
  | { block_type: 3; heading1: { elements: TextElement[] } }
  | { block_type: 4; heading2: { elements: TextElement[] } }

const textBlock = (content: string, bold = false): Block => ({
  block_type: 2,
  text: { elements: [{ text_run: { content, ...(bold ? { text_element_style: { bold: true } } : {}) } } ] }
})

/** 带超链接的文本块（docx 链接要求 URL 先做 URL 编码） */
const linkTextBlock = (content: string, url: string, bold = false): Block => ({
  block_type: 2,
  text: { elements: [{ text_run: { content, text_element_style: { ...(bold ? { bold: true } : {}), link: { url: encodeURIComponent(url) } } } }] }
})

const heading2 = (content: string): Block => ({
  block_type: 4,
  heading2: { elements: [{ text_run: { content } }] }
})

/** 追加文本块到文档末尾（每批最多 50 个） */
async function appendTextBlocks(token: string, docId: string, blocks: Block[]): Promise<void> {
  for (let i = 0; i < blocks.length; i += 50) {
    await feishuRetry(() =>
      feishuJson(
        token,
        `${FEISHU_BASE}/docx/v1/documents/${docId}/blocks/${docId}/children?document_revision_id=-1`,
        { children: blocks.slice(i, i + 50), index: -1 }
      )
    )
  }
}

/** 创建空的图片/文件块（官方三步流第一步），返回可直接挂素材/patch 的块 ID */
async function createEmptyMediaBlock(
  token: string,
  docId: string,
  block: { block_type: 27; image: { token: string } } | { block_type: 23; file: { token: string } }
): Promise<string> {
  const data = await feishuRetry(() =>
    feishuJson<{
      children?: { block_id: string; children?: string[] }[]
    }>(
      token,
      `${FEISHU_BASE}/docx/v1/documents/${docId}/blocks/${docId}/children?document_revision_id=-1`,
      { children: [block], index: -1 }
    )
  )
  const first = data.children?.[0]
  if (!first?.block_id) throw new Error('未返回块 ID')
  // 与图片块不同：文件块外层会包一个 View Block（block_type 33），真正的 File Block ID 是它的 children[0]
  // （官方 FAQ「如何插入文件/附件」）。误用 View Block ID 会导致 replace_file 报 1770025。
  if (block.block_type === 23) {
    const fileBlockId = first.children?.[0]
    if (!fileBlockId) throw new Error('文件块创建异常：未返回 File Block ID')
    return fileBlockId
  }
  return first.block_id
}

/** 上传素材（docx_image / docx_file），parent_node 为目标块 ID */
async function uploadMedia(
  token: string,
  parentNode: string,
  dataUrl: string,
  name: string,
  parentType: 'docx_image' | 'docx_file',
  mime: string
): Promise<string> {
  const buffer = dataUrlToBuffer(dataUrl)
  // 飞书 upload_all 上限 20MB，超限直接给出明确提示（HTML 报告内嵌原图时容易出现）
  if (buffer.byteLength > 20 * 1024 * 1024) {
    throw new Error(
      `文件「${name}」约 ${Math.round(buffer.byteLength / 1024 / 1024)}MB，超过飞书 20MB 上传上限，请压缩图片后重试`
    )
  }
  const form = new FormData()
  form.append('file_name', name)
  form.append('parent_type', parentType)
  form.append('parent_node', parentNode)
  form.append('size', String(buffer.byteLength))
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mime }), name)
  const res = await fetch(`${FEISHU_BASE}/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  })
  const data = (await res.json()) as { code: number; msg: string; data?: { file_token?: string } }
  if (data.code !== 0 || !data.data?.file_token) {
    throw new Error(
      `上传「${name}」失败（${data.code}）：${data.msg}（请到飞书开放平台 → 权限管理，为该应用开通云文档上传权限 drive:file:upload 或 drive:drive，并重新发布应用版本）`
    )
  }
  return data.data.file_token
}

/** 更新块（replace_image / replace_file 等 patch 操作） */
async function patchBlock(token: string, docId: string, blockId: string, patch: Record<string, unknown>): Promise<void> {
  await feishuRetry(() =>
    feishuJson(
      token,
      `${FEISHU_BASE}/docx/v1/documents/${docId}/blocks/${blockId}?document_revision_id=-1`,
      patch,
      'PATCH'
    )
  )
}

/** 删除文档的最后一个子块（上传失败时清理空图片/文件块，避免文档里留下一直转圈的占位块） */
async function deleteLastBlock(token: string, docId: string): Promise<void> {
  try {
    const data = await feishuJson<{ items?: unknown[] }>(
      token,
      `${FEISHU_BASE}/docx/v1/documents/${docId}/blocks/${docId}/children?page_size=500`,
      undefined,
      'GET'
    )
    const count = data.items?.length ?? 0
    if (count === 0) return
    await feishuJson(
      token,
      `${FEISHU_BASE}/docx/v1/documents/${docId}/blocks/${docId}/children?document_revision_id=-1&start_index=${count - 1}&end_index=${count}`,
      undefined,
      'DELETE'
    )
  } catch {
    // 清理失败不影响主流程（最多留一个空块）
  }
}

/** 图片插入三步流：建空图片块 → 上传素材（挂到该块）→ replace_image（直接带 token 创建的图片块不显示） */
async function insertImage(token: string, docId: string, dataUrl: string, name: string): Promise<void> {
  const blockId = await createEmptyMediaBlock(token, docId, { block_type: 27, image: { token: '' } })
  try {
    const fileToken = await uploadMedia(token, blockId, dataUrl, `${name}.jpg`, 'docx_image', 'image/jpeg')
    await patchBlock(token, docId, blockId, { replace_image: { token: fileToken } })
  } catch (err) {
    // 上传/替换失败：删掉空图片块，避免文档里留下一直加载的占位块
    await deleteLastBlock(token, docId)
    throw err
  }
}

/** HTML 报告附件三步流：建空文件块 → 上传 docx_file → replace_file */
async function insertFileAttachment(token: string, docId: string, dataUrl: string, name: string): Promise<void> {
  const blockId = await createEmptyMediaBlock(token, docId, { block_type: 23, file: { token: '' } })
  try {
    const fileToken = await uploadMedia(token, blockId, dataUrl, name, 'docx_file', 'text/html')
    await patchBlock(token, docId, blockId, { replace_file: { token: fileToken } })
  } catch (err) {
    await deleteLastBlock(token, docId)
    throw err
  }
}

interface TableCellText {
  content: string
  bold?: boolean
}

/**
 * 用「创建嵌套块」接口插入带内容的表格（block_type 31 table + 32 table_cell + 2 text 一次成型）。
 * 行数过多时按 chunkSize 拆成多个表格（每段都带表头），规避单次嵌套块数量限制。
 */
/** 插入表格（block_type 31）：一次建表+单元格+文本，行数多时按 chunkSize 分段（续表重复表头）；columnWidths 控制各列宽（px，总宽约 780） */
async function insertTable(
  token: string,
  docId: string,
  rows: TableCellText[][],
  chunkSize = 10,
  columnWidths?: number[]
): Promise<void> {
  const colSize = rows[0]?.length ?? 0
  if (!colSize) return
  let seq = 0
  const idPrefix = `uwt${Date.now().toString(36)}`
  const nextId = (): string => `${idPrefix}${seq++}`
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = start === 0 ? rows.slice(0, chunkSize) : [rows[0], ...rows.slice(start, start + chunkSize)]
    const tableId = nextId()
    const cellIds: string[] = []
    for (let i = 0; i < chunk.length * colSize; i++) cellIds.push(nextId())
    const descendants: unknown[] = [
      {
        block_id: tableId,
        block_type: 31,
        table: {
          property: {
            row_size: chunk.length,
            column_size: colSize,
            ...(columnWidths && columnWidths.length === colSize ? { column_width: columnWidths } : {})
          }
        },
        children: cellIds
      }
    ]
    cellIds.forEach((cellId, idx) => {
      const cell = chunk[Math.floor(idx / colSize)][idx % colSize]
      const textId = nextId()
      descendants.push({ block_id: cellId, block_type: 32, table_cell: {}, children: [textId] })
      descendants.push({
        block_id: textId,
        block_type: 2,
        text: {
          elements: [
            { text_run: { content: cell.content, ...(cell.bold ? { text_element_style: { bold: true } } : {}) } }
          ]
        },
        children: []
      })
    })
    await feishuRetry(() =>
      feishuJson(
        token,
        `${FEISHU_BASE}/docx/v1/documents/${docId}/blocks/${docId}/descendant?document_revision_id=-1`,
        { index: -1, children_id: [tableId], descendants }
      )
    )
  }
}

/**
 * 创建「问题明细」多维表格（Bitable）：状态为单选可直接切换，前端开发为人员字段可直接选人。
 * 建表后删除应用自带的默认空「数据表」，并开放组织内链接编辑权限（团队均可编辑）。
 * 返回可点击打开的表格链接与非致命 warning（权限类失败不阻塞，随文档 message 透出）；
 * 致命失败即抛错（调用方降级为文档内表格）。
 */
async function createIssueBitable(
  token: string,
  title: string,
  issues: FeishuReportPayload['issues']
): Promise<{ url: string; warnings: string[] }> {
  const softWarnings: string[] = []
  let appToken = ''
  try {
    // 1. 创建多维表格应用
    const app = await feishuRetry(() =>
      feishuJson<{ app: { app_token: string } }>(token, `${FEISHU_BASE}/bitable/v1/apps`, {
        name: `问题明细 - ${title}`
      })
    )
    appToken = app.app.app_token

    // 2. 建表（字段：序号/问题描述/严重度/分类/状态/标注图/前端开发-人员）
    const option = (name: string, color: number): { name: string; color: number } => ({ name, color })
    const tbl = await feishuRetry(() =>
      feishuJson<{ table_id: string }>(token, `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables`, {
        table: {
          name: '问题明细',
          fields: [
            { field_name: '序号', type: 2, property: { formatter: '0' } },
            { field_name: '问题描述', type: 1 },
            {
              field_name: '严重度',
              type: 3,
              property: { options: [option('严重', 21), option('一般', 53), option('建议', 0)] }
            },
            {
              field_name: '分类',
              type: 3,
              property: {
                options: [
                  option('间距规范', 3),
                  option('文字排版', 5),
                  option('颜色规范', 1),
                  option('样式规范', 21),
                  option('交互体验', 24),
                  option('兼容性问题', 13)
                ]
              }
            },
            {
              field_name: '状态',
              type: 3,
              property: {
                options: [
                  option('待修复', 21),
                  option('修复中', 53),
                  option('已修复', 1),
                  option('已忽略', 0),
                  option('设计确认不改', 3)
                ]
              }
            },
            { field_name: '标注图', type: 1 },
            // 前端开发：人员字段（type 11），在多维表里直接选人分配
            { field_name: '前端开发', type: 11, property: { multiple: false } }
          ]
        }
      })
    )
    const tableId = tbl.table_id

    // 3. 批量写入记录（每批最多 100 条；人员字段留空，由使用者在多维表中选人）
    const records = issues.map((i) => ({
      fields: {
        序号: i.no,
        问题描述: i.title,
        严重度: i.severityLabel,
        分类: i.categoryLabel,
        状态: i.statusLabel,
        标注图: i.targetLabel
      }
    }))
    for (let i = 0; i < records.length; i += 100) {
      const chunk = records.slice(i, i + 100)
      await feishuRetry(() =>
        feishuJson(token, `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, {
          records: chunk
        })
      )
    }

    // 4. 删除创建应用时自带的默认空「数据表」，只保留问题明细表（失败不阻塞，仅提示）
    try {
      const list = await feishuRetry(() =>
        feishuJson<{ items?: { table_id: string }[] }>(
          token,
          `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables?page_size=100`,
          undefined,
          'GET'
        )
      )
      for (const t of list.items ?? []) {
        if (t.table_id && t.table_id !== tableId) {
          await feishuRetry(() =>
            feishuJson(
              token,
              `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${t.table_id}`,
              undefined,
              'DELETE'
            )
          )
        }
      }
    } catch (err) {
      softWarnings.push(
        `默认空「数据表」删除失败（${err instanceof Error ? err.message : String(err)}），可在多维表中手动删除`
      )
    }

    // 5. 开放编辑权限：组织内获得链接的人可编辑（团队成员均可直接修改）；失败不阻塞，仅提示
    try {
      await feishuRetry(() =>
        feishuJson(
          token,
          `${FEISHU_BASE}/drive/v1/permissions/${appToken}/public?type=bitable`,
          { link_share_entity: 'tenant_editable' },
          'PATCH'
        )
      )
    } catch (err) {
      softWarnings.push(
        `已创建多维表，但开放团队编辑权限失败（${err instanceof Error ? err.message : String(err)}），可在多维表右上角「分享」手动设置「组织内获得链接的人可编辑」`
      )
    }

    return { url: `https://feishu.cn/base/${appToken}`, warnings: softWarnings }
  } catch (err) {
    // 应用/表已建但记录写入失败：删除空多维表避免留下「空表格」误导用户，再把错误抛给降级逻辑
    if (appToken) {
      try {
        // 多维表是云文档文件，删除走 drive 接口（bitable/v1/apps 无 DELETE 路由，会 404）
        await feishuJson(token, `${FEISHU_BASE}/drive/v1/files/${appToken}?type=bitable`, undefined, 'DELETE')
      } catch (delErr) {
        // 清理失败（常见为缺 drive:drive / space:document:delete 权限）：把残留提示并入错误信息随降级 warning 透出
        const delMsg = delErr instanceof Error ? delErr.message : String(delErr)
        if (err instanceof Error) {
          err.message = `${err.message}；删除空多维表也失败（${delMsg}），飞书里会残留一个空表，可到开放平台开通 drive:drive 或 space:document:delete 权限后重试，或手动删除该空表`
        }
      }
    }
    throw err
  }
}

function registerFeishuHandlers(): void {
  // 测试飞书应用凭据
  ipcMain.handle('feishu:test', async (): Promise<{ ok: boolean; message: string }> => {
    try {
      await getTenantToken()
      return { ok: true, message: '飞书应用验证通过' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // 一键创建走查报告飞书文档：概况 + 统计表 + 截图 + 明细表 + 建议表 + HTML 报告附件，成功后自动打开
  ipcMain.handle(
    'feishu:createReport',
    async (_e, payload: FeishuReportPayload): Promise<{ ok: boolean; url?: string; message: string }> => {
      const warnings: string[] = []
      try {
        const token = await getTenantToken()
        // 1. 创建文档
        const doc = await feishuJson<{ document: { document_id: string } }>(
          token,
          `${FEISHU_BASE}/docx/v1/documents`,
          { title: payload.title }
        )
        const docId = doc.document.document_id

        // 2. 走查概况
        await appendTextBlocks(token, docId, [heading2('走查概况'), ...payload.metaLines.map((l) => textBlock(l))])

        // 3. 问题统计（表格；失败降级为文本行）
        try {
          await insertTable(
            token,
            docId,
            [
              [{ content: '指标', bold: true }, { content: '数值', bold: true }],
              ...payload.stats.map((s) => [{ content: s.label }, { content: s.value }])
            ],
            10,
            [150, 630]
          )
        } catch (err) {
          warnings.push('统计表格创建失败，已用文本展示')
          await appendTextBlocks(token, docId, [
            ...payload.stats.map((s) => textBlock(`${s.label}：${s.value}`)),
            textBlock(err instanceof Error ? err.message : String(err))
          ])
        }

        // 4. 页面截图（官方三步流；单张失败不阻塞其余）
        if (payload.images.length) {
          await appendTextBlocks(token, docId, [heading2('页面截图')])
          for (const img of payload.images) {
            if (!img.dataUrl) continue
            try {
              await appendTextBlocks(token, docId, [textBlock(img.name, true)])
              await insertImage(token, docId, img.dataUrl, img.name)
            } catch (err) {
              warnings.push(`截图「${img.name}」插入失败：${err instanceof Error ? err.message : String(err)}`)
            }
          }
        }

        // 5. 问题明细（优先创建可交互的多维表格：状态单选可切换 + 前端开发分配列；失败降级为文档内表格）
        await appendTextBlocks(token, docId, [heading2('问题明细')])
        if (!payload.issues.length) {
          await appendTextBlocks(token, docId, [textBlock('本次走查未发现需要处理的问题。')])
        } else {
          try {
            const bitable = await createIssueBitable(token, payload.title, payload.issues)
            bitable.warnings.forEach((w) => warnings.push(w))
            await appendTextBlocks(token, docId, [
              textBlock('问题明细已生成多维表格（仅含问题明细表，状态可直接切换、可直接分配前端开发，团队内获得链接的人均可编辑）：'),
              linkTextBlock('打开问题明细多维表 ↗', bitable.url, true)
            ])
          } catch (bitableErr) {
            warnings.push(
              `多维表格创建失败已降级为文档表格：${bitableErr instanceof Error ? bitableErr.message : String(bitableErr)}（若提示权限不足，请在飞书开放平台为应用开通 bitable:app 权限并重新发布版本）`
            )
            try {
              await insertTable(
                token,
                docId,
                [
                  [
                    { content: '序号', bold: true },
                    { content: '问题描述', bold: true },
                    { content: '严重度', bold: true },
                    { content: '分类', bold: true },
                    { content: '标注图', bold: true },
                    { content: '状态', bold: true }
                  ],
                  ...payload.issues.map((i) => [
                    { content: String(i.no) },
                    { content: i.title },
                    { content: i.severityLabel },
                    { content: i.categoryLabel },
                    { content: i.targetLabel },
                    { content: i.statusLabel }
                  ])
                ],
                10,
                [52, 300, 76, 108, 84, 160]
              )
            } catch (err) {
              warnings.push('明细表格创建失败，已用文本展示')
              const fallback: Block[] = payload.issues.flatMap((i) => [
                textBlock(`${i.no}. ${i.title}`, true),
                textBlock(`严重度：${i.severityLabel}　分类：${i.categoryLabel}　标注图：${i.targetLabel}　状态：${i.statusLabel}`)
              ])
              await appendTextBlocks(token, docId, fallback)
            }
          }
        }

        // 6. 修复建议（仅列出带 AI 结构化建议的条目）
        const sugIssues = payload.issues.filter((i) => i.suggestion?.current || i.suggestion?.fix)
        if (sugIssues.length) {
          await appendTextBlocks(token, docId, [heading2('修复建议')])
          try {
            await insertTable(
              token,
              docId,
              [
                [
                  { content: '序号', bold: true },
                  { content: '问题描述', bold: true },
                  { content: '现状', bold: true },
                  { content: '建议改法', bold: true },
                  { content: '涉及属性', bold: true }
                ],
                ...sugIssues.map((i) => [
                  { content: String(i.no) },
                  { content: i.title },
                  { content: i.suggestion?.current ?? '—' },
                  { content: i.suggestion?.fix ?? '—' },
                  { content: i.suggestion?.properties || '—' }
                ])
              ],
              10,
              [56, 280, 170, 180, 94]
            )
          } catch (err) {
            warnings.push('建议表格创建失败，已用文本展示')
            const fallback: Block[] = sugIssues.flatMap((i) => [
              textBlock(`${i.no}. ${i.title}`, true),
              textBlock(`现状：${i.suggestion?.current ?? '—'}`),
              textBlock(`建议改法：${i.suggestion?.fix ?? '—'}`),
              textBlock(`涉及属性：${i.suggestion?.properties || '—'}`)
            ])
            await appendTextBlocks(token, docId, fallback)
          }
        }

        // 7. 交互式 HTML 报告附件（可点击打开；失败不阻塞文档）
        if (payload.htmlReport?.dataUrl) {
          await appendTextBlocks(token, docId, [
            heading2('交互式报告附件'),
            textBlock('点击下方附件可在浏览器中打开完整交互式报告（图上标注可点击、可直接回应修复结果）。')
          ])
          try {
            await insertFileAttachment(token, docId, payload.htmlReport.dataUrl, payload.htmlReport.name)
          } catch (err) {
            warnings.push(`HTML 报告附件上传失败：${err instanceof Error ? err.message : String(err)}`)
          }
        }

        const url = `https://feishu.cn/docx/${docId}`
        await shell.openExternal(url).catch(() => undefined)
        return {
          ok: true,
          url,
          message: warnings.length ? `文档创建成功（${warnings.join('；')}）` : '文档创建成功'
        }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}

export { registerFeishuHandlers }
