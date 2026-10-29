import { useTranslation } from 'react-i18next'
import type { IssueSource } from '../../../shared/types'

// label 为 sourceBadge ns 的 i18n key
/** 问题来源标签：区分结构化数据比对 / 图片视觉比对 / 手动标注 / 设计规范校验 / 元素清单 / 无障碍 */
const SOURCE_META: Record<IssueSource, { label: string; cls: string }> = {
  structured: { label: 'structured', cls: 'source-structured' },
  visual: { label: 'visual', cls: 'source-visual' },
  manual: { label: 'manual', cls: 'source-manual' },
  spec: { label: 'spec', cls: 'source-spec' },
  element: { label: 'element', cls: 'source-element' },
  a11y: { label: 'a11y', cls: 'source-a11y' }
}

export default function SourceBadge({ source }: { source?: IssueSource }) {
  const { t } = useTranslation('sourceBadge')
  const meta = SOURCE_META[source ?? 'manual']
  return <span className={`source-badge ${meta.cls}`}>{t(meta.label)}</span>
}
