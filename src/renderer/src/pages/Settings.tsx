import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import pkg from '../../../../package.json'
import appIconUrl from '../assets/app-icon.png'
import { db } from '../db'
import { useSettingsStore } from '../stores/settings'
import { useAppIconStore, APP_ICONS, type AppIconKey } from '../stores/appIcon'
import USelect from '../components/USelect'
import { changeAppLang, type AppLang } from '../i18n'
import { DEFAULT_TOLERANCE, type ToleranceConfig } from '../../../shared/types'

/** OpenAI 兼容模型配置 */
interface AIModel {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  vision: boolean
  createdAt: number
}

/** 文档平台凭据（飞书 / 腾讯文档 / 金山文档），字段由各平台 DocAppCard fields 定义 */

interface FigmaMcpConfig {
  serverUrl: string
  pat: string
}

interface SkillItem {
  id: string
  name: string
  desc: string
  url: string
  /** Zip 包导入的指南文档内容（AI 识别时注入提示词） */
  guides?: string[]
}

/** 主题模式：跟随系统 / 手动浅色 / 手动深色（Layout 同步监听 localStorage + 自定义事件） */
type ThemeMode = 'system' | 'light' | 'dark'

/** 预置模板：选填 baseUrl / model 快捷填充（label 文案在组件内按界面语言生成） */
const PRESETS: { key: string; baseUrl: string; model: string }[] = [
  { key: 'custom', baseUrl: '', model: '' },
  { key: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-vl2' },
  { key: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max' },
  { key: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-plus' },
  { key: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' }
]

function genId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** 卡片操作 icon（悬停显示，替代文字按钮）：连通性测试 / 编辑 / 删除 / 设为默认 */
const IconPlug = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 22v-5" />
    <path d="M9 8V2" />
    <path d="M15 8V2" />
    <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
  </svg>
)

const IconPencil = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </svg>
)

const IconTrash = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
)

const IconStar = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
)

/** 卡片区块（title 可选：关于应用等无标题场景） */
function Section({ title, desc, children }: { title?: string; desc?: string; children: ReactNode }) {
  return (
    <div className="card settings-section">
      {title && <h2>{title}</h2>}
      {desc && <p className="settings-desc">{desc}</p>}
      {children}
    </div>
  )
}

