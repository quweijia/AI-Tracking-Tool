import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ANNOTATION_COLORS,
  CATEGORY_UNSET,
  Category,
  CATEGORY_LABELS,
  genId,
  Issue,
  IssueAttachment,
  IssueStatus,
  ISSUE_STATUS_LABELS,
  Severity,
  SEVERITY_LABELS,
  TargetImage
} from '../db'
import USelect from './USelect'
import { showToast } from './Toast'
import { showScreenPermissionGuide } from './ScreenPermissionGuide'

/** 标注颜色值 → 语言包 key（与 db 的 ANNOTATION_COLORS 顺序无关，按色值映射） */
const COLOR_LABEL_KEYS: Record<string, string> = {
  '': 'color_auto',
  '#ef4444': 'color_red',
  '#f59e0b': 'color_orange',
  '#2563eb': 'color_blue',
  '#16a34a': 'color_green',
  '#9333ea': 'color_purple',
  '#ffffff': 'color_white',
  '#000000': 'color_black'
}

/** 枚举值转语言包 key 后缀（'in-progress' → 'in_progress'） */
const enumKey = (v: string) => v.replace(/-/g, '_')

/** 附件上限：单标注 10 张、单张 20MB、累计 50MB */
const ATTACH_MAX_COUNT = 10
const ATTACH_MAX_SINGLE = 20 * 1024 * 1024
const ATTACH_MAX_TOTAL = 50 * 1024 * 1024

/** 估算 data URL 原始字节数（base64 解码后） */
const dataUrlBytes = (dataUrl: string): number => {
  const i = dataUrl.indexOf(',')
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)
}

/** Blob 转 data URL（拖拽文件 / 剪贴板图片统一入口） */
const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => (typeof r.result === 'string' ? resolve(r.result) : reject(new Error('read fail')))
    r.onerror = () => reject(r.error ?? new Error('read fail'))
    r.readAsDataURL(blob)
  })

