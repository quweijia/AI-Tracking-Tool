/**
 * 文件夹预设 icon 与主题色（新建 / 编辑文件夹弹窗可选，卡片与横幅标题共用渲染）。
 * 全部为实底填充风格，颜色随 currentColor 继承。
 */
import type { ReactNode } from 'react'

/** label 为 folderIcon ns 的 i18n key，展示方用 t(label, { ns: 'folderIcon' }) 翻译 */
export const FOLDER_ICONS: { key: string; label: string; render: (size?: number) => ReactNode }[] = [
  {
    key: 'folder',
    label: 'iconFolder',
    render: (size = 16) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6a2 2 0 0 1 1.5.68L12.1 6.3H18.5A2.5 2.5 0 0 1 21 8.8v8.7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Z" />
      </svg>
    )
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
  '#2563EB',
  '#7C3AED',
  '#DB2777',
  '#DC2626',
  '#EA580C',
  '#CA8A04',
  '#16A34A',
  '#0891B2'
]

/** 按 key 渲染文件夹 icon（未知 key 或缺省回退到基础文件夹） */
export function FolderIconGlyph({ icon, size = 16 }: { icon?: string; size?: number }) {
  const def = FOLDER_ICONS.find((i) => i.key === icon) ?? FOLDER_ICONS[0]
  return <>{def.render(size)}</>
}
