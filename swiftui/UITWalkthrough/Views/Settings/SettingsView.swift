import SwiftUI

// MARK: - 设置页（对齐 Electron pages/Settings.tsx；m7 落地 AI 模型管理 + 通用音效，m8 补充应用授权）

struct SettingsView: View {
    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                ModelsSection()
                GeneralSection()
                AppAuthSection()
            }
            .padding(20)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - 通用（任务完成音效）

private struct GeneralSection: View {
    @State private var soundEnabled = true

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Text("通用")
                    .font(.headline)
                Toggle("任务完成音效", isOn: $soundEnabled)
                    .onChange(of: soundEnabled) {
                        var cfg = AppConfigStore.load()
                        cfg.soundEnabled = soundEnabled
                        AppConfigStore.save(cfg)
                    }
                Text("AI 识别任务完成后播放提示音，关闭后静默")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
        }
        .onAppear {
            soundEnabled = AppConfigStore.load().soundEnabled != false
        }
    }
}

// MARK: - 应用授权（飞书 / 腾讯文档 / 金山文档，对齐 Settings.tsx 应用授权区块）

private struct AppAuthSection: View {
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 14) {
                FeishuAuthCard()
                Divider()
                TencentAuthCard()
                Divider()
                KingsoftAuthCard()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
        }
    }
}

/// 三张授权卡的公共骨架：标题 + 已保存状态 + 说明 + 字段 + 测试连接
private struct AuthCardLayout<Fields: View>: View {
    let title: String
    let desc: String
    let savedLabel: String
    let fields: () -> Fields

    init(title: String, desc: String, savedLabel: String, @ViewBuilder fields: @escaping () -> Fields) {
        self.title = title
        self.desc = desc
        self.savedLabel = savedLabel
        self.fields = fields
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                Text(savedLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(desc)
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(alignment: .top, spacing: 10) {
                fields()
            }
        }
    }
}

private struct FeishuAuthCard: View {
    @State private var appId = ""
    @State private var appSecret = ""
    @State private var loaded = false
    @State private var testing = false
    @State private var testMsg: (ok: Bool, text: String)?

    private var trimmedAppId: String { appId.trimmingCharacters(in: .whitespaces) }
    private var trimmedSecret: String { appSecret.trimmingCharacters(in: .whitespaces) }
    private var hasSaved: Bool { !trimmedAppId.isEmpty || !trimmedSecret.isEmpty }

    private func persist() {
        var cfg = AppConfigStore.load()
        cfg.feishu = FeishuAppConfig(
            appId: trimmedAppId.isEmpty ? nil : trimmedAppId,
            appSecret: trimmedSecret.isEmpty ? nil : trimmedSecret
        )
        AppConfigStore.save(cfg)
    }

    private func test() {
        testing = true
        testMsg = nil
        Task {
            let res = await FeishuService.test()
            testMsg = (res.ok, res.ok ? "测试通过" : "测试失败：\(res.message)")
            testing = false
        }
    }

    var body: some View {
        AuthCardLayout(
            title: "飞书集成",
            desc: "使用飞书自建应用凭据（需开通云文档权限），用于一键将走查报告创建为飞书文档。",
            savedLabel: hasSaved ? "已保存" : "未配置",
            fields: {
                VStack(alignment: .leading, spacing: 6) {
                    Text("App ID").font(.caption).foregroundStyle(.secondary)
                    TextField("App ID（cli_xxx）", text: $appId)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 240)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("App Secret").font(.caption).foregroundStyle(.secondary)
                    SecureField("App Secret", text: $appSecret)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 240)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(" ").font(.caption)
                    HStack(spacing: 8) {
                        Button(testing ? "测试中..." : "测试连接") { test() }
                            .disabled(testing || !hasSaved)
                        if let msg = testMsg {
                            Text(msg.text)
                                .font(.caption)
                                .foregroundStyle(msg.ok ? Color.green : Color.red)
                                .lineLimit(2)
                        }
                    }
                }
            }
        )
        .onAppear {
            let cfg = AppConfigStore.load().feishu
            appId = cfg?.appId ?? ""
            appSecret = cfg?.appSecret ?? ""
            loaded = true
        }
        .onChange(of: appId) { _, _ in
            if loaded { persist() }
        }
        .onChange(of: appSecret) { _, _ in
            if loaded { persist() }
        }
    }
}

private struct TencentAuthCard: View {
    @State private var clientId = ""
    @State private var accessToken = ""
    @State private var openId = ""
    @State private var loaded = false
    @State private var testing = false
    @State private var testMsg: (ok: Bool, text: String)?

