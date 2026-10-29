/**
 * '../db' 打包替身：specCheck.ts 运行时导入 Dexie 封装 db / latestSpecVersion，
 * 仅 loadProjectSpecTokens（CLI 不调用）使用；Token 列表由 Swift 侧从 SwiftData 组装后传入。
 * elementCheck / a11yCheck 对 '../db' 均为 type-only 导入，打包时已被擦除。
 */
export const db: unknown = {}
export function latestSpecVersion(): unknown {
  return undefined
}
