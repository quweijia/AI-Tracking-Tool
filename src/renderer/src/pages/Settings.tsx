import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import pkg from '../../../../package.json'
import appIconUrl from '../assets/app-icon.png'
import { useSettingsStore } from '../stores/settings'
import USelect from '../components/USelect'

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

interface FeishuConfig {
  appId: string
  appSecret: string
}

interface FigmaMcpConfig {
  serverUrl: string
  pat: string
}

interface SkillItem {
  id: string
  name: string
  desc: string
  url: string
}

/** 主题模式：跟随系统 / 手动浅色 / 手动深色（Layout 同步监听 localStorage + 自定义事件） */
type ThemeMode = 'system' | 'light' | 'dark'

/** 预置模板：选填 baseUrl / model 快捷填充 */
const PRESETS: { key: string; label: string; baseUrl: string; model: string }[] = [
  { key: 'custom', label: '自定义', baseUrl: '', model: '' },
  { key: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-vl2' },
  { key: 'qwen', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max' },
  { key: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-plus' },
  { key: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' }
]

function genId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

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

  const applyPreset = (key: string) => {
    setPreset(key)
    const p = PRESETS.find((x) => x.key === key)
    if (p && p.baseUrl) {
      setBaseUrl(p.baseUrl)
      setModel(p.model)
      if (!name) setName(p.label)
      setVision(true)
    }
  }

  const canSave = name.trim() && baseUrl.trim() && apiKey.trim() && model.trim()

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h3>{initial ? '编辑模型' : '添加模型'}</h3>

        <label className="field-label">快捷模板（OpenAI 兼容协议）</label>
        <div className="preset-chips">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`preset-chip ${preset === p.key ? 'active' : ''}`}
              onClick={() => applyPreset(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <label className="field-label">名称</label>
        <input
          className="input"
          placeholder="如：DeepSeek 视觉"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="field-label">Base URL</label>
        <input
          className="input"
          placeholder="如：https://api.deepseek.com/v1"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />

        <div className="modal-grid">
          <div>
            <label className="field-label">模型 ID</label>
            <input
              className="input"
              placeholder="如：gpt-4o"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label">API Key</label>
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
          支持图像输入（走查识别必须勾选多模态模型）
        </label>

        <div className="modal-actions">
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            取消
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
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

/** AI 模型管理：模型列表 + 测试连接 + 默认模型 */
function ModelsSection() {
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
    setTestMsg((prev) => ({ ...prev, [id]: { ok: true, text: '测试中...' } }))
    try {
      if (typeof window.electronAPI.aiTest !== 'function') {
        throw new Error('主进程通道未加载，请重启应用后重试')
      }
      const res = await window.electronAPI.aiTest(id)
      setTestMsg((prev) => ({
        ...prev,
        [id]: { ok: res.ok, text: res.ok ? `连接成功（${res.latencyMs}ms）` : res.message }
      }))
    } catch (err) {
      setTestMsg((prev) => ({
        ...prev,
        [id]: { ok: false, text: `调用失败：${err instanceof Error ? err.message : String(err)}` }
      }))
    }
    setTestingId('')
  }

  return (
    <>
      <Section
        title="模型列表"
        desc="配置 OpenAI 兼容协议的多模态模型，用于 AI 自动识别走查问题。Key 仅保存在本机配置文件中。"
      >
        <div className="settings-section-head">
          <span className="model-count">{loaded ? `共 ${models.length} 个模型` : ''}</span>
          <button type="button" className="btn-primary btn-sm" onClick={() => setShowNew(true)}>
            ＋ 添加模型
          </button>
        </div>
        {!loaded ? null : models.length === 0 ? (
          <p className="settings-empty">还没有模型配置，点击「添加模型」开始</p>
        ) : (
          <div className="model-list">
            {models.map((m) => (
              <div key={m.id} className={`model-item${m.id === defaultId ? ' default' : ''}`}>
                <div className="model-item-head">
                  <span className="model-name">{m.name}</span>
                  {m.id === defaultId && <span className="badge">默认</span>}
                  {m.vision ? (
                    <span className="badge badge-green">图像输入</span>
                  ) : (
                    <span className="badge model-badge-gray">纯文本</span>
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
                    <button className="btn-text" onClick={() => void persistModels(models, m.id)}>
                      设为默认
                    </button>
                  )}
                  <button className="btn-text" disabled={testingId === m.id} onClick={() => testModel(m.id)}>
                    {testingId === m.id ? '测试中...' : '测试连接'}
                  </button>
                  <button className="btn-text" onClick={() => setEditing(m)}>
                    编辑
                  </button>
                  <button
                    className="btn-text danger"
                    onClick={() => {
                      if (!window.confirm(`确定删除模型「${m.name}」吗？`)) return
                      void persistModels(models.filter((x) => x.id !== m.id))
                    }}
                  >
                    删除
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

/** 通用设置：主题（跟随系统/浅色/深色）+ 语言 */
function GeneralSection() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const v = localStorage.getItem('app-theme')
    return v === 'dark' || v === 'light' ? v : 'system'
  })
  const [lang, setLang] = useState(() => localStorage.getItem('app-lang') ?? 'zh-CN')

  const changeMode = (m: ThemeMode) => {
    setMode(m)
    localStorage.setItem('app-theme', m)
    // 通知 Layout 立即切换（含跟随系统的媒体查询重算）
    window.dispatchEvent(new CustomEvent('app-theme-change', { detail: m }))
  }

  return (
    <Section title="通用设置" desc="外观主题与语言偏好。选择「跟随系统」时，将随 macOS 深浅色模式自动切换。">
      <div className="settings-gen-row">
        <div className="settings-gen-info">
          <span className="settings-gen-label">外观主题</span>
          <span className="settings-gen-sub">
            当前：{mode === 'system' ? '跟随系统' : mode === 'dark' ? '深色' : '浅色'}
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
              {m === 'system' ? '跟随系统' : m === 'dark' ? '深色' : '浅色'}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-gen-row">
        <div className="settings-gen-info">
          <span className="settings-gen-label">界面语言</span>
          <span className="settings-gen-sub">英文语言包准备中，暂不支持切换</span>
        </div>
        <USelect
          value={lang}
          onChange={(v) => {
            setLang(v)
            localStorage.setItem('app-lang', v)
          }}
          options={[
            { value: 'zh-CN', label: '简体中文' },
            { value: 'en-US', label: 'English（即将上线）', disabled: true }
          ]}
        />
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
  const [name, setName] = useState(initial?.name ?? '')
  const [serverUrl, setServerUrl] = useState(initial?.serverUrl ?? '')
  const [pat, setPat] = useState(initial?.pat ?? '')

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
        <h3>{initial ? '编辑 MCP 服务' : '添加 MCP 服务'}</h3>

        <label className="field-label">名称</label>
        <input
          className="input"
          autoFocus
          placeholder="如：Figma MCP"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="field-label">Server URL</label>
        <input
          className="input"
          placeholder="如：https://mcp.figma.com/mcp"
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

        <p className="settings-desc">
          获取方式：Figma → Settings → Security → Personal access tokens，生成后粘贴到上方。{' '}
          <a
            className="settings-link"
            href="https://help.figma.com/hc/en-us/articles/8045757426179-Manage-personal-access-tokens"
            target="_blank"
            rel="noreferrer"
          >
            查看官方说明 ↗
          </a>
        </p>

        <div className="modal-actions">
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            取消
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
                pat: pat.trim()
              })
            }
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

/** MCP 管理：MCP 服务列表（弹窗添加，与模型列表交互一致） */
function McpSection() {
  const [mcps, setMcps] = useState<McpItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState<McpItem | null>(null)
  const [showNew, setShowNew] = useState(false)

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

  return (
    <Section
      title="MCP 管理"
      desc="配置 MCP 服务连接（如 Figma MCP），用于直接读取设计稿数据。Token 仅保存在本机配置文件中。"
    >
      <div className="settings-section-head">
        <span className="model-count">{loaded ? `共 ${mcps.length} 个服务` : ''}</span>
        <button type="button" className="btn-primary btn-sm" onClick={() => setShowNew(true)}>
          ＋ 添加 MCP
        </button>
      </div>
      {!loaded ? null : mcps.length === 0 ? (
        <p className="settings-empty">还没有 MCP 服务，点击「添加 MCP」开始</p>
      ) : (
        <div className="model-list">
          {mcps.map((m) => (
            <div key={m.id} className="model-item">
              <div className="model-item-head">
                <span className="model-name">{m.name}</span>
              </div>
              <div className="model-item-meta">{m.serverUrl}</div>
              <div className="model-item-actions">
                <button className="btn-text" onClick={() => setEditing(m)}>
                  编辑
                </button>
                <button
                  className="btn-text danger"
                  onClick={() => {
                    if (!window.confirm(`确定删除 MCP 服务「${m.name}」吗？`)) return
                    void persist(mcps.filter((x) => x.id !== m.id))
                  }}
                >
                  删除
                </button>
              </div>
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
        <h3>{initial ? '编辑技能' : '添加技能'}</h3>

        <label className="field-label">技能名称</label>
        <input
          className="input"
          autoFocus
          placeholder="如：iOS HIG 检查清单"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="field-label">技能说明（选填）</label>
        <textarea
          className="input"
          rows={3}
          placeholder="描述该技能的走查要点，AI 自动识别时将作为检查指引注入"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />

        <label className="field-label">技能链接（选填）</label>
        <input
          className="input"
          placeholder="如：https://..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />

        <div className="modal-actions">
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            取消
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
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

/** SkillHub：自定义技能列表（弹窗添加，与模型列表交互一致） */
function SkillsSection() {
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState<SkillItem | null>(null)
  const [showNew, setShowNew] = useState(false)

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

  return (
    <Section
      title="SkillHub"
      desc="添加自定义技能（检查清单、走查要点等）。AI 自动识别时可在工作台选择技能，按技能要点进行走查。"
    >
      <div className="settings-section-head">
        <span className="model-count">{loaded ? `共 ${skills.length} 个技能` : ''}</span>
        <button type="button" className="btn-primary btn-sm" onClick={() => setShowNew(true)}>
          ＋ 添加技能
        </button>
      </div>
      {!loaded ? null : skills.length === 0 ? (
        <p className="settings-empty">还没有添加技能</p>
      ) : (
        <div className="model-list">
          {skills.map((s) => (
            <div key={s.id} className="model-item">
              <div className="model-item-head">
                <span className="model-name">{s.name}</span>
                <span className="badge model-badge-gray">技能</span>
              </div>
              {s.desc && <div className="model-item-meta">{s.desc}</div>}
              {s.url && (
                <a className="settings-link skill-url" href={s.url} target="_blank" rel="noreferrer">
                  {s.url} ↗
                </a>
              )}
              <div className="model-item-actions">
                <button className="btn-text" onClick={() => setEditing(s)}>
                  编辑
                </button>
                <button
                  className="btn-text danger"
                  onClick={() => {
                    if (!window.confirm(`确定删除技能「${s.name}」吗？`)) return
                    void persist(skills.filter((x) => x.id !== s.id))
                  }}
                >
                  删除
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

/** 应用授权：飞书集成（自建应用凭据） */
function AuthSection() {
  const [feishu, setFeishu] = useState<FeishuConfig>({ appId: '', appSecret: '' })
  const [feishuMsg, setFeishuMsg] = useState<{ ok: boolean; text: string } | null>(null)
  /** 凭据已保存：只读展示，点「编辑」再进输入态 */
  const [feishuSaved, setFeishuSaved] = useState(false)
  const [feishuEditing, setFeishuEditing] = useState(false)

  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      const f = (cfg.feishu ?? {}) as Partial<FeishuConfig>
      setFeishu({ appId: f.appId ?? '', appSecret: f.appSecret ?? '' })
      const has = !!(f.appId && f.appSecret)
      setFeishuSaved(has)
      setFeishuEditing(!has)
    })
  }, [])

  const saveFeishu = async () => {
    await window.electronAPI.setConfig('feishu', feishu)
    setFeishuSaved(true)
    setFeishuEditing(false)
    setFeishuMsg({ ok: true, text: '已保存' })
  }

  const testFeishu = async () => {
    await window.electronAPI.setConfig('feishu', feishu)
    setFeishuMsg(null)
    const res = await window.electronAPI.feishuTest()
    setFeishuMsg({ ok: res.ok, text: res.message })
  }

  return (
    <Section
      title="飞书集成"
      desc="使用飞书自建应用凭据（需开通云文档权限），用于一键将走查报告创建为飞书文档。"
    >
      {feishuEditing ? (
        <>
          <div className="form-row">
            <input
              className="input grow"
              placeholder="App ID（cli_xxx）"
              value={feishu.appId}
              onChange={(e) => setFeishu({ ...feishu, appId: e.target.value })}
            />
            <input
              className="input grow"
              type="password"
              placeholder="App Secret"
              value={feishu.appSecret}
              onChange={(e) => setFeishu({ ...feishu, appSecret: e.target.value })}
            />
          </div>
          <div className="form-row settings-feishu-actions">
            <button className="btn-primary" onClick={saveFeishu}>
              保存
            </button>
            <button className="btn-secondary" onClick={testFeishu}>
              测试连接
            </button>
            {feishuMsg && (
              <span className={feishuMsg.ok ? 'ok-label' : 'model-test-msg err inline'}>{feishuMsg.text}</span>
            )}
          </div>
        </>
      ) : (
        <div className="feishu-view">
          <div className="feishu-view-row">
            <span className="feishu-view-label">App ID</span>
            <span className="feishu-view-value">{feishu.appId || '未配置'}</span>
          </div>
          <div className="feishu-view-row">
            <span className="feishu-view-label">App Secret</span>
            <span className="feishu-view-value">{feishuSaved ? '••••••••••••（已保存）' : '未配置'}</span>
          </div>
          <div className="form-row settings-feishu-actions">
            <button className="btn-secondary" onClick={() => setFeishuEditing(true)}>
              编辑
            </button>
            <button className="btn-secondary" onClick={testFeishu}>
              测试连接
            </button>
            {feishuMsg && (
              <span className={feishuMsg.ok ? 'ok-label' : 'model-test-msg err inline'}>{feishuMsg.text}</span>
            )}
          </div>
        </div>
      )}
    </Section>
  )
}

/** 浏览器：内置浏览器能力占位说明 */
function BrowserSection() {
  return (
    <Section title="内置浏览器" desc="计划中的 AI 自动走查执行环境。">
      <div className="placeholder-box">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
        </svg>
        <p>
          <b>内置浏览器功能开发中</b>
          <br />
          未来将支持直接读取 Figma 设计稿与研发上线的页面链接，自动打开并运行
          AI 整页走查，无需手动上传开发截图。
        </p>
      </div>
      <div className="settings-gen-row browser-switch-row">
        <div className="settings-gen-info">
          <span className="settings-gen-label">启用内置浏览器</span>
          <span className="settings-gen-sub">功能就绪后可开启</span>
        </div>
        <span className="switch" aria-hidden />
      </div>
    </Section>
  )
}

/** 关于应用 */
function AboutSection() {
  return (
    <Section>
      <div className="about-hero">
        <img className="about-logo" src={appIconUrl} alt="AI 走查工具" />
        <div className="about-info">
          <div className="about-name-row">
            <span className="about-name">AI 走查工具</span>
            <span className="about-ver-tag">v{pkg.version}</span>
          </div>
          <p className="settings-desc about-desc">
            UI 设计走查工具：设计稿与开发截图对比、标注、复验与报告导出。数据全部保存在本机。
          </p>
          <div className="about-meta">
            <div className="about-meta-line">
              <span className="about-meta-label">作者</span>
              <a className="settings-link" href="https://quweijia.is-a.dev/" target="_blank" rel="noreferrer">
                Vic Qu ↗
              </a>
            </div>
            <div className="about-meta-line">
              <span className="about-meta-label">技术栈</span>
              <span>Electron · React · TypeScript · Dexie</span>
            </div>
          </div>
        </div>
      </div>
    </Section>
  )
}

export default function Settings() {
  const navigate = useNavigate()
  const { tab } = useSettingsStore()

  return (
    <div className="page">
      <div className="page-header">
        <div className="settings-head-left">
          <button type="button" className="settings-close" title="返回项目列表" onClick={() => navigate('/')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <h1>返回项目</h1>
        </div>
      </div>

      {tab === 'models' && <ModelsSection />}
      {tab === 'general' && <GeneralSection />}
      {tab === 'mcp' && <McpSection />}
      {tab === 'skills' && <SkillsSection />}
      {tab === 'auth' && <AuthSection />}
      {tab === 'browser' && <BrowserSection />}
      {tab === 'about' && <AboutSection />}
    </div>
  )
}
