import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WalkthroughPage, Platform } from '../db'
import { PlatformIcon } from './PlatformBadge'

/** 全部端类型（与 PLATFORM_LABELS 的 key 一致，展示文案走 editPageModal ns 的 platform_* key） */
const PLATFORMS: Platform[] = ['h5', 'pc', 'dashboard', 'electron']

interface Props {
  page: WalkthroughPage
  /** 保存编辑后的页面信息（figmaUrl/devUrl 传 undefined 表示清空） */
  onSave: (fields: { pageName: string; platform: Platform; figmaUrl?: string; devUrl?: string }) => void
  onCancel: () => void
}

/** 编辑走查页面基本信息：页面名称、端类型、设计稿 Figma 链接、开发环境页面 URL */
export default function EditPageModal({ page, onSave, onCancel }: Props) {
  const { t } = useTranslation('editPageModal')
  const [pageName, setPageName] = useState(page.pageName)
  const [platform, setPlatform] = useState<Platform>(page.platform)
  const [figmaUrl, setFigmaUrl] = useState(page.figmaUrl ?? '')
  const [devUrl, setDevUrl] = useState(page.devUrl ?? '')

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
    const normalize = (raw: string): string => {
      const trimmed = raw.trim()
      return trimmed && !/^https?:\/\//i.test(trimmed) ? `https://${trimmed}` : trimmed
    }
    const fUrl = normalize(figmaUrl)
    const dUrl = normalize(devUrl)
    onSave({
      pageName: pageName.trim(),
      platform,
      figmaUrl: fUrl || undefined,
      devUrl: dUrl || undefined
    })
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h3>{t('title')}</h3>

        <label className="field-label">{t('nameLabel')}</label>
        <input
          className="input"
          autoFocus
          placeholder={t('namePlaceholder')}
          value={pageName}
          onChange={(e) => setPageName(e.target.value)}
        />

        <label className="field-label">{t('platformLabel')}</label>
        {/* 端类型使用与新建走查向导一致的 Segmented 组件（每项带平台语义 icon） */}
        <div className="segmented">
          {PLATFORMS.map((k) => (
            <button
              key={k}
              type="button"
              className={`segment-item${platform === k ? ' active' : ''}`}
              onClick={() => setPlatform(k)}
            >
              <PlatformIcon platform={k} />
              {t(`platform_${k}`)}
            </button>
          ))}
        </div>

        <label className="field-label">{t('figmaLabel')}</label>
        <input
          className="input"
          placeholder={t('figmaPlaceholder')}
          value={figmaUrl}
          onChange={(e) => setFigmaUrl(e.target.value)}
        />

        <label className="field-label">{t('devUrlLabel')}</label>
        <input
          className="input"
          placeholder={t('devUrlPlaceholder')}
          value={devUrl}
          onChange={(e) => setDevUrl(e.target.value)}
        />

        <div className="modal-actions">
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button className="btn-primary" disabled={!canSave} onClick={handleSave}>
            {t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}
