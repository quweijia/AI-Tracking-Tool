/**
 * engine-bridge 构建脚本：
 * 把 Electron 版纯逻辑引擎模块（src/main/{matcher,diff,figma}.ts 与
 * src/renderer/src/spec/{specCheck,elementCheck,a11yCheck}.ts）打包为单文件 CJS CLI，
 * 产物 dist/engine-bridge.cjs 由 SwiftUI 壳经 Process(node, engine-bridge.cjs, <子命令>) 调用。
 *
 * 运行：node build.mjs（本目录下）；esbuild 复用仓库根 node_modules，无新增安装。
 * specCheck.ts 运行时 import '../db'（Dexie 封装）仅 loadProjectSpecTokens 使用，
 * CLI 不走该函数，打包时 alias 到 stub-db.ts。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

let esbuild
try {
  esbuild = require('esbuild')
} catch {
  esbuild = require(path.join(here, '../../node_modules/esbuild/lib/main.js'))
}

/** esbuild alias 不接受相对路径名，用 onResolve 插件把 specCheck 的运行时 '../db' 导入改写到替身 */
const stubDbPlugin = {
  name: 'stub-db',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/db$/ }, () => ({ path: path.join(here, 'src/stub-db.ts') }))
  }
}

await esbuild.build({
  entryPoints: [path.join(here, 'src/entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: path.join(here, 'dist/engine-bridge.cjs'),
  plugins: [stubDbPlugin],
  legalComments: 'none',
  logLevel: 'info'
})
