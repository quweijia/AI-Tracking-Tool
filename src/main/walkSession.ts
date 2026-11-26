import { app, ipcMain, safeStorage, session, webContents, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { WalkSessionCookie, WalkSessionProfile } from '../shared/types'

/**
 * 自动走查会话 profile 管理
 *
 * 登录窗口命中「登录成功标识」后，抓取 webview 上下文（cookies / localStorage /
 * sessionStorage / indexedDB），经 safeStorage（系统钥匙串/凭据管理器）加密后按域名
 * 落盘到 userData/audit-sessions/<host>.json。后续同域名走查优先加载 profile：
 * Cookie 注入到 persist:walkthrough 分区，Web 存储通过 CDP
 * Page.addScriptToEvaluateOnNewDocument 在页面脚本执行前恢复。
 */

const PARTITION = 'persist:walkthrough'
const SESSION_DIR = 'audit-sessions'

/** 落盘包装结构：blob 为加密（或降级 base64）后的 profile JSON */
interface ProfileFile {
  version: 1
  /** true = safeStorage 加密；false = 环境不支持加密时的 base64 降级 */
  enc: boolean
  createdAt: number
  blob: string
}

function sessionsDir(): string {
  const dir = join(app.getPath('userData'), SESSION_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function domainOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function profilePath(url: string): string {
  const host = domainOf(url).replace(/[^a-zA-Z0-9._-]+/g, '_')
  return join(sessionsDir(), `${host || 'unknown'}.json`)
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function normalizeSameSite(
  raw: string | undefined,
  secure: boolean | undefined
): Electron.CookiesSetDetails['sameSite'] {
  if (raw !== 'lax' && raw !== 'strict' && raw !== 'no_restriction' && raw !== 'unspecified') return undefined
  // Chromium 要求 no_restriction 必须 Secure
  if (raw === 'no_restriction' && !secure) return 'lax'
  return raw
}

/** 读取（解密）指定 URL 域名的会话 profile；不存在或损坏返回 null */
function loadProfile(url: string): WalkSessionProfile | null {
  const file = profilePath(url)
  if (!domainOf(url) || !existsSync(file)) return null
  try {
    const wrap = JSON.parse(readFileSync(file, 'utf-8')) as ProfileFile
    if (!wrap?.blob) return null
    let json: string
    if (wrap.enc) {
      if (!safeStorage.isEncryptionAvailable()) return null
      // decryptString 返回已解码的 UTF-8 字符串
      json = safeStorage.decryptString(Buffer.from(wrap.blob, 'base64'))
    } else {
      json = Buffer.from(wrap.blob, 'base64').toString('utf-8')
    }
    const profile = JSON.parse(json) as WalkSessionProfile
    if (!profile || !profile.origin) return null
    return profile
  } catch {
    return null
  }
}

/** 组装并加密保存 profile：Cookie 从 walkthrough 分区读取，存储数据由登录窗口传入 */
async function saveProfile(
  url: string,
  marker: string | undefined,
  storage: { ls?: Record<string, string>; ss?: Record<string, string>; idb?: WalkSessionProfile['indexedDB'] }
): Promise<{ ok: boolean; message: string }> {
  const domain = domainOf(url)
  if (!domain) return { ok: false, message: 'URL 无效，无法保存会话' }
  let cookies: WalkSessionCookie[] = []
  try {
    const ses = session.fromPartition(PARTITION)
    const hostSuffix = domain.split(':')[0]
    cookies = (await ses.cookies.get({})).filter((c) => {
        const d = (c.domain || '').replace(/^\./, '')
        // 仅保留目标域名（含子域）的 Cookie
        return d === hostSuffix || d.endsWith(`.${hostSuffix}`) || hostSuffix.endsWith(`.${d}`)
      })
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expirationDate: c.expirationDate,
        sameSite: c.sameSite
      }))
  } catch {
    // Cookie 读取失败不阻断保存（localStorage 等仍可能承载登录态）
  }
  const profile: WalkSessionProfile = {
    origin: originOf(url),
    targetUrl: url,
    domain,
    marker: marker?.trim() || undefined,
    cookies,
    localStorage: storage?.ls || {},
    sessionStorage: storage?.ss || {},
    indexedDB: Array.isArray(storage?.idb) ? storage.idb : [],
    createdAt: Date.now()
  }
  const json = JSON.stringify(profile)
  const canEncrypt = safeStorage.isEncryptionAvailable()
  const blob = canEncrypt
    ? safeStorage.encryptString(json).toString('base64')
    : Buffer.from(json, 'utf-8').toString('base64')
  const wrap: ProfileFile = { version: 1, enc: canEncrypt, createdAt: profile.createdAt, blob }
  try {
    writeFileSync(profilePath(url), JSON.stringify(wrap), 'utf-8')
    return { ok: true, message: canEncrypt ? '会话已加密保存' : '会话已保存（当前环境不支持加密）' }
  } catch (err) {
    return { ok: false, message: `会话保存失败：${String((err as Error)?.message || err)}` }
  }
}

/** 将 profile 中的 Cookie 注入 walkthrough 分区（同域名走查优先加载 profile） */
async function injectCookies(profile: WalkSessionProfile): Promise<{ ok: boolean; count: number }> {
  if (!profile?.cookies?.length) return { ok: true, count: 0 }
  const ses = session.fromPartition(PARTITION)
  let count = 0
  for (const c of profile.cookies) {
    try {
      const host = (c.domain || profile.domain).replace(/^\./, '')
      const scheme = c.secure ? 'https' : 'http'
      await ses.cookies.set({
        url: `${scheme}://${host}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        ...(c.domain ? { domain: c.domain } : {}),
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        ...(c.expirationDate && c.expirationDate * 1000 > Date.now() ? { expirationDate: c.expirationDate } : {}),
        ...(c.sameSite ? { sameSite: normalizeSameSite(c.sameSite, c.secure) } : {})
      })
      count += 1
    } catch {
      // 单条 Cookie 失败（过期/属性非法）不影响其余注入
    }
  }
  return { ok: true, count }
}

// ===== CDP 注入：页面脚本执行前恢复 localStorage / sessionStorage / indexedDB =====

/** webContentsId → 最近一次注入脚本的 CDP identifier（新 profile 注入前先移除旧脚本） */
const initScriptIds = new Map<number, string>()

/** 值解码器 + 逐库恢复逻辑，与登录窗口侧的抓取脚本（类型标记 __t）配对 */
function buildRestoreScript(profile: WalkSessionProfile): string {
  const payload = {
    origin: profile.origin,
    ls: profile.localStorage || {},
    ss: profile.sessionStorage || {},
    idb: profile.indexedDB || []
  }
  return `
;(function () {
  try {
    if (location.origin !== ${JSON.stringify(payload.origin)}) return
    var D = ${JSON.stringify(payload)}
    function put(db, k, v) { try { db.setItem(k, v) } catch (e) {} }
    for (var k in D.ls) put(window.localStorage, k, D.ls[k])
    for (var k2 in D.ss) put(window.sessionStorage, k2, D.ss[k2])
    var dbs = D.idb || []
    if (!dbs.length) return
    function b64ToAb(b) { var s = atob(b), n = s.length, u = new Uint8Array(n); while (n--) u[n] = s.charCodeAt(n); return u.buffer }
    function dec(v) {
      if (v && typeof v === 'object' && typeof v.__t === 'string') {
        try {
          if (v.__t === 'date') return new Date(v.v)
          if (v.__t === 'ab') return b64ToAb(v.v)
          if (v.__t === 'ta') { var ab = b64ToAb(v.v); return new (window[v.t] || Uint8Array)(ab) }
          if (v.__t === 'undef') return undefined
        } catch (e) { return undefined }
      }
      return v
    }
    var i = 0
    ;(function next() {
      if (i >= dbs.length) return
      var d = dbs[i++]
      var open = function () { try { return d.version ? indexedDB.open(d.name, d.version) : indexedDB.open(d.name) } catch (e) { return null } }
      var req = open()
      if (!req) { next(); return }
      req.onupgradeneeded = function () {
        var db = req.result
        ;(d.stores || []).forEach(function (s) {
          if (!db.objectStoreNames.contains(s.name)) {
            try {
              var os = db.createObjectStore(s.name, { keyPath: s.keyPath == null ? null : s.keyPath, autoIncrement: !!s.autoIncrement })
              ;(s.indexes || []).forEach(function (ix) { try { os.createIndex(ix.name, ix.keyPath, { unique: !!ix.unique }) } catch (e) {} })
            } catch (e) {}
          }
        })
      }
      req.onsuccess = function () {
        var db = req.result
        var names = (d.stores || []).filter(function (s) { return db.objectStoreNames.contains(s.name) }).map(function (s) { return s.name })
        if (!names.length) { db.close(); next(); return }
        try {
          var tx = db.transaction(names, 'readwrite')
          ;(d.stores || []).forEach(function (s) {
            if (names.indexOf(s.name) < 0) return
            try {
              var os = tx.objectStore(s.name)
              ;(s.records || []).forEach(function (r) {
                try {
                  var val = dec(r.value)
                  if (s.keyPath == null && r.key !== undefined && r.key !== null) os.put(val, dec(r.key))
                  else os.put(val)
                } catch (e) {}
              })
            } catch (e) {}
          })
          tx.oncomplete = function () { db.close(); next() }
          tx.onerror = tx.onabort = function () { try { db.close() } catch (e) {} next() }
        } catch (e) { try { db.close() } catch (x) {} next() }
      }
      req.onerror = function () { next() }
      req.onblocked = function () { next() }
    })()
  } catch (e) {}
})()`
}

/** 在目标 webview（webContentsId）上注册「文档创建前执行」的存储恢复脚本 */
async function initStorageScript(webContentsId: number, profile: WalkSessionProfile) {
  const wc = webContents.fromId(webContentsId)
  if (!wc || wc.isDestroyed()) return { ok: false, message: 'webview 尚未就绪' }
  const dbg = wc.debugger
  const old = initScriptIds.get(webContentsId)
  if (old) {
    try {
      await dbg.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: old })
    } catch {}
    initScriptIds.delete(webContentsId)
  }
  if (!dbg.isAttached()) dbg.attach('1.3')
  await dbg.sendCommand('Page.enable').catch(() => undefined)
  const res = (await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
    source: buildRestoreScript(profile)
  })) as { identifier?: string }
  if (res?.identifier) initScriptIds.set(webContentsId, res.identifier)
  wc.once('destroyed', () => initScriptIds.delete(webContentsId))
  return { ok: true }
}

/** 登录流程结果（成功 / 窗口被手动关闭）转发主窗口，供自动走查恢复或终止 */
export function forwardLoginResult(type: 'success' | 'closed'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.getURL().includes('/browser')) continue
    win.webContents.send('walk:login-result', type)
  }
}

export function registerWalkSessionHandlers(): void {
  // 登录成功/窗口被手动关闭 → 转发主窗口（自动走查恢复或终止）
  ipcMain.on('browser:login-result', (_e, type: 'success' | 'closed') => forwardLoginResult(type))
  ipcMain.handle('walkSession:load', (_e, url: string) => {
    const profile = loadProfile(String(url || ''))
    return { found: !!profile, profile }
  })
  ipcMain.handle(
    'walkSession:save',
    (_e, payload: { url: string; marker?: string; ls?: Record<string, string>; ss?: Record<string, string>; idb?: WalkSessionProfile['indexedDB'] }) =>
      saveProfile(payload?.url || '', payload?.marker, payload || {})
  )
  ipcMain.handle('walkSession:injectCookies', (_e, profile: WalkSessionProfile) => injectCookies(profile))
  ipcMain.handle('walkSession:initStorage', (_e, webContentsId: number, profile: WalkSessionProfile) =>
    initStorageScript(Number(webContentsId), profile)
  )
}
