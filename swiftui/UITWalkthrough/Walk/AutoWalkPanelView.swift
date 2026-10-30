import SwiftData
import SwiftUI

/// 自动走查面板（对齐 Electron AutoWalkPanel）：
/// 连接表单 + 状态消息 + 双图结果区（层/分类筛选 + 缩放 + 标注 overlay）。
/// 程序轨（规范 Token 校验 / 元素清单 / a11y / 结构化比对）经 EngineBridge 调 Node 引擎完成；
/// AI 视觉走查轨在 m7 接入。
/// 双图并排独立滚动不做同步滚动（Electron 版结果区同样为各自滚动）。
struct AutoWalkPanelView: View {
    let page: WalkthroughPage
    /// 页内 imgSet == walk 的标注（父级 modeIssues 口径）
    let walkIssues: [Issue]
    /// 全局问题编号（父级 modeIssues 按 createdAt 升序 idx+1）
    let numbers: [String: Int]

    @Environment(\.modelContext) private var context
    @State private var model: AutoWalkModel?
    @State private var customChecksOpen = false
    @State private var rewalkConfirmOpen = false
    @State private var editingIssue: Issue?
    @State private var zoom: Double = 1

    // MARK: - 派生数据

    /// 层筛选 + 分类筛选后的标注
    private var filteredIssues: [Issue] {
        guard let model else { return [] }
        return walkIssues.filter { issue in
            model.layerFilter.matches(issue) && (model.catFilter == nil || issue.category == model.catFilter)
        }
    }

    private var designIssues: [Issue] {
        filteredIssues.filter { $0.targetImage == .design && rendersOnCanvas($0) }
    }

    private var shotIssues: [Issue] {
        filteredIssues.filter { $0.targetImage == .screenshot && rendersOnCanvas($0) }
    }

    /// 该标注是否带坐标信息、需要渲染到图上
    private func rendersOnCanvas(_ issue: Issue) -> Bool {
        switch issue.displayShape {
        case .point, .text, .measure, .picker:
            true
        case .rect, .arrow:
            issue.width != 0 || issue.height != 0
        }
    }

    /// 统计文案：AI 视觉 n · 程序校验 m
    private var statsText: String {
        let visual = walkIssues.filter { $0.source == .visual }.count
        let program = walkIssues.filter {
            $0.source == .structured || $0.source == .spec || $0.source == .element || $0.source == .a11y
        }.count
        return "AI 视觉 \(visual) · 程序校验 \(program)"
    }

    private var hasWalkImages: Bool {
        !(page.walkDesignPath ?? "").isEmpty && !(page.walkShotPath ?? "").isEmpty
    }

    // MARK: - AI 识别后台任务（跨页面运行，切页返回时恢复状态）

    /// 本页 AI 任务列表
    private var pageAiTasks: [AiTask] {
        AiTaskStore.shared.tasks.filter { $0.pageId == page.id }
    }

    /// 本页是否有进行中的 AI 识别任务
    private var aiTaskRunning: Bool {
        pageAiTasks.contains { $0.status == .running }
    }

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            controlsCard
            if let model, let msg = model.msg {
                messageStrip(msg)
            }
            if hasWalkImages {
                resultsArea
            } else {
                emptyState
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .task(id: page.id) {
            // 页面切换：不同页面重建模型；同一页面（含后台走查中切回）保留运行态
            if model?.pageID != page.id {
                model = AutoWalkModel(page: page)
                zoom = 1
            }
        }
        .sheet(isPresented: $customChecksOpen, onDismiss: { model?.persistConfig() }) {
            if let model {
                WalkCheckOptionsSheet(model: model)
            }
        }
        .sheet(item: $editingIssue) { issue in
            IssueEditorSheet(
                mode: .edit(issue),
                onSave: { fields in
                    updateIssue(issue, fields: fields)
                },
                onDelete: {
                    context.delete(issue)
                    touchPage()
                    editingIssue = nil
                }
            )
        }
        .confirmationDialog(
            "重新走查将替换上次自动走查采集的双图（不影响手动上传的设计稿与开发截图），并新增比对问题。继续吗？",
            isPresented: $rewalkConfirmOpen,
            titleVisibility: .visible
        ) {
            Button("重新走查", role: .destructive) {
                if let model {
                    Task { await model.startWalk(context: context, page: page) }
                }
            }
            Button("取消", role: .cancel) {}
        }
        .onChange(of: AiTaskStore.shared.tasks) { _, tasks in
            // AI 识别后台任务：切页后返回时恢复结果提示，展示后即清理（对齐 Electron useEffect）
            let finished = tasks.filter { $0.pageId == page.id && $0.status != .running }
            guard !finished.isEmpty, let model else { return }
            if let last = finished.last {
                model.msg = WalkMessage(ok: finished.allSatisfy { $0.status == .done }, text: last.message)
            }
            AiTaskStore.shared.clear(finished.map(\.id))
        }
    }

