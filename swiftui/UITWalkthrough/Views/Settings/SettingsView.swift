import SwiftUI

// MARK: - 设置页（对齐 Electron pages/Settings.tsx；m7 落地 AI 模型管理 + 通用音效，m8 补充应用授权）

struct SettingsView: View {
    var body: some View {
        ScrollView {
            VStack(spacing: Spacing.xl) {
                ModelsSection()
                GeneralSection()
                AppAuthSection()
            }
            .padding(Spacing.xlg2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.appBg)
    }
}

// MARK: - 通用（任务完成音效）

private struct GeneralSection: View {
    @State private var soundEnabled = true

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: Spacing.md) {
                Text("通用")
                    .font(.system(size: FontTokens.Size.sectionHeader, weight: .semibold))
                Toggle("任务完成音效", isOn: $soundEnabled)
                    .onChange(of: soundEnabled) {
                        var cfg = AppConfigStore.load()
                        cfg.soundEnabled = soundEnabled
                        AppConfigStore.save(cfg)
                    }
                Text("AI 识别任务完成后播放提示音，关闭后静默")
                    .font(.system(size: FontTokens.Size.captionSmall))
                    .foregroundStyle(Color.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, Spacing.xs)
        }
        .onAppear {
            soundEnabled = AppConfigStore.load().soundEnabled != false
        }
    }
}

// MARK: - 应用授权（飞书 / 腾讯文档 / 金山文档，对齐 Settings.tsx 应用授权区块）

