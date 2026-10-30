/**
 * engine-bridge CLI（第一阶段引擎复用）：
 * SwiftUI 原生壳通过 Process 调用本命令行，复用 Electron 版纯逻辑引擎模块
 * （模糊匹配 / 结构化样式比对 / Figma REST / 规范 Token 校验 / 元素清单 / a11y）。
 *
 * 协议：argv[2] = 子命令；stdin = JSON 入参；stdout = 单个 JSON 出参（ok 字段标识成败，始终 exit 0）。
 * 子命令：
 *  - compare          结构化样式比对（镜像 walkthrough:compare IPC；pairs 体积大且壳层暂用不到，不回传）
 *  - figma-node-size  轻量读取 Figma Frame 尺寸（视口宽度自动匹配）
 *  - figma-design     拉取设计稿树 + Frame 截图（截图 PNG 与树 JSON 落盘 outScreenshot/outRoot，避免管道传 MB 级 base64）
 *  - check-spec       设计规范 Token 校验（Token 列表由 Swift 侧从 SwiftData 组装）
 *  - check-elements   元素清单一致性校验（图片加载失败 / 元素缺失 / 文案不一致）
 *  - check-a11y       无障碍检查
 *  - spec-sync        Figma Token 三级解析（Variables → Styles → 启发式；variableDenied 时 ok=false 透传）
 *  - figma-file-meta  批量轻量读取 Figma 文件 last_modified（检查更新）
 *  - spec-import-json Token JSON 导入解析（Figma REST 同构 / Tokens Studio / W3C DTCG）
 *  - export-tokens    Token 多格式导出（json / css / tailwind）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { matchNodes } from '../../../src/main/matcher'
import { computeDiffs } from '../../../src/main/diff'
import { normalizeTolerance } from '../../../src/shared/types'
import { fetchFigmaDesign, fetchFigmaFileMeta, fetchFigmaNodeSize, setFigmaCustomProxy } from '../../../src/main/figma'
import { syncSpecTokens } from '../../../src/main/specSync'
import { parseVariablesJsonBundle } from '../../../src/shared/variablesImport'
import { exportTokens } from '../../../src/shared/tokenExport'
import { checkSpec } from '../../../src/renderer/src/spec/specCheck'
import { checkElements } from '../../../src/renderer/src/spec/elementCheck'
import { checkA11y } from '../../../src/renderer/src/spec/a11yCheck'

type AnyRecord = Record<string, any>

/** 读取 stdin JSON 入参（空输入视为空对象） */
function readStdin(): AnyRecord {
  const raw = readFileSync(0, 'utf8').trim()
  return raw ? (JSON.parse(raw) as AnyRecord) : {}
}