    // MARK: - 连接表单 + 操作区

    @ViewBuilder
    private var controlsCard: some View {
        GroupBox {
            if let model {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Text("Figma 连接")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(width: 76, alignment: .leading)
                        TextField("粘贴 Figma Frame 链接（选中 Frame → 右键 Copy link）", text: Binding(
                            get: { model.figUrlInput },
                            set: { model.figUrlInput = $0 }
                        ))
                        .textFieldStyle(.roundedBorder)
                    }
                    HStack(spacing: 8) {
                        Text("开发页面 URL")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(width: 76, alignment: .leading)
                        TextField("http://localhost:3000/login（内网页面请先登录再采集）", text: Binding(
                            get: { model.devUrlInput },
                            set: { model.devUrlInput = $0 }
                        ))
                        .textFieldStyle(.roundedBorder)
                    }
                    HStack(spacing: 10) {
                        Button("自定义检查项") { customChecksOpen = true }
                            .controlSize(.small)
                        Text(statsText)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Toggle("高级调试", isOn: Binding(
                            get: { model.advancedDebug },
                            set: {
                                model.advancedDebug = $0
                                model.persistConfig()
                            }
                        ))
                        .toggleStyle(.checkbox)
                        .font(.caption)
                        if model.advancedDebug {
                            Button("运行结构化比对") {
                                Task { await model.runStructured(context: context, page: page) }
                            }
                            .controlSize(.small)
                            .disabled(model.running || model.waiting || aiTaskRunning)
                        }
                        startButton(model)
                    }
                    if model.waiting {
                        HStack(spacing: 10) {
                            ProgressView()
                                .controlSize(.small)
                            Text("等待采集结果中...")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Button("取消等待") { model.cancelWait() }
                                .controlSize(.small)
                        }
                    }
                    if aiTaskRunning, let runningTask = pageAiTasks.first(where: { $0.status == .running }) {
                        HStack(spacing: 10) {
                            ProgressView()
                                .controlSize(.small)
                            Text("AI 识别任务进行中（可切换其他页面，任务后台运行）...")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(runningTask.message)
                                .font(.caption)
                                .monospacedDigit()
                            Spacer()
                            Button("中断任务") { AiTaskStore.shared.interrupt(runningTask.id) }
                                .controlSize(.small)
                        }
                    }
                }
                .padding(.vertical, 4)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 6)
    }

    @ViewBuilder
    private func startButton(_ model: AutoWalkModel) -> some View {
        if hasWalkImages {
            Button("重新走查") { rewalkConfirmOpen = true }
                .controlSize(.small)
                .disabled(model.running || model.waiting || aiTaskRunning)
        } else {
            Button {
                Task { await model.startWalk(context: context, page: page) }
            } label: {
                if model.running { ProgressView().controlSize(.small) } else { Text("开始走查") }
            }
            .controlSize(.small)
            .disabled(model.running || model.waiting || aiTaskRunning)
        }
    }

    private func messageStrip(_ msg: WalkMessage) -> some View {
        Text(msg.text)
            .font(.callout)
            .foregroundStyle(msg.ok ? Color.green : Color.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 4)
    }

    // MARK: - 结果区

    private var resultsArea: some View {
        VStack(spacing: 0) {
            filterBar
            Divider()
            HStack(spacing: 0) {
                resultPanel(
                    title: "设计稿（Figma 自动采集）",
                    path: page.walkDesignPath,
                    target: .design,
                    issues: designIssues
                )
                Divider()
                resultPanel(
                    title: "开发截图（自动采集）",
                    path: page.walkShotPath,
                    target: .screenshot,
                    issues: shotIssues
                )
            }
            Divider()
            Text("结果仅展示在自动走查 tab，与手动标注相互隔离；点击标注可编辑状态与内容，报告导出时自动合并两种来源。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
        }
        .frame(maxHeight: .infinity)
    }

    /// 筛选条：层 chips + 分类 + 缩放
    private var filterBar: some View {
        HStack(spacing: 8) {
            if let model {
                ForEach(WalkLayerFilter.allCases) { layer in
                    let count = layer.count(in: walkIssues)
                    Button {
                        model.layerFilter = layer
                    } label: {
                        Text("\(layer.label) \(count)")
                            .font(.caption)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(
                                Capsule().fill(
                                    model.layerFilter == layer ? Color.accentColor.opacity(0.16) : Color(nsColor: .controlBackgroundColor)
                                )
                            )
                            .overlay(
                                Capsule().strokeBorder(
                                    model.layerFilter == layer ? Color.accentColor : Color(nsColor: .separatorColor)
                                )
                            )
                    }
                    .buttonStyle(.plain)
                }
                Picker("类型", selection: Binding(
                    get: { model.catFilter },
                    set: { model.catFilter = $0 }
                )) {
                    Text("全部类型").tag(IssueCategory?.none)
                    ForEach(IssueCategory.allCases) { cat in
                        Text(cat.label).tag(IssueCategory?.some(cat))
                    }
                }
                .controlSize(.small)
                .frame(width: 130)
            }
            Spacer()
            HStack(spacing: 6) {
                Text("缩放")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Slider(value: $zoom, in: 0.5...3, step: 0.05)
                    .frame(width: 120)
                Text("\(Int((zoom * 100).rounded()))%")
                    .font(.caption)
                    .monospacedDigit()
                    .frame(width: 40, alignment: .leading)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    /// 单侧结果图面板：标题 + 独立滚动画布 + 标注 overlay
    private func resultPanel(title: String, path: String?, target: TargetImage, issues: [Issue]) -> some View {
        VStack(spacing: 0) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 5)
            Divider()
            if let image = ImageStore.image(of: path) {
                GeometryReader { geo in
                    let displayW = max(240, geo.size.width - 2) * zoom
                    let aspect = image.size.height / max(image.size.width, 1)
                    ScrollView([.horizontal, .vertical]) {
                        ZStack(alignment: .topLeading) {
                            Image(nsImage: image)
                                .resizable()
                                .frame(width: displayW, height: displayW * aspect)
                            annotationOverlay(issues: issues, width: displayW, height: displayW * aspect)
                        }
                        .frame(minWidth: geo.size.width, minHeight: geo.size.height, alignment: .topLeading)
                    }
                }
            } else {
                ContentUnavailableView("图片加载失败", systemImage: "photo.badge.exclamationmark")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// 标注 overlay：严重度色框 + 全局序号；结构化色值差异渲染为小色块（picker）
    private func annotationOverlay(issues: [Issue], width: CGFloat, height: CGFloat) -> some View {
        ForEach(issues) { issue in
            let color = colorFromHex(issue.displayColorHex) ?? .red
            let rect = CGRect(
                x: issue.x * width,
                y: issue.y * height,
                width: issue.width * width,
                height: issue.height * height
            )
            Group {
                if issue.displayShape == .picker {
                    // 色值标注：实心小色块 + 序号
                    VStack(spacing: 2) {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(color)
                            .frame(width: 14, height: 14)
                            .overlay(Circle().strokeBorder(.white, lineWidth: 1))
                        numberBadge(issue, color: color)
                    }
                    .offset(x: rect.midX - 8, y: rect.midY - 10)
                } else {
                    // 框选标注：严重度色框 + 左上角序号
                    RoundedRectangle(cornerRadius: 2)
                        .strokeBorder(color, lineWidth: 2)
                        .background(RoundedRectangle(cornerRadius: 2).fill(color.opacity(0.06)))
                        .frame(width: max(rect.width, 4), height: max(rect.height, 4))
                        .offset(x: rect.minX, y: rect.minY)
                        .overlay(alignment: .topLeading) {
                            numberBadge(issue, color: color)
                                .offset(x: -9, y: -9)
                        }
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { editingIssue = issue }
            .help(issue.issueDescription)
        }
    }

    private func numberBadge(_ issue: Issue, color: Color) -> some View {
        Text("\(numbers[issue.id] ?? 0)")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(.white)
            .padding(3)
            .background(Circle().fill(color))
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("还没有开始走查", systemImage: "wand.and.stars")
        } description: {
            Text("输入页面 URL 后，将自动采集页面并进行设计规范检测；支持整页截图与视口匹配，快速生成走查报告")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - 标注编辑

    /// 编辑保存（直写库；自动走查标注不入撤销历史，与 Electron 一致）
    private func updateIssue(_ issue: Issue, fields: IssueEditorFields) {
        issue.issueDescription = fields.issueDescription
        issue.severity = fields.severity
        issue.category = fields.category
        issue.status = fields.status
        issue.targetImage = fields.targetImage
        issue.color = fields.color
        issue.measureValue = fields.measureValue
        if issue.isAISuggested == true && issue.aiConfirmed != true {
            issue.aiConfirmed = true
        }
        touchPage()
    }

    private func touchPage() {
        page.updatedAt = nowMs()
        try? context.save()
    }
}

// MARK: - 自定义检查项弹窗（对齐 Electron 自定义检查项：a11y 开关 + 检查深度 + 六项容差）
//
// 检查维度 / 分析设置 / 输出风格注入 AI 视觉走查 prompt（AIVisionService.walkOptionsPrompt）。

struct WalkCheckOptionsSheet: View {
    @Bindable var model: AutoWalkModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("自定义检查项")
                    .font(.headline)
                Text("配置自动走查与 AI 视觉比对的检查范围与输出方式，保存后对本项目后续走查生效。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text("检查维度")
                .font(.callout)
                .fontWeight(.medium)
            chipGroup(
                WalkCatalog.dimensions,
                selection: Binding(
                    get: { model.checkOptions.dimensions },
                    set: { model.checkOptions.dimensions = $0 }
                )
            )

            Text("检查深度")
                .font(.callout)
                .fontWeight(.medium)
            Picker("检查深度", selection: $model.checkOptions.depth) {
                ForEach(WalkDepth.allCases, id: \.self) { depth in
                    Text(depth.label).tag(depth)
                }
            }
            .pickerStyle(.segmented)
            Text("深度影响 AI 视觉走查的检查精细度；高级调试的结构化比对仅在严格模式下标注宽高与内边距 / 间距类尺寸问题。")
                .font(.caption)
                .foregroundStyle(.secondary)

            Text("AI 分析设置")
                .font(.callout)
                .fontWeight(.medium)
            chipGroup(
                WalkCatalog.analyses,
                selection: Binding(
                    get: { model.checkOptions.analysis },
                    set: { model.checkOptions.analysis = $0 }
                )
            )

            Text("输出风格")
                .font(.callout)
                .fontWeight(.medium)
            Picker("输出风格", selection: $model.checkOptions.style) {
                ForEach(WalkOutputStyle.allCases, id: \.self) { style in
                    Text(style.label).tag(style)
                }
            }
            .pickerStyle(.segmented)

            Divider()
            Toggle("启用无障碍检查", isOn: $model.checkOptions.a11y)
                .font(.callout)
            Text("检查图片缺 alt、文字对比度过低、字号过小、点击区域过小、表单控件缺标签，默认关闭，按需开启。")
                .font(.caption)
                .foregroundStyle(.secondary)

            Divider()
            Text("结构化比对容差（px / ΔE，超出阈值才报差异）")
                .font(.caption)
                .foregroundStyle(.secondary)
            toleranceGrid

            HStack {
                Spacer()
                Button("完成") { dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.checkOptions.dimensions.isEmpty || model.checkOptions.analysis.isEmpty)
            }
        }
        .padding(16)
        .frame(width: 460)
    }

    /// 多选 chips（对齐 CheckChips：选中高亮，AI prompt 注入用 WalkCatalog 原 label）
    private func chipGroup(_ options: [WalkCatalog.Dimension], selection: Binding<[String]>) -> some View {
        FlowChips(options: options.map { .init(key: $0.key, label: $0.label) }, selection: selection)
    }

    private func chipGroup(_ options: [WalkCatalog.Analysis], selection: Binding<[String]>) -> some View {
        FlowChips(options: options.map { .init(key: $0.key, label: $0.label) }, selection: selection)
    }

    private var toleranceGrid: some View {
        Grid(horizontalSpacing: 12, verticalSpacing: 8) {
            GridRow {
                toleranceField("尺寸", \.size)
                toleranceField("文字排版", \.typography)
            }
            GridRow {
                toleranceField("间距", \.spacing)
                toleranceField("圆角", \.radius)
            }
            GridRow {
                toleranceField("色差 ΔE", \.color)
                toleranceField("描边", \.border)
            }
        }
    }

    private func toleranceField(_ label: String, _ keyPath: WritableKeyPath<ToleranceConfig, Double>) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.caption)
                .frame(width: 56, alignment: .leading)
            TextField("0", value: Binding(
                get: { model.tolerance[keyPath: keyPath] },
                set: {
                    model.tolerance[keyPath: keyPath] = $0.isFinite && $0 >= 0 ? $0 : 0
                }
            ), format: .number.precision(.fractionLength(0...2)))
            .textFieldStyle(.roundedBorder)
            .frame(width: 72)
        }
    }
}

/// 多选标签组（对齐 Electron CheckChips：点击切换选中，胶囊高亮）
struct FlowChips: View {
    struct Option: Identifiable {
        let key: String
        let label: String
        var id: String { key }
    }

    let options: [Option]
    @Binding var selection: [String]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), alignment: .leading)], alignment: .leading, spacing: 6) {
            ForEach(options) { opt in
                let selected = selection.contains(opt.key)
                Button {
                    if selected {
                        selection.removeAll { $0 == opt.key }
                    } else {
                        selection.append(opt.key)
                    }
                } label: {
                    Text(opt.label)
                        .font(.caption)
                        .lineLimit(1)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            Capsule().fill(selected ? Color.accentColor.opacity(0.16) : Color(nsColor: .controlBackgroundColor))
                        )
                        .overlay(
                            Capsule().strokeBorder(selected ? Color.accentColor : Color(nsColor: .separatorColor))
                        )
                }
                .buttonStyle(.plain)
            }
        }
    }
}