    private func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespaces) }
    private var hasSaved: Bool {
        !trimmed(clientId).isEmpty || !trimmed(accessToken).isEmpty || !trimmed(openId).isEmpty
    }

    private func persist() {
        var cfg = AppConfigStore.load()
        cfg.tencentDocs = TencentDocsConfig(
            clientId: trimmed(clientId).isEmpty ? nil : trimmed(clientId),
            accessToken: trimmed(accessToken).isEmpty ? nil : trimmed(accessToken),
            openId: trimmed(openId).isEmpty ? nil : trimmed(openId)
        )
        AppConfigStore.save(cfg)
    }

    private func test() {
        testing = true
        testMsg = nil
        Task {
            let res = await TencentDocService.test()
            testMsg = (res.ok, res.ok ? "测试通过" : "测试失败：\(res.message)")
            testing = false
        }
    }

    var body: some View {
        AuthCardLayout(
            title: "腾讯文档",
            desc: "填写腾讯文档开放平台「开发者信息」（应用 ID client_id / access_token / open_id），用于一键将走查报告创建为腾讯文档。",
            savedLabel: hasSaved ? "已保存" : "未配置",
            fields: {
                VStack(alignment: .leading, spacing: 6) {
                    Text("应用 ID（client_id）").font(.caption).foregroundStyle(.secondary)
                    TextField("应用 ID（client_id）", text: $clientId)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 200)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("access_token").font(.caption).foregroundStyle(.secondary)
                    SecureField("access_token", text: $accessToken)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 200)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("open_id").font(.caption).foregroundStyle(.secondary)
                    TextField("open_id", text: $openId)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 200)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(" ").font(.caption)
                    HStack(spacing: 8) {
                        Button(testing ? "测试中..." : "测试连接") { test() }
                            .disabled(testing || !hasSaved)
                        if let msg = testMsg {
                            Text(msg.text)
                                .font(.caption)
                                .foregroundStyle(msg.ok ? Color.green : Color.red)
                                .lineLimit(2)
                        }
                    }
                }
            }
        )
        .onAppear {
            let cfg = AppConfigStore.load().tencentDocs
            clientId = cfg?.clientId ?? ""
            accessToken = cfg?.accessToken ?? ""
            openId = cfg?.openId ?? ""
            loaded = true
        }
        .onChange(of: clientId) { _, _ in if loaded { persist() } }
        .onChange(of: accessToken) { _, _ in if loaded { persist() } }
        .onChange(of: openId) { _, _ in if loaded { persist() } }
    }
}

private struct KingsoftAuthCard: View {
    @State private var appId = ""
    @State private var appSecret = ""
    @State private var loaded = false
    @State private var testing = false
    @State private var testMsg: (ok: Bool, text: String)?

    private var trimmedAppId: String { appId.trimmingCharacters(in: .whitespaces) }
    private var trimmedSecret: String { appSecret.trimmingCharacters(in: .whitespaces) }
    private var hasSaved: Bool { !trimmedAppId.isEmpty || !trimmedSecret.isEmpty }

    private func persist() {
        var cfg = AppConfigStore.load()
        cfg.kingsoftDocs = KingsoftDocsConfig(
            appId: trimmedAppId.isEmpty ? nil : trimmedAppId,
            appSecret: trimmedSecret.isEmpty ? nil : trimmedSecret
        )
        AppConfigStore.save(cfg)
    }

    private func test() {
        testing = true
        testMsg = nil
        Task {
            let res = await KingsoftDocService.test()
            testMsg = (res.ok, res.ok ? "测试通过" : "测试失败：\(res.message)")
            testing = false
        }
    }

    var body: some View {
        AuthCardLayout(
            title: "金山文档",
            desc: "填写金山文档开放平台 App ID / App Secret，用于一键将走查报告创建为金山文档。",
            savedLabel: hasSaved ? "已保存" : "未配置",
            fields: {
                VStack(alignment: .leading, spacing: 6) {
                    Text("App ID").font(.caption).foregroundStyle(.secondary)
                    TextField("App ID", text: $appId)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 240)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("App Secret").font(.caption).foregroundStyle(.secondary)
                    SecureField("App Secret", text: $appSecret)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 240)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(" ").font(.caption)
                    HStack(spacing: 8) {
                        Button(testing ? "测试中..." : "测试连接") { test() }
                            .disabled(testing || !hasSaved)
                        if let msg = testMsg {
                            Text(msg.text)
                                .font(.caption)
                                .foregroundStyle(msg.ok ? Color.green : Color.red)
                                .lineLimit(2)
                        }
                    }
                }
            }
        )
        .onAppear {
            let cfg = AppConfigStore.load().kingsoftDocs
            appId = cfg?.appId ?? ""
            appSecret = cfg?.appSecret ?? ""
            loaded = true
        }
        .onChange(of: appId) { _, _ in if loaded { persist() } }
        .onChange(of: appSecret) { _, _ in if loaded { persist() } }
    }
}

