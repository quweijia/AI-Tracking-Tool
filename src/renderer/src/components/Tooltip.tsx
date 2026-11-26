import { cloneElement, useId, type ReactElement } from 'react'

/**
 * 轻量 Tooltip：给唯一子元素注入 aria-describedby，气泡 role="tooltip"。
 * 显示时机由 CSS 控制（悬停 + :focus-within），因此子元素需为可聚焦元素（如 button）。
 */
export function Tooltip({ label, children }: { label: string; children: ReactElement }): ReactElement {
  const id = useId()
  const trigger = cloneElement(children as ReactElement<Record<string, unknown>>, {
    'aria-describedby': id
  })

  return (
    <span className="tip-wrap">
      {trigger}
      <span id={id} className="tip-bubble" role="tooltip">
        {label}
      </span>
    </span>
  )
}