/** 解码图片并生成列表缩略图（最长边 240px，webp q0.7）；解码失败返回 null（视为损坏文件） */
function decodeImage(dataUrl: string): Promise<{ width: number; height: number; thumb: string } | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, 240 / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.max(1, Math.round(img.naturalWidth * scale))
      const h = Math.max(1, Math.round(img.naturalHeight * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(null)
      ctx.drawImage(img, 0, 0, w, h)
      resolve({ width: img.naturalWidth, height: img.naturalHeight, thumb: canvas.toDataURL('image/webp', 0.7) })
    }
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

/** 同名展示文件名追加序号（磁盘命名走 uuid，不会冲突） */
const uniqueFileName = (list: IssueAttachment[], name: string): string => {
  if (!list.some((a) => a.fileName === name)) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let i = 2
  while (list.some((a) => a.fileName === `${base} (${i})${ext}`)) i++
  return `${base} (${i})${ext}`
}

/** 字节数展示：MB 保留 1 位小数，KB 取整 */
const fmtSize = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

interface Props {
  /** 编辑已有问题，或创建模式下的初始值 */
  issue: Issue
  mode: 'create' | 'edit'
  onSave: (fields: {
    description: string
    severity: Severity
    category: Category
    status: IssueStatus
    targetImage: TargetImage
    /** 自定义标注颜色，空串 = 按严重度 */
    color?: string
    /** 测量标注的尺寸文案（仅测量标注） */
    measureValue?: string
    /** 截图附件列表（可选，向后兼容） */
    attachments?: IssueAttachment[]
  }) => void
  onDelete?: () => void
  onCancel: () => void
}

export default function IssueEditorModal({ issue, mode, onSave, onDelete, onCancel, hideTargetImage }: Props & { hideTargetImage?: boolean }) {
  const { t } = useTranslation('issueEditorModal')
  const [description, setDescription] = useState(issue.description)
  const [severity, setSeverity] = useState<Severity>(issue.severity)
  const [category, setCategory] = useState<Category>(issue.category)
  const [status, setStatus] = useState<IssueStatus>(issue.status)
  const [targetImage, setTargetImage] = useState<TargetImage>(issue.targetImage)
  const [colorPreset, setColorPreset] = useState<string>(issue.color ?? '')
  /** 测量标注的尺寸文案（可修改） */
  const [measureValue, setMeasureValue] = useState(issue.measureValue ?? '')
  /** 截图附件（旧标注无字段按空列表处理） */
  const [attachments, setAttachments] = useState<IssueAttachment[]>(issue.attachments ?? [])
  /** 大图预览：附件条目 + 原图 dataUrl */
  const [preview, setPreview] = useState<IssueAttachment | null>(null)
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null)
  /** 拖拽悬停高亮 */
  const [dragOver, setDragOver] = useState(false)
  /** 附件批量处理中（上传/粘贴/落盘），期间禁止重复触发与保存 */
  const [busy, setBusy] = useState(false)
  /** 分类未选择点「保存」时的红色闪烁提醒（选择分类后清除恢复常态） */
  const [catWarn, setCatWarn] = useState(false)
  /** 本会话新增的附件原图路径：取消保存时清理磁盘，保存后保留 */
  const addedRelPathsRef = useRef(new Set<string>())

  // 取消保存：清理本会话新增且仍在列表中的附件原图（fire-and-forget，失败不阻塞关闭）
  const handleCancel = useCallback((): void => {
    const stale = attachments.filter((a) => addedRelPathsRef.current.has(a.relPath)).map((a) => a.relPath)
    addedRelPathsRef.current.clear()
    if (stale.length) window.electronAPI.deleteAttachments(stale).catch(() => undefined)
    onCancel()
  }, [attachments, onCancel])

  // Esc 关闭：预览打开时先关预览，否则走取消清理
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (preview) setPreview(null)
      else handleCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview, handleCancel])

  // 预览打开时按需加载原图
  useEffect(() => {
    if (!preview) return
    let alive = true
    setPreviewDataUrl(null)
    window.electronAPI
      .readImage(preview.relPath)
      .then((d) => alive && setPreviewDataUrl(d))
      .catch(() => alive && setPreviewDataUrl(null))
    return () => {
      alive = false
    }
  }, [preview])

  /** 附件入库流水线：数量/单张/总量/损坏校验 → 原图落盘 → 追加列表（异常统一 toast，不崩溃） */
  const addAttachments = async (
    items: { fileName: string; dataUrl: string; size?: number }[],
    source: IssueAttachment['source']
  ): Promise<void> => {
    if (!items.length || busy) return
    setBusy(true)
    try {
      const added: IssueAttachment[] = []
      let total = attachments.reduce((s, a) => s + a.size, 0)
      for (const item of items) {
        if (attachments.length + added.length >= ATTACH_MAX_COUNT) {
          showToast(t('attachLimitCount', { max: ATTACH_MAX_COUNT }), { tone: 'warning' })
          break
        }
        const decoded = await decodeImage(item.dataUrl)
        if (!decoded) {
          showToast(t('attachCorrupt', { name: item.fileName }), { tone: 'danger' })
          continue
        }
        const bytes = item.size ?? dataUrlBytes(item.dataUrl)
        if (bytes > ATTACH_MAX_SINGLE) {
          showToast(t('attachLimitSingle', { name: item.fileName }), { tone: 'danger' })
          continue
        }
        if (total + bytes > ATTACH_MAX_TOTAL) {
          showToast(t('attachLimitTotal'), { tone: 'warning' })
          break
        }
        const saved = await window.electronAPI.saveAttachment(item.dataUrl, issue.pageId).catch(() => null)
        if (!saved) {
          showToast(t('attachSaveFail'), { tone: 'danger' })
          continue
        }
        console.log(`[ATTACHMENT] 新增附件 ${item.fileName} → ${saved.relPath}（${saved.size} B）`)
        total += saved.size
        addedRelPathsRef.current.add(saved.relPath)
        added.push({
          id: genId(),
          source,
          fileName: uniqueFileName([...attachments, ...added], item.fileName),
          relPath: saved.relPath,
          width: decoded.width,
          height: decoded.height,
          size: saved.size,
          thumbDataUrl: decoded.thumb,
          createdAt: Date.now()
        })
      }
      if (added.length) setAttachments((prev) => [...prev, ...added])
    } finally {
      setBusy(false)
    }
  }

  /** 系统对话框多选本地上传 */
  const handleUpload = async (): Promise<void> => {
    if (busy) return
    const picked = await window.electronAPI.pickLocalAttachments().catch(() => [])
    if (!picked.length) return
    await addAttachments(picked.map((p) => ({ fileName: p.fileName, dataUrl: p.dataUrl, size: p.size })), 'local')
  }

  /** 截图采集：主进程冻结屏幕 → overlay 框选 → 返回选区原图入库（source='capture'） */
  const handleCapture = async (): Promise<void> => {
    if (busy) return
    const r = await window.electronAPI.captureRegion().catch(() => null)
    if (!r) return
    if (!r.ok) {
      // macOS 录屏权限未授权：弹出 TRAE CN 风格权限引导
      if (r.reason === 'permission') showScreenPermissionGuide()
      return
    }
    await addAttachments([{ fileName: `capture-${Date.now()}.png`, dataUrl: r.dataUrl }], 'capture')
  }

  /** 删除附件：立即清理磁盘原图（保存前删除视为放弃，不做恢复） */
  const handleRemove = (att: IssueAttachment): void => {
    setAttachments((prev) => prev.filter((a) => a.id !== att.id))
    addedRelPathsRef.current.delete(att.relPath)
    window.electronAPI.deleteAttachments([att.relPath]).catch(() => undefined)
    if (preview?.id === att.id) setPreview(null)
  }

  // 粘贴（挂弹窗容器，仅弹窗获得焦点时生效）：图片拦截入库，纯文字不拦截走默认行为
  const handlePaste = (e: React.ClipboardEvent): void => {
    const imgItem = Array.from(e.clipboardData?.items ?? []).find((it) => it.type.startsWith('image/'))
    if (imgItem) {
      e.preventDefault()
      const file = imgItem.getAsFile()
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string')
          void addAttachments([{ fileName: file.name || `clipboard-${Date.now()}.png`, dataUrl: reader.result }], 'clipboard')
      }
      reader.readAsDataURL(file)
      return
    }
    // 兜底通道 2：渲染进程 navigator.clipboard.read（权限受限时抛错）
    // 兜底通道 3：主进程 clipboard.readImage
    void (async () => {
      let dataUrl: string | null = null
      try {
        if (navigator.clipboard?.read) {
          const clips = await navigator.clipboard.read()
          for (const clip of clips) {
            const type = clip.types.find((tp) => tp.startsWith('image/'))
            if (!type) continue
            dataUrl = await blobToDataUrl(await clip.getType(type))
            break
          }
        }
      } catch {
        /* 权限受限，走主进程兜底 */
      }
      if (!dataUrl) dataUrl = await window.electronAPI.readClipboardImage().catch(() => null)
      if (dataUrl) void addAttachments([{ fileName: `clipboard-${Date.now()}.png`, dataUrl }], 'clipboard')
    })()
  }

  // 拖拽上传：仅接受图片文件
  const handleDragOver = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragOver(true)
  }
  const handleDragLeave = (e: React.DragEvent): void => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setDragOver(false)
  }
  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) => /^image\/(png|jpe?g|webp)$/.test(f.type))
    if (!files.length) return
    void (async () => {
      const items = await Promise.all(files.map(async (f) => ({ fileName: f.name, dataUrl: await blobToDataUrl(f) })))
      await addAttachments(items, 'local')
    })()
  }

  // 分类未选择不禁用「保存」按钮：点击时以红色闪烁 + toast 引导手动选择（此处仅校验描述与忙碌态）
  const canSave = description.trim().length > 0 && !busy

  return (
    <>
      <div
        className="modal-mask"
        onMouseDown={(e) => e.target === e.currentTarget && handleCancel()}
        onPaste={handlePaste}
      >
        <div className="modal issue-editor-modal">
          <h3>{t(mode === 'create' ? 'titleCreate' : 'titleEdit')}</h3>

          <label className="field-label">{t('description')}</label>
          <textarea
            className="input"
            rows={3}
            autoFocus
            placeholder={t('descriptionPlaceholder')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <div className="modal-grid">
            <div>
              <label className="field-label">{t('category')}</label>
              <USelect
                value={category}
                className={catWarn ? 'category-warn' : ''}
                onChange={(v) => {
                  setCategory(v as Category)
                  setCatWarn(false)
                }}
                placeholder={t('categoryPlaceholder')}
                options={(Object.keys(CATEGORY_LABELS) as Category[]).map((k) => ({
                  value: k,
                  label: t(`cat_${enumKey(k)}`)
                }))}
              />
            </div>
            <div>
              <label className="field-label">{t('severity')}</label>
              <USelect
                value={severity}
                onChange={(v) => setSeverity(v as Severity)}
                options={(Object.keys(SEVERITY_LABELS) as Severity[]).map((k) => ({
                  value: k,
                  label: t(`sev_${enumKey(k)}`)
                }))}
              />
            </div>
            {!hideTargetImage && (
              <div>
                <label className="field-label">{t('targetImage')}</label>
                <USelect
                  value={targetImage}
                  onChange={(v) => setTargetImage(v as TargetImage)}
                  options={[
                    { value: 'design', label: t('design') },
                    { value: 'screenshot', label: t('devScreenshot') }
                  ]}
                />
              </div>
            )}
            {mode === 'edit' && (
              <div>
                <label className="field-label">{t('status')}</label>
                <USelect
                  value={status}
                  onChange={(v) => setStatus(v as IssueStatus)}
                  options={(Object.keys(ISSUE_STATUS_LABELS) as IssueStatus[]).map((k) => ({
                    value: k,
                    label: t(`status_${enumKey(k)}`)
                  }))}
                />
              </div>
            )}
          </div>

          {issue.shape === 'measure' && (
            <>
              <label className="field-label">{t('measureValue')}</label>
              <input
                className="input"
                placeholder={t('measureValuePlaceholder')}
                value={measureValue}
                onChange={(e) => setMeasureValue(e.target.value)}
              />
            </>
          )}

          <label className="field-label">{t('annotationColor')}</label>
          <div className="color-palette">
            {ANNOTATION_COLORS.map((c) => (
              <button
                key={c.value || 'auto'}
                type="button"
                className={`color-swatch ${c.value ? '' : 'auto'} ${colorPreset === c.value ? 'active' : ''}`}
                style={c.value ? { background: c.value } : undefined}
                title={t(COLOR_LABEL_KEYS[c.value] ?? 'color_auto')}
                onClick={() => setColorPreset(c.value)}
              />
            ))}
          </div>

          {/* 截图附件区块：上传 / 截图（阶段2 开放）/ 粘贴 / 拖拽 */}
          <label className="field-label">{t('attachments')}</label>
          <div
            className={`attach-zone ${dragOver ? 'drag-over' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="attach-toolbar">
              <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void handleUpload()}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                {t('attachUpload')}
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                disabled={busy}
                onClick={() => void handleCapture()}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                {t('attachCapture')}
              </button>
              <span className="attach-count">
                {attachments.length}/{ATTACH_MAX_COUNT}
              </span>
            </div>
            {attachments.length === 0 ? (
              <div className="attach-empty">{t('attachEmpty')}</div>
            ) : (
              <div className="attach-list">
                {attachments.map((a) => (
                  <div key={a.id} className="attach-item">
                    <img
                      className="attach-thumb"
                      src={a.thumbDataUrl}
                      alt={a.fileName}
                      title={t('attachPreview')}
                      onClick={() => setPreview(a)}
                    />
                    <div className="attach-meta">
                      <span className="attach-name" title={a.fileName}>
                        {a.fileName}
                      </span>
                      <span className="attach-dim">
                        {a.width}×{a.height} · {fmtSize(a.size)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="attach-del"
                      title={t('delete')}
                      disabled={busy}
                      onClick={() => handleRemove(a)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="modal-actions">
            {mode === 'edit' && onDelete && (
              <button className="btn-danger" onClick={onDelete}>
                {t('delete')}
              </button>
            )}
            <span className="modal-spacer" />
            <button className="btn-secondary" onClick={handleCancel}>
              {t('cancel')}
            </button>
            <button
              className="btn-primary"
              disabled={!canSave}
              onClick={() => {
                // 分类未选择：不保存，下拉红框闪烁 + toast 提示引导手动选择
                if (category === CATEGORY_UNSET) {
                  setCatWarn(false)
                  requestAnimationFrame(() => setCatWarn(true))
                  showToast(t('categoryRequired'), { tone: 'warning' })
                  return
                }
                onSave({
                  description: description.trim(),
                  severity,
                  category,
                  status,
                  targetImage,
                  color: colorPreset || undefined,
                  ...(issue.shape === 'measure' ? { measureValue: measureValue.trim() || undefined } : {}),
                  attachments
                })
              }}
            >
              {t('save')}
            </button>
          </div>
        </div>
      </div>

      {/* 大图预览遮罩（点击空白 / Esc 关闭） */}
      {preview && (
        <div className="modal-mask attach-preview-mask" onMouseDown={(e) => e.target === e.currentTarget && setPreview(null)}>
          {previewDataUrl ? (
            <img className="attach-preview-img" src={previewDataUrl} alt={preview.fileName} />
          ) : (
            <div className="attach-preview-loading">{t('attachLoading')}</div>
          )}
          <div className="attach-preview-name">{preview.fileName}</div>
        </div>
      )}
    </>
  )
}