// MARK: - AI 模型管理（模型列表 + 测试连接 + 默认模型，对齐 ModelsSection）

private struct ModelsSection: View {
    @State private var models: [AIModelConfig] = []
    @State private var defaultId = ""
    @State private var loaded = false
    @State private var showNew = false
    @State private var editing: AIModelConfig?
    @State private var testingId = ""
    @State private var testMsg: [String: (ok: Bool, text: String)] = [:]
    @State private var deleting: AIModelConfig?

    private func persistModels(_ next: [AIModelConfig], nextDefault: String? = nil) {
        models = next
        let def = nextDefault ?? defaultId
        // 默认模型被删除时自动切换到第一个
        let finalDef = next.contains { $0.id == def } ? def : (next.first?.id ?? "")
        defaultId = finalDef
        var cfg = AppConfigStore.load()
        cfg.aiModels = next
        cfg.aiDefaultModelId = finalDef
        AppConfigStore.save(cfg)
    }

    private func testModel(_ id: String) {
        testingId = id
        testMsg[id] = (true, "测试中...")
        Task {
            let res = await AIVisionService.aiTest(id)
            testMsg[id] = res.ok
                ? (true, "连接成功（\(Int(res.latencyMs ?? 0))ms）")
                : (false, "调用失败：\(res.message)")
            testingId = ""
        }
    }

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("模型列表")
                            .font(.headline)
                        Spacer()
                        Button("＋ 添加模型") { showNew = true }
                    }
                    Text("配置 OpenAI 兼容协议的多模态模型，用于 AI 自动识别走查问题。Key 仅保存在本机配置文件中。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                HStack {
                    if loaded {
                        Text("共 \(models.count) 个模型")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                if loaded && models.isEmpty {
                    Text("还没有模型配置，点击「添加模型」开始")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 6)
                }
                ForEach(models) { m in
                    modelRow(m)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
        }
        .onAppear {
            let cfg = AppConfigStore.load()
            models = cfg.aiModels ?? []
            defaultId = cfg.aiDefaultModelId ?? ""
            loaded = true
        }
        .sheet(isPresented: $showNew) {
            ModelModal { saved in
                persistModels(models + [saved], nextDefault: saved.id)
            }
        }
        .sheet(item: $editing) { initial in
            ModelModal(initial: initial) { saved in
                persistModels(models.map { $0.id == saved.id ? saved : $0 })
            }
        }
        .confirmationDialog(
            "确定删除模型「\(deleting?.name ?? "")」吗？",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button("删除", role: .destructive) {
                if let m = deleting {
                    persistModels(models.filter { $0.id != m.id })
                }
                deleting = nil
            }
            Button("取消", role: .cancel) { deleting = nil }
        }
    }

    private func modelRow(_ m: AIModelConfig) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Text(m.name)
                    .font(.callout)
                    .fontWeight(.medium)
                if m.id == defaultId {
                    badge("默认", background: Color.accentColor.opacity(0.14), foreground: .accentColor)
                }
                if m.vision {
                    badge("图像输入", background: Color.green.opacity(0.14), foreground: .green)
                } else {
                    badge("纯文本", background: Color(nsColor: .quaternaryLabelColor), foreground: .secondary)
                }
                Spacer()
            }
            Text("\(m.model) · \(m.baseUrl)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            if let msg = testMsg[m.id] {
                Text(msg.text)
                    .font(.caption)
                    .foregroundStyle(msg.ok ? Color.green : Color.red)
            }
            HStack(spacing: 10) {
                if m.id != defaultId {
                    Button {
                        persistModels(models, nextDefault: m.id)
                    } label: {
                        Label("设为默认", systemImage: "star")
                    }
                    .controlSize(.small)
                }
                Button {
                    testModel(m.id)
                } label: {
                    if testingId == m.id {
                        HStack(spacing: 4) {
                            ProgressView().controlSize(.mini)
                            Text("测试中...")
                        }
                    } else {
                        Label("测试连接", systemImage: "bolt.horizontal")
                    }
                }
                .controlSize(.small)
                .disabled(testingId == m.id)
                Button("编辑") { editing = m }
                    .controlSize(.small)
                Button("删除", role: .destructive) { deleting = m }
                    .controlSize(.small)
                Spacer()
            }
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(m.id == defaultId ? Color.accentColor.opacity(0.05) : Color(nsColor: .controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(m.id == defaultId ? Color.accentColor.opacity(0.4) : Color(nsColor: .separatorColor))
        )
    }

    private func badge(_ text: String, background: Color, foreground: Color) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(foreground)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(background))
    }
}