private struct AppAuthSection: View {
    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: Spacing.xlg) {
                FeishuAuthCard()
                Divider()
                TencentAuthCard()
                Divider()
                KingsoftAuthCard()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, Spacing.xs)
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
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack {
                Text(title)
                    .font(.system(size: FontTokens.Size.bodySmall, weight: .semibold))
                Spacer()
                Text(savedLabel)
                    .font(.system(size: FontTokens.Size.captionSmall))
                    .foregroundStyle(Color.textSecondary)
            }
            Text(desc)
                .font(.system(size: FontTokens.Size.captionSmall))
                .foregroundStyle(Color.textSecondary)
            HStack(alignment: .top, spacing: Spacing.mg) {
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
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    AppFieldLabel(text: "App ID")
                    TextField("App ID（cli_xxx）", text: $appId)
                        .appInputStyle()
                        .frame(width: 240)
                }
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    AppFieldLabel(text: "App Secret")
                    SecureField("App Secret", text: $appSecret)
                        .appInputStyle()
                        .frame(width: 240)
                }
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text(" ").font(.system(size: FontTokens.Size.captionSmall)).foregroundStyle(Color.textSecondary)
                    HStack(spacing: Spacing.md) {
                        AppButton(testing ? "测试中..." : "测试连接", icon: nil, style: .secondary, isLoading: testing, isDisabled: testing || !hasSaved) { test() }
                        if let msg = testMsg {
                            Text(msg.text)
                                .font(.system(size: FontTokens.Size.captionSmall))
                                .foregroundStyle(msg.ok ? Color.success : Color.danger)
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
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    AppFieldLabel(text: "应用 ID（client_id）")
                    TextField("应用 ID（client_id）", text: $clientId)
                        .appInputStyle()
                        .frame(width: 200)
                }
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    AppFieldLabel(text: "access_token")
                    SecureField("access_token", text: $accessToken)
                        .appInputStyle()
                        .frame(width: 200)
                }
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    AppFieldLabel(text: "open_id")
                    TextField("open_id", text: $openId)
                        .appInputStyle()
                        .frame(width: 200)
                }
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text(" ").font(.system(size: FontTokens.Size.captionSmall)).foregroundStyle(Color.textSecondary)
                    HStack(spacing: Spacing.md) {
                        AppButton(testing ? "测试中..." : "测试连接", icon: nil, style: .secondary, isLoading: testing, isDisabled: testing || !hasSaved) { test() }
                        if let msg = testMsg {
                            Text(msg.text)
                                .font(.system(size: FontTokens.Size.captionSmall))
                                .foregroundStyle(msg.ok ? Color.success : Color.danger)
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
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    AppFieldLabel(text: "App ID")
                    TextField("App ID", text: $appId)
                        .appInputStyle()
                        .frame(width: 240)
                }
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    AppFieldLabel(text: "App Secret")
                    SecureField("App Secret", text: $appSecret)
                        .appInputStyle()
                        .frame(width: 240)
                }
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text(" ").font(.system(size: FontTokens.Size.captionSmall)).foregroundStyle(Color.textSecondary)
                    HStack(spacing: Spacing.md) {
                        AppButton(testing ? "测试中..." : "测试连接", icon: nil, style: .secondary, isLoading: testing, isDisabled: testing || !hasSaved) { test() }
                        if let msg = testMsg {
                            Text(msg.text)
                                .font(.system(size: FontTokens.Size.captionSmall))
                                .foregroundStyle(msg.ok ? Color.success : Color.danger)
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
        AppCard {
            VStack(alignment: .leading, spacing: Spacing.mg) {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    HStack {
                        Text("模型列表")
                            .font(.system(size: FontTokens.Size.sectionHeader, weight: .semibold))
                        Spacer()
                        AppButton("添加模型", icon: "plus", style: .primary) { showNew = true }
                    }
                    Text("配置 OpenAI 兼容协议的多模态模型，用于 AI 自动识别走查问题。Key 仅保存在本机配置文件中。")
                        .font(.system(size: FontTokens.Size.captionSmall))
                        .foregroundStyle(Color.textSecondary)
                }
                HStack {
                    if loaded {
                        Text("共 \(models.count) 个模型")
                            .font(.system(size: FontTokens.Size.captionSmall))
                            .foregroundStyle(Color.textSecondary)
                    }
                    Spacer()
                }
                if loaded && models.isEmpty {
                    Text("还没有模型配置，点击「添加模型」开始")
                        .font(.system(size: FontTokens.Size.bodySmall))
                        .foregroundStyle(Color.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, Spacing.sm)
                }
                ForEach(models) { m in
                    modelRow(m)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, Spacing.xs)
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
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(spacing: Spacing.xs) {
                Text(m.name)
                    .font(.system(size: FontTokens.Size.bodySmall))
                    .fontWeight(.medium)
                if m.id == defaultId {
                    badge("默认", background: Color.primary.opacity(0.14), foreground: Color.primary)
                }
                if m.vision {
                    badge("图像输入", background: Color.success.opacity(0.14), foreground: Color.success)
                } else {
                    badge("纯文本", background: Color.fill, foreground: Color.textSecondary)
                }
                Spacer()
            }
            Text("\(m.model) · \(m.baseUrl)")
                .font(.system(size: FontTokens.Size.captionSmall))
                .foregroundStyle(Color.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
            if let msg = testMsg[m.id] {
                Text(msg.text)
                    .font(.system(size: FontTokens.Size.captionSmall))
                    .foregroundStyle(msg.ok ? Color.success : Color.danger)
            }
            HStack(spacing: Spacing.lg) {
                if m.id != defaultId {
                    AppButton("设为默认", icon: "star", style: .text) {
                        persistModels(models, nextDefault: m.id)
                    }
                }
                AppButton(
                    testingId == m.id ? "测试中..." : "测试连接",
                    icon: testingId == m.id ? nil : "bolt.horizontal",
                    style: .text,
                    isLoading: testingId == m.id,
                    isDisabled: testingId == m.id
                ) {
                    testModel(m.id)
                }
                AppButton("编辑", style: .text) { editing = m }
                AppButton("删除", style: .destructive) { deleting = m }
                Spacer()
            }
        }
        .padding(SizeTokens.cardPaddingCompact)
        .background(
            RoundedRectangle(cornerRadius: Radius.sm)
                .fill(m.id == defaultId ? Color.primary.opacity(0.05) : Color.cardBg)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Radius.sm)
                .strokeBorder(m.id == defaultId ? Color.primary.opacity(0.4) : Color.border)
        )
    }

    private func badge(_ text: String, background: Color, foreground: Color) -> some View {
        Text(text)
            .font(.system(size: FontTokens.Size.caption))
            .foregroundStyle(foreground)
            .padding(.horizontal, Spacing.sm)
            .padding(.vertical, Spacing.xxs)
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
        VStack(alignment: .leading, spacing: Spacing.mg) {
            Text(initial == nil ? "添加模型" : "编辑模型")
                .font(.system(size: FontTokens.Size.sectionHeader, weight: .semibold))

            Text("快捷模板（OpenAI 兼容协议）")
                .font(.system(size: FontTokens.Size.captionSmall))
                .foregroundStyle(Color.textSecondary)
            HStack(spacing: Spacing.sm) {
                ForEach(Self.presets, id: \.key) { p in
                    Button {
                        applyPreset(p.key)
                    } label: {
                        Text(p.label)
                            .font(.system(size: FontTokens.Size.captionSmall))
                            .padding(.horizontal, Spacing.mg)
                            .padding(.vertical, Spacing.xs)
                            .foregroundStyle(preset == p.key ? Color.primary : Color.textSecondary)
                            .background(
                                Capsule().fill(preset == p.key ? Color.primarySoft : Color.cardBg)
                            )
                            .overlay(
                                Capsule().strokeBorder(preset == p.key ? Color.primary : Color.border)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }

            AppFieldLabel(text: "名称")
            TextField("如：DeepSeek 视觉", text: $name)
                .appInputStyle()

            AppFieldLabel(text: "Base URL")
            TextField("如：https://api.deepseek.com/v1", text: $baseUrl)
                .appInputStyle()

            HStack(alignment: .top, spacing: Spacing.xlg) {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    AppFieldLabel(text: "模型 ID")
                    TextField("如：gpt-4o", text: $model)
                        .appInputStyle()
                }
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    AppFieldLabel(text: "API Key")
                    SecureField("sk-...", text: $apiKey)
                        .appInputStyle()
                }
            }

            Toggle("支持图像输入（走查识别必须勾选多模态模型）", isOn: $vision)
                .font(.system(size: FontTokens.Size.bodySmall))

            HStack {
                Spacer()
                AppButton("取消", style: .secondary) { dismiss() }
                AppButton("保存", style: .primary, isDisabled: !canSave) {
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
            }
        }
        .padding(Spacing.xxl)
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

// MARK: - SecureField 扩展：应用 AppInput 样式

extension View {
    /// 为 SecureField / TextField 添加 AppInput 一致的样式（padding + border + focus ring）
    @ViewBuilder
    func appInputStyle() -> some View {
        self
            .font(.system(size: FontTokens.Size.bodySmall))
            .padding(.horizontal, SizeTokens.inputPaddingH)
            .padding(.vertical, SizeTokens.inputPaddingV)
            .background(Color.cardBg, in: RoundedRectangle(cornerRadius: Radius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.sm)
                    .strokeBorder(Color.inputBorder, lineWidth: 1)
            )
    }
}

#Preview {
    SettingsView()
}