/** 输出里的节点只保留回溯字段 domPath（children 子树体积大，壳层落库用不到） */
function nodeRef(n: AnyRecord | undefined | null): { domPath?: string } | undefined {
  if (!n) return undefined
  return { domPath: n.domPath }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? ''
  try {
    const input = readStdin()
    let out: AnyRecord
    switch (command) {
      case 'compare': {
        const { designRoot, domRoot, viewport } = input
        if (!designRoot || !domRoot) throw new Error('compare 缺少 designRoot / domRoot 入参')
        const tolerance = normalizeTolerance(input.tolerance)
        const { pairs, unmatchedDesignCount, unmatchedDomCount } = matchNodes(designRoot, domRoot)
        const diffs = computeDiffs(pairs, tolerance, viewport, input.includeSizeSpacing !== false)
        out = { ok: true, diffs, unmatchedDesignCount, unmatchedDomCount }
        break
      }
      case 'figma-node-size': {
        if (typeof input.proxy === 'string') setFigmaCustomProxy(input.proxy)
        out = (await fetchFigmaNodeSize({ pat: input.pat, figmaUrl: input.figmaUrl })) as AnyRecord
        break
      }
      case 'figma-design': {
        if (typeof input.proxy === 'string') setFigmaCustomProxy(input.proxy)
        const res = await fetchFigmaDesign({ pat: input.pat, figmaUrl: input.figmaUrl, scale: input.scale })
        if (!res.ok || !res.data) {
          out = { ok: false, message: res.message }
          break
        }
        // 截图 base64 → PNG 文件；设计稿树 → JSON 文件（壳层原样透传给后续校验命令）
        const shot = res.data.screenshotDataUrl as string
        writeFileSync(String(input.outScreenshot), Buffer.from(shot.slice(shot.indexOf(',') + 1), 'base64'))
        writeFileSync(String(input.outRoot), JSON.stringify({ root: res.data.root, nodes: res.data.nodes }))
        out = {
          ok: true,
          message: res.message,
          fileKey: res.data.fileKey,
          nodeId: res.data.nodeId,
          nodeName: res.data.nodeName,
          frameSize: res.data.frameSize,
          scale: res.data.scale,
          skippedCount: res.data.skippedCount
        }
        break
      }
      case 'check-spec': {
        if (!input.domRoot) throw new Error('check-spec 缺少 domRoot 入参')
        const violations = checkSpec(
          input.domRoot,
          input.tokens ?? [],
          input.viewport,
          normalizeTolerance(input.tolerance)
        )
        out = {
          ok: true,
          violations: violations.map((v) => ({ ...v, node: nodeRef(v.node as AnyRecord) }))
        }
        break
      }
      case 'check-elements': {
        if (!input.designRoot || !input.domRoot) throw new Error('check-elements 缺少 designRoot / domRoot 入参')
        const findings = checkElements(input.designRoot, input.domRoot, input.frameSize, input.viewport)
        out = {
          ok: true,
          findings: findings.map((f) => ({
            ...f,
            node: nodeRef(f.node as AnyRecord | undefined),
            designNode: nodeRef(f.designNode as AnyRecord | undefined)
          }))
        }
        break
      }
      case 'check-a11y': {
        if (!input.domRoot) throw new Error('check-a11y 缺少 domRoot 入参')
        const findings = checkA11y(input.domRoot, input.viewport)
        out = {
          ok: true,
          findings: findings.map((f) => ({ ...f, node: nodeRef(f.node as AnyRecord) }))
        }
        break
      }
      case 'spec-sync': {
        if (typeof input.proxy === 'string') setFigmaCustomProxy(input.proxy)
        // syncSpecTokens 失败会 throw（PAT 缺失 / 链接不合法 / 全级无数据），包为 ok=false 透传；
        // variableDenied（变量级 403）时内部返回 ok=false 且 variableDenied=true，同样透传
        try {
          out = (await syncSpecTokens({
            pat: input.pat,
            figmaUrl: input.figmaUrl,
            startLevel: input.startLevel
          })) as AnyRecord
        } catch (err) {
          out = { ok: false, message: err instanceof Error ? err.message : String(err) }
        }
        break
      }
      case 'figma-file-meta': {
        if (typeof input.proxy === 'string') setFigmaCustomProxy(input.proxy)
        const fileKeys: string[] = Array.isArray(input.fileKeys) ? input.fileKeys.filter(Boolean) : []
        // 串行避免 Figma 限流（对齐主进程 spec:checkUpdates IPC）
        const metas: AnyRecord[] = []
        for (const fileKey of fileKeys) {
          const meta = await fetchFigmaFileMeta(fileKey, input.pat)
          metas.push({ fileKey, ...meta })
        }
        out = { ok: true, metas }
        break
      }
      case 'spec-import-json': {
        const files: { text: string; name?: string }[] = Array.isArray(input.files) ? input.files : []
        if (!files.length)
          throw new Error('未识别到任何 Token：支持 Figma Variables 导出格式（meta.variables / variables 键）与 Tokens Studio / W3C DTCG 嵌套格式（value/$value + type/$type），请确认导出的 JSON 文件内容')
        const tokens = parseVariablesJsonBundle(files)
        out = { ok: true, tokens }
        break
      }
      case 'export-tokens': {
        const tokens: AnyRecord[] = Array.isArray(input.tokens) ? input.tokens : []
        const format = String(input.format ?? 'json')
        if (!['json', 'css', 'tailwind'].includes(format)) throw new Error(`不支持的导出格式：${format}`)
        out = { ok: true, text: exportTokens(tokens as any, format as 'json' | 'css' | 'tailwind') }
        break
      }
      default:
        throw new Error(`未知子命令：${command}`)
    }
    process.stdout.write(JSON.stringify(out))
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, message: err instanceof Error ? err.message : String(err) }))
  }
}

void main()
