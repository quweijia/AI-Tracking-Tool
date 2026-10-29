import { app, ipcMain } from 'electron'
import { spawn } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

/**
 * 客观走查门（gates）：来自开源项目 ux-ui-agent-skills（MIT）的 52 项客观质量门，
 * vendor 在 resources/gates/（scripts/ 为各 gate 脚本，mcp/ 为目录协议适配层）。
 * 每个 gate 对渲染后的 HTML 做真实测量（对比度、触控目标、键盘、溢出、意图用色等），
 * 输出「测量结果」而非「主观判断」，与 AI 视觉走查形成互补的两层架构。
 */

/** gate 目录信息（镜像 mcp/gates.mjs 的 catalogue 结构） */
export interface GateInfo {
  name: string
  file: string
  runner: 'node' | 'python3'
  browser: boolean
  measures: string
}

export interface GateRunResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  message?: string
}

/** gates vendor 目录：开发期在应用根 resources/gates；打包后 resources/** 已 asarUnpack */
function resolveGatesDir(): string {
  const appPath = app.getAppPath()
  const base = app.isPackaged ? appPath.replace(/app\.asar$/, 'app.asar.unpacked') : appPath
  return join(base, 'resources', 'gates')
}

let catalogueCache: GateInfo[] | null = null

/** 读取 gate 目录（动态 import vendor 的 mcp/gates.mjs，其仅依赖 Node 内置模块） */
async function loadCatalogue(): Promise<GateInfo[]> {
  if (catalogueCache) return catalogueCache
  const gatesDir = resolveGatesDir()
  const cataloguePath = join(gatesDir, 'mcp', 'gates.mjs')
  if (!existsSync(cataloguePath)) {
    catalogueCache = []
    return catalogueCache
  }
  try {
    const mod = (await import(pathToFileURL(cataloguePath).href)) as {
      catalogue: () => GateInfo[]
    }
    catalogueCache = mod.catalogue()
  } catch {
    catalogueCache = []
  }
  return catalogueCache
}

export interface GateRunInput {
  /** gate 名，来自 gates:list（如 verify_states） */
  name: string
  /** 目标 HTML 文件的绝对路径（与 html 二选一） */
  targets?: string[]
  /** 直接传 HTML 内容：写入临时文件后运行，结束后清理 */
  html?: string
  /** 超时毫秒数，默认 180s */
  timeoutMs?: number
}

function runGateProcess(
  runner: 'node' | 'python3',
  scriptPath: string,
  targets: string[],
  timeoutMs: number
): Promise<GateRunResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    // node gate 用 Electron 自带 Node 运行时执行（打包后无需系统 node）
    const cmd = runner === 'node' ? process.execPath : 'python3'
    const args = runner === 'node' ? [scriptPath, ...targets] : [scriptPath, ...targets]
    const child = spawn(cmd, args, {
      cwd: resolveGatesDir(),
      env: {
        ...process.env,
        // 让 Electron 主进程二进制以纯 Node 模式运行脚本
        ...(runner === 'node' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        // 浏览器不可用时必须 FAIL 而非 SKIPPED——「没测量过不许报通过」
        DS_REQUIRE_BROWSER: '1'
      }
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += String(d)))
    child.stderr.on('data', (d) => (stderr += String(d)))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        exitCode: -1,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        message: `无法启动 ${runner}：${err instanceof Error ? err.message : String(err)}`
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut
      })
    })
  })
}

export function registerGateHandlers(): void {
  // 列出全部可用 gate（名称 / 是否需要浏览器 / 测量内容说明）
  ipcMain.handle('gates:list', async (): Promise<{ ok: boolean; gates: GateInfo[]; message?: string }> => {
    const gates = await loadCatalogue()
    if (gates.length === 0) {
      return { ok: false, gates: [], message: '未找到 gates 目录（resources/gates），请确认 vendor 完整' }
    }
    return { ok: true, gates }
  })

  // 运行单个 gate，返回其真实打印内容与退出码（0=通过 1=发现问题 2=无法测量）
  ipcMain.handle('gates:run', async (_e, input: GateRunInput): Promise<GateRunResult & { gate?: string }> => {
    const gates = await loadCatalogue()
    const gate = gates.find((g) => g.name === input.name)
    if (!gate) {
      return {
        ok: false,
        exitCode: 2,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
        message: `未知 gate：${input.name}（可用列表见 gates:list）`
      }
    }
    let targets = (input.targets ?? []).filter((t) => typeof t === 'string' && t.trim())
    let tempDir: string | null = null
    try {
      if (targets.length === 0 && input.html) {
        // HTML 内容写入临时文件再测量
        tempDir = mkdtempSync(join(tmpdir(), 'walk-gates-'))
        const file = join(tempDir, 'page.html')
        writeFileSync(file, input.html)
        targets = [file]
      }
      if (targets.length === 0) {
        return {
          ok: false,
          exitCode: 2,
          stdout: '',
          stderr: '',
          durationMs: 0,
          timedOut: false,
          message: '缺少测量目标：需提供 targets（HTML 路径）或 html（内容）'
        }
      }
      const scriptPath = join(resolveGatesDir(), 'scripts', gate.file)
      if (!existsSync(scriptPath)) {
        return {
          ok: false,
          exitCode: 2,
          stdout: '',
          stderr: '',
          durationMs: 0,
          timedOut: false,
          message: `gate 脚本缺失：${gate.file}`
        }
      }
      const result = await runGateProcess(gate.runner, scriptPath, targets, input.timeoutMs ?? 180_000)
      return { ...result, gate: gate.name }
    } finally {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    }
  })
}