// MARK: - 新增 / 编辑模型弹窗（对齐 ModelModal：预设 chips + 四字段 + vision 勾选）

private struct ModelModal: View {
    /// 传入 initial 为编辑模式
    var initial: AIModelConfig?
    let onSave: (AIModelConfig) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var preset = "custom"
    @State private var name = ""
    @State private var baseUrl = ""
    @State private var apiKey = ""
    @State private var model = ""
    @State private var vision = true

    /// 快捷模板（OpenAI 兼容协议，对齐 Settings.tsx PRESETS）
    private static let presets: [(key: String, label: String, baseUrl: String, model: String)] = [
        ("custom", "自定义", "", ""),
        ("deepseek", "DeepSeek", "https://api.deepseek.com/v1", "deepseek-vl2"),
        ("qwen", "通义千问", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-vl-max"),
        ("zhipu", "智谱 GLM", "https://open.bigmodel.cn/api/paas/v4", "glm-4v-plus"),
        ("openai", "OpenAI", "https://api.openai.com/v1", "gpt-4o")
    ]

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
            && !baseUrl.trimmingCharacters(in: .whitespaces).isEmpty
            && !apiKey.trimmingCharacters(in: .whitespaces).isEmpty
            && !model.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(initial == nil ? "添加模型" : "编辑模型")
                .font(.headline)

            Text("快捷模板（OpenAI 兼容协议）")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                ForEach(Self.presets, id: \.key) { p in
                    Button {
                        applyPreset(p.key)
                    } label: {
                        Text(p.label)
                            .font(.caption)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(
                                Capsule().fill(preset == p.key ? Color.accentColor.opacity(0.16) : Color(nsColor: .controlBackgroundColor))
                            )
                            .overlay(
                                Capsule().strokeBorder(preset == p.key ? Color.accentColor : Color(nsColor: .separatorColor))
                            )
                    }
                    .buttonStyle(.plain)
                }
            }

            fieldLabel("名称")
            TextField("如：DeepSeek 视觉", text: $name)
                .textFieldStyle(.roundedBorder)

            fieldLabel("Base URL")
            TextField("如：https://api.deepseek.com/v1", text: $baseUrl)
                .textFieldStyle(.roundedBorder)

            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    fieldLabel("模型 ID")
                    TextField("如：gpt-4o", text: $model)
                        .textFieldStyle(.roundedBorder)
                }
                VStack(alignment: .leading, spacing: 4) {
                    fieldLabel("API Key")
                    SecureField("sk-...", text: $apiKey)
                        .textFieldStyle(.roundedBorder)
                }
            }

            Toggle("支持图像输入（走查识别必须勾选多模态模型）", isOn: $vision)
                .font(.callout)

            HStack {
                Spacer()
                Button("取消") { dismiss() }
                Button("保存") {
                    guard canSave else { return }
                    var trimmedUrl = baseUrl.trimmingCharacters(in: .whitespaces)
                    while trimmedUrl.hasSuffix("/") { trimmedUrl.removeLast() }
                    onSave(AIModelConfig(
                        id: initial?.id ?? genId(),
                        name: name.trimmingCharacters(in: .whitespaces),
                        baseUrl: trimmedUrl,
                        apiKey: apiKey.trimmingCharacters(in: .whitespaces),
                        model: model.trimmingCharacters(in: .whitespaces),
                        vision: vision,
                        createdAt: initial?.createdAt ?? nowMs()
                    ))
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canSave)
            }
        }
        .padding(18)
        .frame(width: 480)
        .onAppear {
            if let initial {
                name = initial.name
                baseUrl = initial.baseUrl
                apiKey = initial.apiKey
                model = initial.model
                vision = initial.vision
            }
        }
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    /// 应用预设：填充 Base URL / 模型名；名称为空时带上预设名（对齐 applyPreset）
    private func applyPreset(_ key: String) {
        preset = key
        guard let p = Self.presets.first(where: { $0.key == key }), !p.baseUrl.isEmpty else { return }
        baseUrl = p.baseUrl
        model = p.model
        if name.isEmpty { name = p.label }
        vision = true
    }
}

#Preview {
    SettingsView()
}
