import { useEffect, useState } from 'react'
import { WalkthroughPage, Platform, PLATFORM_LABELS } from '../db'
import USelect from './USelect'

interface Props {
  page: WalkthroughPage
  /** 保存编辑后的页面信息（figmaUrl 传 undefined 表示清空） */
  onSave: (fields: { pageName: string; platform: Platform; figmaUrl?: string }) => void
  onCancel: () => void
}

/** 编辑走查页面基本信息：页面名称、端类型、设计稿 Figma 链接 */
export default function EditPageModal({ page, onSave, onCancel }: Props) {
  const [pageName, setPageName] = useState(page.pageName)
  const [platform, setPlatform] = useState<Platform>(page.platform)
  const [figmaUrl, setFigmaUrl] = useState(page.figmaUrl ?? '')

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const canSave = pageName.trim().length > 0

  const handleSave = () => {
    if (!canSave) return
    // 未带协议时自动补 https://，留空表示清空链接
    const trimmed = figmaUrl.trim()
    const normalized =
      trimmed && !/^https?:\/\//i.test(trimmed) ? `https://${trimmed}` : trimmed
    onSave({
      pageName: pageName.trim(),
      platform,
      figmaUrl: normalized || undefined
    })
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h3>编辑页面信息</h3>

        <label className="field-label">页面名称</label>
        <input
          className="input"
          autoFocus
          placeholder="如：登录页、首页、个人中心"
          value={pageName}
          onChange={(e) => setPageName(e.target.value)}
        />

        <label className="field-label">端类型</label>
        <USelect
          value={platform}
          onChange={(v) => setPlatform(v as Platform)}
          options={(Object.keys(PLATFORM_LABELS) as Platform[]).map((k) => ({ value: k, label: PLATFORM_LABELS[k] }))}
        />

        <label className="field-label">设计稿 Figma 链接（可选）</label>
        <input
          className="input"
          placeholder="如：https://www.figma.com/file/xxxx/页面名"
          value={figmaUrl}
          onChange={(e) => setFigmaUrl(e.target.value)}
        />

        <div className="modal-actions">
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button className="btn-primary" disabled={!canSave} onClick={handleSave}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
