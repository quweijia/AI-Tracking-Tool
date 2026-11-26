import type { ReactElement } from 'react'

/** 骨架占位：纯装饰，读屏跳过；动画在 .skeleton 内按 prefers-reduced-motion 降级 */
export function Skeleton({
  width = '100%',
  height = 12
}: {
  width?: number | string
  height?: number | string
}): ReactElement {
  return <span className="skeleton" aria-hidden="true" style={{ width, height }} />
}
