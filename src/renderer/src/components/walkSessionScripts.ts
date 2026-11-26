/**
 * 自动走查登录流程的页面内脚本（与登录窗口 DevBrowser 配合使用）
 *
 * - CAPTURE_STORAGE_SCRIPT：登录成功后抓取 webview 上下文快照
 *   （localStorage / sessionStorage / indexedDB，best-effort），返回 JSON 字符串。
 *   Cookie 由主进程从 persist:walkthrough 分区读取，不在页面内采集。
 * - buildLoginProbeScript：轮询探测登录成功（URL / 密码框 / 页面文本 / CSS 选择器）。
 *
 * 抓取值经 enc() 打上 __t 类型标记（date / ab / ta / undef / blob / trunc / skip），
 * 与主进程 walkSession.ts 的恢复脚本（dec()）配对还原。
 */

export const CAPTURE_STORAGE_SCRIPT = `(async () => {
  const out = { ok: true, ls: {}, ss: {}, idb: [] }
  function b64(u) {
    let s = ''
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000))
    return btoa(s)
  }
  function enc(v, depth) {
    if (v === undefined) return { __t: 'undef' }
    if (v === null || typeof v !== 'object') return v
    if (depth > 6) return { __t: 'trunc' }
    try {
      if (v instanceof Date) return { __t: 'date', v: v.toISOString() }
      if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return { __t: 'ab', v: b64(new Uint8Array(v)) }
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(v)) {
        const u = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))
        return { __t: 'ta', t: v.constructor.name, v: b64(u) }
      }
      if (typeof Blob !== 'undefined' && v instanceof Blob) return { __t: 'blob', mime: v.type }
      if (Array.isArray(v)) return v.map((x) => enc(x, depth + 1))
      const o = {}
      for (const k of Object.keys(v)) o[k] = enc(v[k], depth + 1)
      return o
    } catch (e) {
      return { __t: 'skip' }
    }
  }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k != null) out.ls[k] = localStorage.getItem(k)
    }
  } catch (e) {}
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k != null) out.ss[k] = sessionStorage.getItem(k)
    }
  } catch (e) {}
  function readStore(os) {
    const store = { name: os.name, keyPath: os.keyPath == null ? null : os.keyPath, autoIncrement: !!os.autoIncrement, indexes: [], records: [] }
    try {
      for (const ix of Array.from(os.indexNames)) {
        const io = os.index(ix)
        store.indexes.push({ name: ix, keyPath: io.keyPath, unique: !!io.unique })
      }
      const vals = os.getAll()
      vals.onsuccess = () => {
        store.records = (vals.result || []).slice(0, 500).map((v) => ({ value: enc(v, 0) }))
      }
      if (store.keyPath == null) {
        const keys = os.getAllKeys()
        keys.onsuccess = () => {
          const ks = (keys.result || []).slice(0, 500)
          ks.forEach((k, i) => {
            if (store.records[i]) store.records[i].key = enc(k, 0)
          })
        }
      }
    } catch (e) {}
    return store
  }
  function readDb(name, version) {
    return new Promise((resolve) => {
      let req
      try {
        req = version ? indexedDB.open(name, version) : indexedDB.open(name)
      } catch (e) {
        resolve(null)
        return
      }
      req.onsuccess = () => {
        const db = req.result
        const names = Array.from(db.objectStoreNames)
        if (!names.length) {
          db.close()
          resolve(null)
          return
        }
        try {
          const tx = db.transaction(names, 'readonly')
          const stores = names.map((nm) => readStore(tx.objectStore(nm)))
          tx.oncomplete = () => {
            try {
              db.close()
            } catch (e) {}
            resolve({ name, version: db.version, stores })
          }
          tx.onerror = tx.onabort = () => {
            try {
              db.close()
            } catch (e) {}
            resolve(null)
          }
        } catch (e) {
          try {
            db.close()
          } catch (x) {}
          resolve(null)
        }
      }
      req.onerror = req.onblocked = () => resolve(null)
    })
  }
  try {
    const infos = indexedDB.databases ? await indexedDB.databases() : []
    const dbs = []
    for (const info of infos) {
      if (info && info.name) {
        const snap = await readDb(info.name, info.version)
        if (snap) dbs.push(snap)
      }
    }
    out.idb = dbs
  } catch (e) {
    out.message = String((e && e.message) || e)
  }
  return JSON.stringify(out)
})()`

/** 登录成功探测脚本：返回 { url, pw, sel, text } JSON；sel 仅在传入 css: 选择器时探测 */
export const buildLoginProbeScript = (sel: string): string => `(() => {
  const out = { url: '', pw: false, sel: false, text: '' }
  try { out.url = location.href } catch (e) {}
  try {
    out.pw = Array.prototype.some.call(document.querySelectorAll('input[type=password]'), (i) => i.offsetParent !== null || i.clientHeight > 0)
  } catch (e) {}
  ${sel ? `try { out.sel = !!document.querySelector(${JSON.stringify(sel)}) } catch (e) {}` : ''}
  try { out.text = (document.body ? document.body.innerText : '').slice(0, 5000) } catch (e) {}
  return JSON.stringify(out)
})()`
