import { Platform, PLATFORM_LABELS } from '../db'

/** 平台图标：手机 / 显示器 / 可视化大屏 / 桌面应用窗口（内联 SVG，随文字颜色） */
export function PlatformIcon({ platform, size = 13 }: { platform: Platform; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  switch (platform) {
    case 'h5': // 手机
      return (
        <svg {...common}>
          <rect x="4.5" y="1.5" width="7" height="13" rx="1.6" />
          <path d="M7 12.4h2" />
        </svg>
      )
    case 'pc': // 显示器
      return (
        <svg {...common}>
          <rect x="1.5" y="2.5" width="13" height="8.6" rx="1.5" />
          <path d="M8 11.1v2.2M5.4 13.4h5.2" />
        </svg>
      )
    case 'dashboard': // 可视化大屏（带柱状图的大屏）
      return (
        <svg {...common}>
          <rect x="1.5" y="2" width="13" height="9.4" rx="1.5" />
          <path d="M5 9.2V6.6M8 9.2V4.6M11 9.2V7.2M5.5 14h5" />
        </svg>
      )
    case 'electron': // 桌面应用窗口
      return (
        <svg {...common}>
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.6" />
          <path d="M1.5 5.6h13" />
          <circle cx="3.7" cy="4" r="0.4" fill="currentColor" stroke="none" />
          <circle cx="5.5" cy="4" r="0.4" fill="currentColor" stroke="none" />
        </svg>
      )
  }
}

/** 图标 + 平台文案标签（不同平台类型做颜色区分） */
export function PlatformBadge({ platform }: { platform: Platform }) {
  return (
    <span className={`badge platform-badge platform-${platform}`}>
      <PlatformIcon platform={platform} />
      {PLATFORM_LABELS[platform]}
    </span>
  )
}
