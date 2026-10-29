/**
 * Figma 链接解析：从规范链接中提取 file key。
 * 兼容 /file/ /design/ /proto/ /board/ 四类链接形态，其余（私有嵌入等）返回 null。
 */
export function extractFigmaFileKey(url: string): string | null {
  const m = /figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]{10,})/.exec(url.trim())
  return m ? m[1] : null
}