/** 新增 / 编辑模型弹窗 */
function ModelModal({
  initial,
  onSave,
  onCancel
}: {
  initial?: AIModel
  onSave: (m: AIModel) => void
  onCancel: () => void
}) {
  const { t } = useTranslation('settings')
  const [preset, setPreset] = useState('custom')
  const [name, setName] = useState(initial?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '')
  const [model, setModel] = useState(initial?.model ?? '')
  const [vision, setVision] = useState(initial?.vision ?? true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const PRESET_LABELS: Record<string, string> = {
    custom: t('preset_custom'),
    deepseek: 'DeepSeek',
    qwen: t('preset_qwen'),
    zhipu: t('preset_zhipu'),
    openai: 'OpenAI'
  }

  const applyPreset = (key: string) => {
    setPreset(key)
    const p = PRESETS.find((x) => x.key === key)
    if (p && p.baseUrl) {
      setBaseUrl(p.baseUrl)
      setModel(p.model)
      if (!name) setName(PRESET_LABELS[key] ?? key)
      setVision(true)
    }
  }

  const canSave = name.trim() && baseUrl.trim() && apiKey.trim() && model.trim()

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h3>{initial ? t('editModel') : t('addModel')}</h3>

        <label className="field-label">{t('presetTitle')}</label>
        <div className="preset-chips">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`preset-chip ${preset === p.key ? 'active' : ''}`}
              onClick={() => applyPreset(p.key)}
            >
              {PRESET_LABELS[p.key]}
            </button>
          ))}
        </div>

        <label className="field-label">{t('fieldName')}</label>
        <input
          className="input"
          placeholder={t('namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="field-label">{t('fieldBaseUrl')}</label>
        <input
          className="input"
          placeholder={t('baseUrlPlaceholder')}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />

        <div className="modal-grid">
          <div>
            <label className="field-label">{t('fieldModelId')}</label>
            <input
              className="input"
              placeholder={t('modelIdPlaceholder')}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label">{t('fieldApiKey')}</label>
            <input
              className="input"
              type="password"
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        </div>

        <label className="inline-label settings-vision">
          <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
          {t('visionLabel')}
        </label>

        <div className="modal-actions">
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={!canSave}
            onClick={() =>
              canSave &&
              onSave({
                id: initial?.id ?? genId(),
                name: name.trim(),
                baseUrl: baseUrl.trim().replace(/\/+$/, ''),
                apiKey: apiKey.trim(),
                model: model.trim(),
                vision,
                createdAt: initial?.createdAt ?? Date.now()
              })
            }
          >
            {t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** AI 模型管理：模型列表 + 测试连接 + 默认模型 */
function ModelsSection() {
  const { t } = useTranslation('settings')
  const [models, setModels] = useState<AIModel[]>([])
  const [defaultId, setDefaultId] = useState('')
  const [editing, setEditing] = useState<AIModel | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [testingId, setTestingId] = useState('')
  const [testMsg, setTestMsg] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      setModels((cfg.aiModels as AIModel[] | undefined) ?? [])
      setDefaultId((cfg.aiDefaultModelId as string | undefined) ?? '')
      setLoaded(true)
    })
  }, [])

  const persistModels = async (next: AIModel[], nextDefault?: string) => {
    setModels(next)
    const def = nextDefault !== undefined ? nextDefault : defaultId
    // 默认模型被删除时自动切换到第一个
    const finalDef = next.some((m) => m.id === def) ? def : (next[0]?.id ?? '')
    if (finalDef !== defaultId) setDefaultId(finalDef)
    await window.electronAPI.setConfig('aiModels', next)
    await window.electronAPI.setConfig('aiDefaultModelId', finalDef)
  }

  const testModel = async (id: string) => {
    setTestingId(id)
    setTestMsg((prev) => ({ ...prev, [id]: { ok: true, text: t('testing') } }))
    try {
      if (typeof window.electronAPI.aiTest !== 'function') {
        throw new Error(t('testChannelMissing'))
      }
      const res = await window.electronAPI.aiTest(id)
      setTestMsg((prev) => ({
        ...prev,
        [id]: { ok: res.ok, text: res.ok ? t('testOk', { ms: res.latencyMs }) : res.message }
      }))
    } catch (err) {
      setTestMsg((prev) => ({
        ...prev,
        [id]: { ok: false, text: t('testFail', { msg: err instanceof Error ? err.message : String(err) }) }
      }))
    }
    setTestingId('')
  }

  return (
    <>
      <Section
        title={t('modelsTitle')}
        desc={t('modelsDesc')}
      >
        <div className="settings-section-head">
          <span className="model-count">{loaded ? t('modelCount', { count: models.length }) : ''}</span>
          <button type="button" className="btn-primary" onClick={() => setShowNew(true)}>
            {t('addModelBtn')}
          </button>
        </div>
        {!loaded ? null : models.length === 0 ? (
          <p className="settings-empty">{t('emptyModels')}</p>
        ) : (
          <div className="model-list">
            {models.map((m) => (
              <div key={m.id} className={`model-item${m.id === defaultId ? ' default' : ''}`}>
                <div className="model-item-head">
                  <span className="model-name">{m.name}</span>
                  {m.id === defaultId && <span className="badge">{t('badgeDefault')}</span>}
                  {m.vision ? (
                    <span className="badge badge-green">{t('badgeVision')}</span>
                  ) : (
                    <span className="badge model-badge-gray">{t('badgeTextOnly')}</span>
                  )}
                </div>
                <div className="model-item-meta">
                  {m.model} · {m.baseUrl}
                </div>
                {testMsg[m.id] && (
                  <p className={`model-test-msg ${testMsg[m.id].ok ? 'ok' : 'err'}`}>
                    {testMsg[m.id].text}
                  </p>
                )}
                <div className="model-item-actions">
                  {m.id !== defaultId && (
                    <button
                      type="button"
                      className="icon-btn"
                      title={t('titleSetDefault')}
                      onClick={() => void persistModels(models, m.id)}
                    >
                      <IconStar />
                    </button>
                  )}
                  <button
                    type="button"
                    className={`icon-btn${testingId === m.id ? ' testing' : ''}`}
                    title={testingId === m.id ? t('testing') : t('testConn')}
                    disabled={testingId === m.id}
                    onClick={() => testModel(m.id)}
                  >
                    <IconPlug />
                  </button>
                  <button type="button" className="icon-btn" title={t('edit')} onClick={() => setEditing(m)}>
                    <IconPencil />
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    title={t('del')}
                    onClick={() => {
                      if (!window.confirm(t('deleteModelConfirm', { name: m.name }))) return
                      void persistModels(models.filter((x) => x.id !== m.id))
                    }}
                  >
                    <IconTrash />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {(showNew || editing) && (
        <ModelModal
          initial={editing ?? undefined}
          onSave={(m) => {
            const exists = models.some((x) => x.id === m.id)
            const next = exists ? models.map((x) => (x.id === m.id ? m : x)) : [...models, m]
            void persistModels(next, exists ? undefined : m.id)
            setShowNew(false)
            setEditing(null)
          }}
          onCancel={() => {
            setShowNew(false)
            setEditing(null)
          }}
        />
      )}
    </>
  )
}

/** 应用图标选择：自定义 Dock 栏图标，选择后顶栏 logo 同步、立即生效并持久化 */
function AppIconPicker() {
  const { t } = useTranslation('settings')
  const { key, setKey } = useAppIconStore()
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const select = async (k: AppIconKey, url?: string) => {
    setKey(k)
    void window.electronAPI.setConfig('appIcon', k)
    // 自定义图标：资产 URL → dataURL 传给主进程设置 Dock（默认方案由主进程重置）
    let dataUrl: string | undefined
    if (url) {
      try {
        const blob = await (await fetch(url)).blob()
        dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = () => reject(new Error('读取图标失败'))
          reader.readAsDataURL(blob)
        })
      } catch {
        dataUrl = undefined
      }
    }
    const res = await window.electronAPI.setDockIcon(k, dataUrl)
    setMsg({ ok: res.ok, text: res.message })
  }

  return (
    <div className="settings-appicon">
      <div className="settings-gen-row">
        <div className="settings-gen-info">
          <span className="settings-gen-label">{t('appIconLabel')}</span>
          <span className="settings-gen-sub">{t('appIconDesc')}</span>
        </div>
      </div>
      <div className="appicon-grid">
        <button
          type="button"
          className={`appicon-item${key === 'default' ? ' active' : ''}`}
          onClick={() => void select('default')}
        >
          <img src={appIconUrl} alt={t('appIconDefault')} draggable={false} />
          <span>{t('appIconDefault')}</span>
        </button>
        {APP_ICONS.map((o) => (
          <button
            key={o.key}
            type="button"
            className={`appicon-item${key === o.key ? ' active' : ''}`}
            onClick={() => void select(o.key, o.url)}
          >
            <img src={o.url} alt={o.label} draggable={false} />
            <span>{o.label}</span>
          </button>
        ))}
      </div>
      {msg && <p className={`model-test-msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</p>}
    </div>
  )
}

/** 通用设置：主题（跟随系统/浅色/深色）+ 语言 + 应用图标 */
function GeneralSection() {
  const { t } = useTranslation('settings')
  const [mode, setMode] = useState<ThemeMode>(() => {
    const v = localStorage.getItem('app-theme')
    return v === 'dark' || v === 'light' ? v : 'system'
  })
  const [lang, setLang] = useState(() => localStorage.getItem('app-lang') ?? 'zh-CN')
  // 任务完成音效开关（默认开启，持久化到 electron config）
  const [soundOn, setSoundOn] = useState(true)

  useEffect(() => {
    void window.electronAPI.getConfig().then((cfg) => setSoundOn(cfg.soundEnabled !== false))
  }, [])

  const changeMode = (m: ThemeMode) => {
    setMode(m)
    localStorage.setItem('app-theme', m)
    // 通知 Layout 立即切换（含跟随系统的媒体查询重算）
    window.dispatchEvent(new CustomEvent('app-theme-change', { detail: m }))
  }

  return (
    <Section title={t('generalTitle')} desc={t('generalDesc')}>
      <div className="settings-gen-row">
        <div className="settings-gen-info">
          <span className="settings-gen-label">{t('themeLabel')}</span>
          <span className="settings-gen-sub">
            {t('themeCurrent', {
              mode: mode === 'system' ? t('theme_system') : mode === 'dark' ? t('theme_dark') : t('theme_light')
            })}
          </span>
        </div>
        <div className="segmented">
          {(['system', 'light', 'dark'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`segment-item ${mode === m ? 'active' : ''}`}
              onClick={() => changeMode(m)}
            >
              {m === 'system' ? t('theme_system') : m === 'dark' ? t('theme_dark') : t('theme_light')}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-gen-row">
        <div className="settings-gen-info">
          <span className="settings-gen-label">{t('langLabel')}</span>
          <span className="settings-gen-sub">{t('langDesc')}</span>
        </div>
        <USelect
          value={lang}
          onChange={(v) => {
            setLang(v)
            changeAppLang(v as AppLang)
          }}
          options={[
            { value: 'zh-CN', label: '简体中文' },
            { value: 'en-US', label: 'English' }
          ]}
        />
      </div>
      <div className="settings-gen-row">
        <div className="settings-gen-info">
          <span className="settings-gen-label">{t('soundLabel')}</span>
          <span className="settings-gen-sub">{t('soundDesc')}</span>
        </div>
        <button
          type="button"
          className={`switch ${soundOn ? 'on' : ''}`}
          onClick={() => {
            const next = !soundOn
            setSoundOn(next)
            void window.electronAPI.setConfig('soundEnabled', next)
          }}
        />
      </div>
      <AppIconPicker />
    </Section>
  )
}

/** 容差设置：结构化比对判定阈值（独立分区，全局一套规则，改动即时生效） */
function ToleranceSection() {
  const { t } = useTranslation('settings')
  const [tolerance, setTolerance] = useState<ToleranceConfig>(DEFAULT_TOLERANCE)

  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      setTolerance({ ...DEFAULT_TOLERANCE, ...((cfg.walkTolerance as Partial<ToleranceConfig>) ?? {}) })
    })
  }, [])

  /** 更新单个容差字段并持久化（自动走查比对时实时读取） */
  const changeTolerance = (key: keyof ToleranceConfig, value: string): void => {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) return
    const next = { ...tolerance, [key]: Math.round(n * 100) / 100 }
    setTolerance(next)
    void window.electronAPI.setConfig('walkTolerance', next)
  }

  const TOL_FIELDS: { key: keyof ToleranceConfig; label: string; hint: string }[] = [
    { key: 'size', label: t('tol_size'), hint: t('tol_size_hint') },
    { key: 'typography', label: t('tol_typography'), hint: t('tol_typography_hint') },
    { key: 'spacing', label: t('tol_spacing'), hint: t('tol_spacing_hint') },
    { key: 'radius', label: t('tol_radius'), hint: t('tol_radius_hint') },
    { key: 'border', label: t('tol_border'), hint: t('tol_border_hint') },
    { key: 'color', label: t('tol_color'), hint: t('tol_color_hint') }
  ]

  return (
    <Section
      title={t('toleranceTitle')}
      desc={t('toleranceDesc')}
    >
      <div className="settings-tolerance">
        <div className="settings-tol-grid">
          {TOL_FIELDS.map((f) => (
            <label key={f.key} className="settings-tol-item" title={f.hint}>
              <span className="settings-tol-label">{f.label}</span>
              <span className="settings-tol-input">
                <input
                  className="input input-sm"
                  type="number"
                  min={0}
                  step={f.key === 'color' ? 0.5 : 1}
                  value={tolerance[f.key]}
                  onChange={(e) => changeTolerance(f.key, e.target.value)}
                />
                <span className="settings-tol-unit">{f.key === 'color' ? 'ΔE' : 'px'}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </Section>
  )
}

/** MCP 服务配置项 */
interface McpItem {
  id: string
  name: string
  serverUrl: string
  pat: string
  /** 启用开关（缺省视为启用，兼容旧数据） */
  enabled?: boolean
  /** 自定义代理地址（可选，内网环境 Figma API 走此代理） */
  proxy?: string
}

/** 添加 / 编辑 MCP 服务弹窗（交互与添加模型一致） */
function McpModal({
  initial,
  onSave,
  onCancel
}: {
  initial?: McpItem
  onSave: (m: McpItem) => void
  onCancel: () => void
}) {
  const { t } = useTranslation('settings')
  const [name, setName] = useState(initial?.name ?? '')
  const [serverUrl, setServerUrl] = useState(initial?.serverUrl ?? '')
  const [pat, setPat] = useState(initial?.pat ?? '')
  const [proxy, setProxy] = useState(initial?.proxy ?? '')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const canSave = name.trim() && serverUrl.trim() && pat.trim()

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h3>{initial ? t('editMcp') : t('addMcp')}</h3>

        <label className="field-label">{t('fieldName')}</label>
        <input
          className="input"
          autoFocus
          placeholder={t('mcpNamePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="field-label">{t('mcpServerUrl')}</label>
        <input
          className="input"
          placeholder={t('mcpServerUrlPlaceholder')}
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
        />

        <label className="field-label">Personal Access Token</label>
        <input
          className="input"
          type="password"
          placeholder="figd_..."
          value={pat}
          onChange={(e) => setPat(e.target.value)}
        />

        <label className="field-label">{t('mcpProxy')}</label>
        <input
          className="input"
          placeholder={t('mcpProxyPlaceholder')}
          value={proxy}
          onChange={(e) => setProxy(e.target.value)}
        />

        <p className="settings-desc">
          {t('mcpHelp')}{' '}
          <a
            className="settings-link"
            href="https://help.figma.com/hc/en-us/articles/8045757426179-Manage-personal-access-tokens"
            target="_blank"
            rel="noreferrer"
          >
            {t('mcpHelpLink')}
          </a>
        </p>

        <div className="modal-actions">
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={!canSave}
            onClick={() =>
              canSave &&
              onSave({
                id: initial?.id ?? genId(),
                name: name.trim(),
                serverUrl: serverUrl.trim(),
                pat: pat.trim(),
                proxy: proxy.trim()
              })
            }
          >
            {t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** MCP 管理：MCP 服务列表（弹窗添加，与模型列表交互一致） */
function McpSection() {
  const { t } = useTranslation('settings')
  const [mcps, setMcps] = useState<McpItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState<McpItem | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [testingId, setTestingId] = useState('')
  const [testMsg, setTestMsg] = useState<Record<string, { ok: boolean; text: string }>>({})

  useEffect(() => {
    window.electronAPI.getConfig().then((c) => {
      const list = (c.mcps as McpItem[] | undefined) ?? []
      // 兼容旧版单条 figmaMcp 配置，自动迁移为列表
      if (list.length === 0) {
        const legacy = (c.figmaMcp ?? {}) as Partial<FigmaMcpConfig>
        if (legacy.serverUrl && legacy.pat) {
          const migrated: McpItem[] = [
            { id: genId(), name: 'Figma MCP', serverUrl: legacy.serverUrl, pat: legacy.pat }
          ]
          setMcps(migrated)
          void window.electronAPI.setConfig('mcps', migrated)
          setLoaded(true)
          return
        }
      }
      setMcps(list)
      setLoaded(true)
    })
  }, [])

  const persist = async (next: McpItem[]) => {
    setMcps(next)
    await window.electronAPI.setConfig('mcps', next)
  }

  /** 启用/停用开关（停用后自动走查不再读取该服务的 PAT） */
  const toggleMcp = (m: McpItem) => {
    void persist(mcps.map((x) => (x.id === m.id ? { ...x, enabled: x.enabled === false } : x)))
  }

  /** 连通性测试：走主进程代理自适应 fetch，任何 HTTP 响应视为可达 */
  const testMcp = async (id: string) => {
    const target = mcps.find((x) => x.id === id)
    if (!target) return
    setTestingId(id)
    setTestMsg((prev) => ({ ...prev, [id]: { ok: true, text: t('testing') } }))
    try {
      const res = await window.electronAPI.mcpTest({
        serverUrl: target.serverUrl,
        pat: target.pat,
        proxy: target.proxy
      })
      setTestMsg((prev) => ({ ...prev, [id]: { ok: res.ok, text: res.message } }))
    } catch (err) {
      setTestMsg((prev) => ({
        ...prev,
        [id]: { ok: false, text: t('testFail', { msg: err instanceof Error ? err.message : String(err) }) }
      }))
    }
    setTestingId('')
  }

  return (
    <Section
      title={t('mcpTitle')}
      desc={t('mcpDesc')}
    >
      <div className="settings-section-head">
        <span className="model-count">{loaded ? t('mcpCount', { count: mcps.length }) : ''}</span>
          <button type="button" className="btn-primary" onClick={() => setShowNew(true)}>
            {t('addMcpBtn')}
          </button>
      </div>
      {!loaded ? null : mcps.length === 0 ? (
        <p className="settings-empty">{t('emptyMcps')}</p>
      ) : (
        <div className="model-list">
          {mcps.map((m) => (
            <div key={m.id} className={`model-item${m.enabled === false ? ' disabled' : ''}`}>
              <div className="model-item-head">
                <span className="model-name">{m.name}</span>
                {m.enabled !== false ? (
                  <span className="badge badge-green">{t('mcpEnabled')}</span>
                ) : (
                  <span className="badge model-badge-gray">{t('mcpDisabled')}</span>
                )}
                {/* 右侧操作组：悬停 icon（测试/编辑/删除）+ 常驻开关 */}
                <div className="mcp-head-actions">
                  <button
                    type="button"
                    className={`icon-btn${testingId === m.id ? ' testing' : ''}`}
                    title={testingId === m.id ? t('testing') : t('titleConnTest')}
                    disabled={testingId === m.id}
                    onClick={() => void testMcp(m.id)}
                  >
                    <IconPlug />
                  </button>
                  <button type="button" className="icon-btn" title={t('edit')} onClick={() => setEditing(m)}>
                    <IconPencil />
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    title={t('del')}
                    onClick={() => {
                      if (!window.confirm(t('deleteMcpConfirm', { name: m.name }))) return
                      void persist(mcps.filter((x) => x.id !== m.id))
                    }}
                  >
                    <IconTrash />
                  </button>
                  <button
                    type="button"
                    className={`switch ${m.enabled !== false ? 'on' : ''}`}
                    title={m.enabled !== false ? t('switchDisable') : t('switchEnable')}
                    onClick={() => toggleMcp(m)}
                  />
                </div>
              </div>
              <div className="model-item-meta">{m.serverUrl}</div>
              {m.proxy && <div className="model-item-meta">{t('mcpProxyMeta', { proxy: m.proxy })}</div>}
              {testMsg[m.id] && (
                <p className={`model-test-msg ${testMsg[m.id].ok ? 'ok' : 'err'}`}>{testMsg[m.id].text}</p>
              )}
            </div>
          ))}
        </div>
      )}
      {(showNew || editing) && (
        <McpModal
          initial={editing ?? undefined}
          onSave={(m) => {
            const exists = mcps.some((x) => x.id === m.id)
            void persist(exists ? mcps.map((x) => (x.id === m.id ? m : x)) : [...mcps, m])
            setShowNew(false)
            setEditing(null)
          }}
          onCancel={() => {
            setShowNew(false)
            setEditing(null)
          }}
        />
      )}
    </Section>
  )
}

/** 添加 / 编辑技能弹窗（交互与添加模型一致） */
function SkillModal({
  initial,
  onSave,
  onCancel
}: {
  initial?: SkillItem
  onSave: (s: SkillItem) => void
  onCancel: () => void
}) {
  const { t } = useTranslation('settings')
  const [name, setName] = useState(initial?.name ?? '')
  const [desc, setDesc] = useState(initial?.desc ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const canSave = !!name.trim()

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h3>{initial ? t('editSkill') : t('addSkill')}</h3>

        <label className="field-label">{t('skillName')}</label>
        <input
          className="input"
          autoFocus
          placeholder={t('skillNamePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="field-label">{t('skillDesc')}</label>
        <textarea
          className="input"
          rows={3}
          placeholder={t('skillDescPlaceholder')}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />

        <label className="field-label">{t('skillUrl')}</label>
        <input
          className="input"
          placeholder={t('skillUrlPlaceholder')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />

        <div className="modal-actions">
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={!canSave}
            onClick={() =>
              canSave &&
              onSave({
                id: initial?.id ?? genId(),
                name: name.trim(),
                desc: desc.trim(),
                url: url.trim()
              })
            }
          >
            {t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** SkillHub：自定义技能列表（弹窗添加 + Zip 包导入，与模型列表交互一致） */
function SkillsSection() {
  const { t } = useTranslation('settings')
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState<SkillItem | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    window.electronAPI.getConfig().then((c) => {
      setSkills((c.skills as SkillItem[] | undefined) ?? [])
      setLoaded(true)
    })
  }, [])

  const persist = async (next: SkillItem[]) => {
    setSkills(next)
    await window.electronAPI.setConfig('skills', next)
  }

  /** 导入 Zip 技能包：解析 manifest 与 .md 指南后入列 */
  const importZip = async () => {
    setImporting(true)
    setImportMsg(null)
    try {
      const res = await window.electronAPI.importSkillZip()
      if (res.canceled) return
      if (!res.ok || !res.skill) {
        setImportMsg({ ok: false, text: res.message || t('importFail') })
        return
      }
      const item: SkillItem = {
        id: genId(),
        name: res.skill.name,
        desc: res.skill.desc ?? '',
        url: '',
        guides: res.skill.guides
      }
      await persist([...skills, item])
      setImportMsg({
        ok: true,
        text: t('importOk', { name: res.skill.name, count: res.skill.guides.length })
      })
    } catch (err) {
      setImportMsg({ ok: false, text: t('importFailMsg', { msg: err instanceof Error ? err.message : String(err) }) })
    } finally {
      setImporting(false)
    }
  }

  return (
    <Section
      title="SkillHub"
      desc={t('skillsDesc')}
    >
      <div className="settings-section-head">
        <span className="model-count">{loaded ? t('skillCount', { count: skills.length }) : ''}</span>
        <div className="settings-head-btns">
          <button type="button" className="btn-secondary" disabled={importing} onClick={() => void importZip()}>
            {importing ? t('importing') : t('importSkillZip')}
          </button>
          <button type="button" className="btn-primary" onClick={() => setShowNew(true)}>
            {t('addSkillBtn')}
          </button>
        </div>
      </div>
      {importMsg && <p className={`model-test-msg ${importMsg.ok ? 'ok' : 'err'}`}>{importMsg.text}</p>}
      {!loaded ? null : skills.length === 0 ? (
        <p className="settings-empty">{t('emptySkills')}</p>
      ) : (
        <div className="model-list">
          {skills.map((s) => (
            <div key={s.id} className="model-item">
              <div className="model-item-head">
                <span className="model-name">{s.name}</span>
                <span className="badge model-badge-gray">{t('badgeSkill')}</span>
                {!!s.guides?.length && (
                  <span className="badge model-badge-gray" title={t('guidesTitle')}>
                    {t('guidesCount', { count: s.guides.length })}
                  </span>
                )}
              </div>
              {s.desc && <div className="model-item-meta">{s.desc}</div>}
              {s.url && (
                <a className="settings-link skill-url" href={s.url} target="_blank" rel="noreferrer">
                  {s.url} ↗
                </a>
              )}
              <div className="model-item-actions">
                <button type="button" className="icon-btn" title={t('edit')} onClick={() => setEditing(s)}>
                  <IconPencil />
                </button>
                <button
                  type="button"
                  className="icon-btn danger"
                  title={t('del')}
                  onClick={() => {
                    if (!window.confirm(t('deleteSkillConfirm', { name: s.name }))) return
                    void persist(skills.filter((x) => x.id !== s.id))
                  }}
                >
                  <IconTrash />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {(showNew || editing) && (
        <SkillModal
          initial={editing ?? undefined}
          onSave={(s) => {
            const exists = skills.some((x) => x.id === s.id)
            void persist(exists ? skills.map((x) => (x.id === s.id ? s : x)) : [...skills, s])
            setShowNew(false)
            setEditing(null)
          }}
          onCancel={() => {
            setShowNew(false)
            setEditing(null)
          }}
        />
      )}
    </Section>
  )
}

/** 连接卡凭据字段定义（key 对应 config 内字段名；secret 控制已保存态打码） */
interface DocAppField {
  key: string
  label: string
  placeholder: string
  secret?: boolean
}

/** 连通性测试函数（各平台主进程 IPC 验证凭据） */
type DocAppTester = () => Promise<{ ok: boolean; message: string }>

/** 应用授权连接卡片：凭据保存 + 测试连接（编辑态 / 已存只读两态） */
function DocAppCard({
  title,
  desc,
  configKey,
  fields,
  tester
}: {
  title: string
  desc: string
  /** config 存储键：feishu / tencentDocs / kingsoftDocs */
  configKey: string
  fields: DocAppField[]
  tester: DocAppTester
}) {
  const { t } = useTranslation('settings')
  const [cred, setCred] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  /** 凭据已保存：只读展示，点「编辑」再进输入态 */
  const [saved, setSaved] = useState(false)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      const f = (cfg[configKey] ?? {}) as Record<string, string | undefined>
      const next: Record<string, string> = {}
      fields.forEach((fd) => (next[fd.key] = f[fd.key] ?? ''))
      setCred(next)
      setSaved(fields.every((fd) => (f[fd.key] ?? '').trim()))
      setEditing(!fields.every((fd) => (f[fd.key] ?? '').trim()))
    })
  }, [configKey, fields])

  const save = async () => {
    await window.electronAPI.setConfig(configKey, cred)
    setSaved(true)
    setEditing(false)
    setMsg({ ok: true, text: t('saved') })
  }

  const test = async () => {
    setMsg({ ok: true, text: t('testing') })
    try {
      await window.electronAPI.setConfig(configKey, cred)
      const res = await tester()
      setMsg({ ok: res.ok, text: res.message })
    } catch (err) {
      // 主进程/preload 改动后未重启应用时，新通道不存在（is not a function），给出明确指引
      const raw = err instanceof Error ? err.message : String(err)
      setMsg({
        ok: false,
        text: raw.includes('is not a function') ? t('channelMissing') : t('testFailMsg', { msg: raw })
      })
    }
  }

  const msgNode = msg ? (
    <span className={msg.ok ? 'ok-label' : 'model-test-msg err inline'}>{msg.text}</span>
  ) : null

  return (
    <Section title={title} desc={desc}>
      {editing ? (
        <>
          <div className="docapp-fields">
            {fields.map((fd) => (
              <input
                key={fd.key}
                className="input"
                placeholder={fd.placeholder}
                value={cred[fd.key] ?? ''}
                onChange={(e) => setCred({ ...cred, [fd.key]: e.target.value })}
              />
            ))}
          </div>
          <div className="form-row settings-feishu-actions">
            <button className="btn-primary" onClick={save}>
              {t('save')}
            </button>
            <button className="btn-secondary" onClick={test}>
              {t('testConn')}
            </button>
            {msgNode}
          </div>
        </>
      ) : (
        <div className="feishu-view">
          {fields.map((fd) => (
            <div className="feishu-view-row" key={fd.key}>
              <span className="feishu-view-label">{fd.label}</span>
              <span className="feishu-view-value">
                {fd.secret && saved ? t('maskedSaved') : cred[fd.key] || t('notConfigured')}
              </span>
            </div>
          ))}
          <div className="form-row settings-feishu-actions">
            <button className="btn-secondary" onClick={() => setEditing(true)}>
              {t('edit')}
            </button>
            <button className="btn-secondary" onClick={test}>
              {t('testConn')}
            </button>
            {msgNode}
          </div>
        </div>
      )}
    </Section>
  )
}

/** 应用授权：飞书 / 腾讯文档 / 金山文档 连接配置（均支持测试连接与导出创建） */
function AuthSection() {
  const { t } = useTranslation('settings')
  // 三平台连接卡字段（useMemo 保持引用稳定，避免 DocAppCard 的 useEffect 反复重置编辑态）
  const feishuFields = useMemo<DocAppField[]>(
    () => [
      { key: 'appId', label: 'App ID', placeholder: t('feishuAppIdPlaceholder') },
      { key: 'appSecret', label: 'App Secret', placeholder: 'App Secret', secret: true }
    ],
    [t]
  )
  const tencentFields = useMemo<DocAppField[]>(
    () => [
      { key: 'clientId', label: 'Client ID', placeholder: t('tencentClientIdPlaceholder') },
      { key: 'accessToken', label: 'Access Token', placeholder: 'Access Token', secret: true },
      { key: 'openId', label: 'Open ID', placeholder: 'Open ID' }
    ],
    [t]
  )
  const kingsoftFields = useMemo<DocAppField[]>(
    () => [
      { key: 'appId', label: 'App ID', placeholder: 'App ID' },
      { key: 'appSecret', label: 'App Secret', placeholder: 'App Secret', secret: true }
    ],
    [t]
  )

  return (
    <>
      <DocAppCard
        title={t('feishuTitle')}
        desc={t('feishuDesc')}
        configKey="feishu"
        fields={feishuFields}
        tester={() => window.electronAPI.feishuTest()}
      />
      <DocAppCard
        title={t('tencentTitle')}
        desc={t('tencentDesc')}
        configKey="tencentDocs"
        fields={tencentFields}
        tester={() => window.electronAPI.tencentTest()}
      />
      <DocAppCard
        title={t('kingsoftTitle')}
        desc={t('kingsoftDesc')}
        configKey="kingsoftDocs"
        fields={kingsoftFields}
        tester={() => window.electronAPI.kingsoftTest()}
      />
    </>
  )
}

/** 浏览器：AI 任务默认浏览器（内置/系统）+ 独立开发浏览器窗口入口 + 清除浏览记录 */
function BrowserSection() {
  const { t } = useTranslation('settings')
  const [url, setUrl] = useState('')
  /** AI 任务默认浏览器：builtin = 内置浏览器（可自动采集）；system = 系统浏览器（仅打开浏览） */
  const [browser, setBrowser] = useState<'builtin' | 'system'>('builtin')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    window.electronAPI.getConfig().then((c) => {
      setUrl((c.devBrowserUrl as string | undefined) ?? '')
      const saved = c.aiDefaultBrowser as string | undefined
      setBrowser(saved === 'system' ? 'system' : 'builtin')
    })
  }, [])

  const open = async () => {
    const raw = url.trim()
    if (!raw) return
    const full = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
    setUrl(full)
    void window.electronAPI.setConfig('devBrowserUrl', full)
    try {
      const res = await window.electronAPI.openDevBrowser(full)
      setMsg({ ok: res.ok, text: res.message })
    } catch (err) {
      setMsg({ ok: false, text: t('openFail', { msg: err instanceof Error ? err.message : String(err) }) })
    }
  }

  /** 清除内置浏览器保存的浏览数据（Cookies / 本地存储 / 缓存等），登录态将丢失 */
  const clearBrowserData = async () => {
    if (!window.confirm(t('clearConfirm'))) return
    setClearing(true)
    setMsg(null)
    try {
      const res = await window.electronAPI.clearBrowserData()
      setMsg({ ok: res.ok, text: res.message })
    } catch (err) {
      setMsg({ ok: false, text: t('clearFail', { msg: err instanceof Error ? err.message : String(err) }) })
    } finally {
      setClearing(false)
    }
  }

  return (
    <Section
      title={t('browserTitle')}
      desc={t('browserDesc')}
    >
      <div className="settings-gen-row">
        <div className="settings-gen-info">
          <span className="settings-gen-label">{t('defaultBrowserLabel')}</span>
          <span className="settings-gen-sub">
            {browser === 'builtin'
              ? t('browserBuiltinDesc')
              : t('browserSystemDesc')}
          </span>
        </div>
        <div className="segmented">
          {(['builtin', 'system'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`segment-item ${browser === m ? 'active' : ''}`}
              onClick={() => {
                setBrowser(m)
                void window.electronAPI.setConfig('aiDefaultBrowser', m)
              }}
            >
              {m === 'builtin' ? t('browser_builtin') : t('browser_system')}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-gen-row no-border">
        <div className="settings-gen-info">
          <span className="settings-gen-label">{t('devBrowserLabel')}</span>
          <span className="settings-gen-sub">{t('devBrowserDesc')}</span>
        </div>
      </div>
      <div className="browser-open-row">
        <input
          className="input"
          placeholder={t('devUrlPlaceholder')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void open()}
        />
        <button className="btn-primary" disabled={!url.trim()} onClick={() => void open()}>
          {t('openBrowser')}
        </button>
      </div>
      <div className="settings-gen-row">
        <div className="settings-gen-info">
          <span className="settings-gen-label">{t('clearLabel')}</span>
          <span className="settings-gen-sub">
            {t('clearDesc')}
          </span>
        </div>
        <button className="btn-secondary" disabled={clearing} onClick={() => void clearBrowserData()}>
          {clearing ? t('clearing') : t('clearLabel')}
        </button>
      </div>
      {msg && <p className={`model-test-msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</p>}
    </Section>
  )
}

/** 关于应用 */
function AboutSection() {
  const { t } = useTranslation('settings')
  return (
    <Section>
      <div className="about-hero">
        <img className="about-logo" src={appIconUrl} alt={t('aboutAlt')} />
        <div className="about-info">
          <div className="about-name-row">
            <span className="about-name">{t('appName')}</span>
            <span className="about-ver-tag">v{pkg.version}</span>
          </div>
          <p className="settings-desc about-desc">
            {t('aboutDesc')}
          </p>
          <div className="about-meta">
            <div className="about-meta-line">
              <span className="about-meta-label">{t('author')}</span>
              <a className="settings-link" href="https://quweijia.is-a.dev/" target="_blank" rel="noreferrer">
                Vic Qu ↗
              </a>
            </div>
            <div className="about-meta-line">
              <span className="about-meta-label">{t('techStack')}</span>
              <span>Electron · React · TypeScript · Dexie</span>
            </div>
          </div>
        </div>
      </div>
    </Section>
  )
}

/** AI 小助手管理：显隐开关 / 悬浮球图标大小 / 助手专用模型（改动即时生效） */
function AssistantSection() {
  const { t } = useTranslation('settings')
  const [visible, setVisible] = useState(true)
  const [fabSize, setFabSize] = useState(44)
  const [modelId, setModelId] = useState('')
  const [models, setModels] = useState<AIModel[]>([])
  const [defId, setDefId] = useState('')

  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      setVisible((cfg.aiAssistantVisible as boolean | undefined) ?? true)
      const size = Number(cfg.aiAssistantFabSize)
      setFabSize(Number.isFinite(size) && size >= 28 && size <= 72 ? size : 44)
      setModelId((cfg.aiAssistantModelId as string | undefined) ?? '')
      setModels(((cfg.aiModels as AIModel[] | undefined) ?? []).filter((m) => m.id))
      setDefId((cfg.aiDefaultModelId as string | undefined) ?? '')
    })
  }, [])

  /** 保存后广播：悬浮球监听事件即时刷新显隐与尺寸 */
  const notifyFab = () => window.dispatchEvent(new CustomEvent('ai-assistant-config-change'))

  return (
    <Section title={t('assistantTitle')} desc={t('assistantDesc')}>
      <div className="settings-gen-row">
        <div className="settings-gen-info">
          <span className="settings-gen-label">{t('assistantShowLabel')}</span>
          <span className="settings-gen-sub">{t('assistantShowDesc')}</span>
        </div>
        <button
          type="button"
          className={`switch ${visible ? 'on' : ''}`}
          onClick={() => {
            const next = !visible
            setVisible(next)
            void window.electronAPI.setConfig('aiAssistantVisible', next).then(notifyFab)
          }}
        />
      </div>
      <div className="settings-gen-row">
        <div className="settings-gen-info">
          <span className="settings-gen-label">{t('assistantSizeLabel')}</span>
          <span className="settings-gen-sub">{t('assistantSizeDesc', { size: fabSize })}</span>
        </div>
        <input
          type="range"
          min={28}
          max={72}
          step={2}
          value={fabSize}
          style={{ width: 200, accentColor: 'var(--primary)' }}
          onChange={(e) => setFabSize(Number(e.target.value))}
          onPointerUp={() => {
            void window.electronAPI.setConfig('aiAssistantFabSize', fabSize).then(notifyFab)
          }}
          onKeyUp={() => {
            void window.electronAPI.setConfig('aiAssistantFabSize', fabSize).then(notifyFab)
          }}
        />
      </div>
      <div className="settings-gen-row">
        <div className="settings-gen-info">
          <span className="settings-gen-label">{t('assistantModelLabel')}</span>
          <span className="settings-gen-sub">{t('assistantModelDesc')}</span>
        </div>
        <USelect
          value={modelId}
          onChange={(v) => {
            setModelId(v)
            void window.electronAPI.setConfig('aiAssistantModelId', v)
          }}
          options={[
            { value: '', label: t('assistantModelFollow', { name: models.find((m) => m.id === defId)?.name ?? '—' }) },
            ...models.map((m) => ({ value: m.id, label: m.name }))
          ]}
        />
      </div>
      <div className="settings-gen-row">
        <div className="settings-gen-info">
          <span className="settings-gen-label">{t('assistantClearLabel')}</span>
          <span className="settings-gen-sub">{t('assistantClearDesc')}</span>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            if (!window.confirm(t('assistantClearConfirm'))) return
            void db.assistantMessages.clear().then(() => {
              // 通知打开中的助手面板刷新当前会话
              window.dispatchEvent(new CustomEvent('ai-assistant-history-clear'))
            })
          }}
        >
          {t('assistantClearBtn')}
        </button>
      </div>
    </Section>
  )
}

export default function Settings() {
  const { t } = useTranslation('settings')
  const navigate = useNavigate()
  const location = useLocation()
  const { tab } = useSettingsStore()

  /** 来源页名称（顶栏设置按钮导航时写入），顶部返回标题跟随显示 */
  const from = (location.state as { from?: string } | null)?.from ?? t('pageList')
  const goBack = () => {
    if (window.history.length > 1) navigate(-1)
    else navigate('/')
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="settings-head-left">
          <button type="button" className="settings-close" title={t('backTo', { from })} onClick={goBack}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <h1>{t('backTo', { from })}</h1>
        </div>
      </div>

      {tab === 'models' && <ModelsSection />}
      {tab === 'assistant' && <AssistantSection />}
      {tab === 'general' && <GeneralSection />}
      {tab === 'tolerance' && <ToleranceSection />}
      {tab === 'mcp' && <McpSection />}
      {tab === 'skills' && <SkillsSection />}
      {tab === 'auth' && <AuthSection />}
      {tab === 'browser' && <BrowserSection />}
      {tab === 'about' && <AboutSection />}
    </div>
  )
}
