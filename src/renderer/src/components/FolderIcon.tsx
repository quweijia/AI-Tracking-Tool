/**
 * 文件夹预设 icon 与主题色（新建 / 编辑文件夹弹窗可选，卡片与横幅标题共用渲染）。
 * 全部为实底填充风格，颜色随 currentColor 继承。
 */
import type { ReactNode } from 'react'
import { useId } from 'react'

/** 与黑/白混合调色（amt>0 提亮、<0 压暗），输入输出均为 hex */
function shade(hex: string, amt: number): string {
  const h = hex.replace('#', '')
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(v, 16)
  const t = amt > 0 ? 255 : 0
  const p = Math.abs(amt)
  const mix = (c: number) => Math.round((t - c) * p + c)
  return `#${[mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)]
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')}`
}

/** 黄色文件夹渐变图标（React 组件，gradient ID 唯一）。
 *  传入 color 时按该主题色派生：背衬标签压暗 32%、面板渐变提亮 22% → 压暗 8%，
 *  让默认矢量文件夹 icon 跟随弹窗所选颜色（不传保持原黄色） */
const YellowFolderIcon = ({ size = 16, color }: { size?: number; color?: string }) => {
  const gradId = `yf-${useId()}`
  const back = color ? shade(color, -0.32) : '#C77E19'
  const gradTop = color ? shade(color, 0.22) : '#FFD66B'
  const gradBottom = color ? shade(color, -0.08) : '#F0A828'
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <path d="M31 10V16H1V10V7.5C1 5.5 2.63636 4 4.81818 4H8.63636C9.4 4 10.0545 4.4 10.4909 4.8L12.4545 6.5H27.1818C29.2545 6.5 31 8 31 10Z" fill={back} />
      <path d="M31 25.0123V14C31 12.3431 29.6569 11 28 11H4C2.34315 11 1 12.3431 1 14V25.0123C1 27.2277 3.06897 29 5.65517 29H26.3448C28.931 29 31 27.2277 31 25.0123Z" fill={`url(#${gradId})`} />
      <defs>
        <linearGradient id={gradId} x1="16" y1="14.4338" x2="16" y2="28.5301" gradientUnits="userSpaceOnUse">
          <stop stopColor={gradTop} />
          <stop offset="1" stopColor={gradBottom} />
        </linearGradient>
      </defs>
    </svg>
  )
}

/** label 为 folderIcon ns 的 i18n key，展示方用 t(label, { ns: 'folderIcon' }) 翻译。
 *  render 第二参为主题色：仅默认文件夹渐变 icon 使用（其余 currentColor 图标由外层 color 样式继承） */
export const FOLDER_ICONS: { key: string; label: string; render: (size?: number, color?: string) => ReactNode }[] = [
  {
    key: 'folder',
    label: 'iconFolder',
    render: (size = 16, color) => <YellowFolderIcon size={size} color={color} />,
  },
  {
    key: 'layers',
    label: 'iconLayers',
    render: (size = 16) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 3 2.8 8 12 13l9.2-5L12 3Z" />
        <path d="m4.4 11.7-1.6.9 9.2 5 9.2-5-1.6-.9-7.6 4.1-7.6-4.1Z" />
        <path d="m4.4 15.7-1.6.9 9.2 5 9.2-5-1.6-.9-7.6 4.1-7.6-4.1Z" />
      </svg>
    )
  },
  {
    key: 'component',
    label: 'iconComponent',
    render: (size = 16) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 2.7 15.3 6 12 9.3 8.7 6 12 2.7Z" />
        <path d="M18 8.7 21.3 12 18 15.3 14.7 12 18 8.7Z" opacity="0.72" />
        <path d="M6 8.7 9.3 12 6 15.3 2.7 12 6 8.7Z" opacity="0.72" />
        <path d="M12 14.7 15.3 18 12 21.3 8.7 18 12 14.7Z" />
      </svg>
    )
  },
  {
    key: 'book',
    label: 'iconBook',
    render: (size = 16) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H10a3 3 0 0 1 2 .8 3 3 0 0 1 2-.8h4.5A1.5 1.5 0 0 1 20 4.5v13a1.5 1.5 0 0 1-1.5 1.5H14a3 3 0 0 0-2 .8 3 3 0 0 0-2-.8H5.5A1.5 1.5 0 0 1 4 17.5v-13ZM13 5.9V18c.5-.3 1-.4 1.6-.4h3.9V4.5h-4a1.6 1.6 0 0 0-1.5 1.4Z" />
      </svg>
    )
  },
  {
    key: 'grid',
    label: 'iconGrid',
    render: (size = 16) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <rect x="3" y="3" width="8" height="8" rx="1.8" />
        <rect x="13" y="3" width="8" height="8" rx="1.8" opacity="0.75" />
        <rect x="3" y="13" width="8" height="8" rx="1.8" opacity="0.75" />
        <rect x="13" y="13" width="8" height="8" rx="1.8" />
      </svg>
    )
  },
  {
    key: 'flow',
    label: 'iconFlow',
    render: (size = 16) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <rect x="8" y="2.5" width="8" height="6" rx="1.5" />
        <rect x="2.5" y="15.5" width="7" height="6" rx="1.5" />
        <rect x="14.5" y="15.5" width="7" height="6" rx="1.5" />
        <path d="M12 9.5v3M12 12.5H6v2.4M12 12.5h6v2.4M6 12.5v3M18 12.5v3" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      </svg>
    )
  },
  {
    key: 'image',
    label: 'iconImage',
    render: (size = 16) => (
      // 相框 + 山形 + 太阳（evenodd 镂空），四边留足边距，避免贴边被裁切
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden>
        <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11ZM6 16.5l4-4a1 1 0 0 1 1.4 0l1.9 1.9 2.3-2.3a1 1 0 0 1 1.4 0L18 14.5V7H6v9.5Z" />
        <circle cx="8.4" cy="9.4" r="1.5" />
      </svg>
    )
  },
  {
    key: 'archive',
    label: 'iconArchive',
    render: (size = 16) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h15A1.5 1.5 0 0 1 21 5.5V8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 8V5.5Z" />
        <path d="M4.5 11h15v7.5A1.5 1.5 0 0 1 18 20H6a1.5 1.5 0 0 1-1.5-1.5V11Zm5 1.5a1 1 0 0 0 0 2h5a1 1 0 1 0 0-2h-5Z" />
      </svg>
    )
  }
]

export const FOLDER_COLORS = [
  '#FACC15',
  '#3B82F6',
  '#8B5CF6',
  '#F43F5E',
  '#F97316',
  '#22C55E',
  '#06B6D4'
]

/** 按 key 渲染文件夹 icon（未知 key 或缺省回退到基础文件夹）；color 传主题色时默认矢量文件夹 icon 着该色 */
export function FolderIconGlyph({ icon, size = 16, color }: { icon?: string; size?: number; color?: string }) {
  const def = FOLDER_ICONS.find((i) => i.key === icon) ?? FOLDER_ICONS[0]
  return <>{def.render(size, color)}</>
}
