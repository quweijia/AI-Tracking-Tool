import SwiftData
import SwiftUI

/// 抽屉快捷添加载荷（对齐 IssueDrawer `onAdd` 字段）
struct DrawerQuickAdd {
    var issueDescription: String
    var severity: Severity
    var category: IssueCategory
    var targetImage: TargetImage
}

/// 状态筛选 tab（对齐 DrawerFilter：全部 / 待处理 / 已解决）
private enum DrawerFilter: String, CaseIterable, Identifiable {
    case all, open, done

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: "全部"
        case .open: "待处理"
        case .done: "已解决"
        }
    }
}

/// 来源筛选 tab（旧数据缺省 source 视为手动）
private enum DrawerSourceFilter: String, CaseIterable, Identifiable {
    case all, visual, spec, element, a11y, structured, manual

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: "全部来源"
        case .visual: "视觉"
        case .spec: "规范"
        case .element: "元素"
        case .a11y: "无障碍"
        case .structured: "结构化"
        case .manual: "手动"
        }
    }

    /// 清除弹窗完整文案（对齐 source*Full）
    var fullLabel: String {
        switch self {
        case .structured: "结构化分析"
        case .visual: "视觉比对（AI 识别）"
        case .spec: "设计规范校验"
        case .element: "元素清单一致性校验"
        case .a11y: "无障碍检查"
        case .manual: "手动标注"
        case .all: "全部来源"
        }
    }
}

/// 待确认动作（删除单条 / 忽略 AI 候选，二次确认）
private enum DrawerPendingAction: Identifiable {
    case deleteOne(Issue)
    case ignoreCandidate(Issue)

    var id: String {
        switch self {
        case .deleteOne(let i): "del-\(i.id)"
        case .ignoreCandidate(let i): "ign-\(i.id)"
        }
    }

    var title: String {
        switch self {
        case .deleteOne: "删除标注"
        case .ignoreCandidate: "忽略 AI 候选"
        }
    }

    var message: String {
        switch self {
        case .deleteOne(let issue):
            let short = issue.issueDescription.count > 24
                ? String(issue.issueDescription.prefix(24)) + "…"
                : issue.issueDescription
            return "确定删除标注「\(short)」吗？删除后不可恢复。"
        case .ignoreCandidate:
            return "确定忽略这条 AI 候选标注吗？"
        }
    }
}

/// 对比页右侧问题标注面板（对齐 IssueDrawer.tsx）：
/// 状态/来源筛选、快捷添加表单、按分类分组折叠、AI 候选采纳/忽略、复验入口、按类型清除。
/// 状态变更 / 删除等直接写库（对齐 Electron 抽屉直写 db，不入撤销历史）。
struct IssueDrawerPanel: View {
    let issues: [Issue]
    var onHighlight: (Issue) -> Void
    var onEdit: (Issue) -> Void
    var onReverify: (Issue) -> Void
    /// 快捷添加（自动走查模式不提供）
    var onAdd: ((DrawerQuickAdd) -> Void)? = nil
    var onClose: () -> Void
    /// 触碰页面（updatedAt + save）
    var touchPage: (String) -> Void

    @Environment(\.modelContext) private var context

    @State private var filter: DrawerFilter = .all
    @State private var sourceFilter: DrawerSourceFilter = .all
    @State private var showAdd = false
    @State private var addDesc = ""
    @State private var addSeverity: Severity = .minor
    @State private var addCategory: IssueCategory = .spacing
    @State private var addTarget: TargetImage = .screenshot
    @State private var collapsed: Set<IssueCategory> = []
    @State private var clearOpen = false
    @State private var clearSelection: Set<String> = []
    @State private var pendingAction: DrawerPendingAction?

    private var trimmedAdd: String { addDesc.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// 已解决口径（对齐 DONE_STATUSES）
    private var isDone: (Issue) -> Bool { { $0.status.isResolved } }

    // MARK: - 数据派生

    /// 展示来源（旧数据缺省视为手动）
    private func displaySource(_ issue: Issue) -> IssueSource { issue.source ?? .manual }

    private var sortedNumbered: [(issue: Issue, no: Int)] {
        issues
            .sorted { $0.createdAt < $1.createdAt }
            .enumerated()
            .map { idx, issue in (issue, idx + 1) }
    }

    private var filtered: [(issue: Issue, no: Int)] {
        sortedNumbered.filter { entry in
            let matched = switch filter {
            case .open: !isDone(entry.issue)
            case .done: isDone(entry.issue)
            case .all: true
            }
            return matched && (sourceFilter == .all || displaySource(entry.issue) == IssueSource(rawValue: sourceFilter.rawValue))
        }
    }

    /// 按分类分组（编号保持全列表连续），只出现有标注的分类组
    private var groups: [(cat: IssueCategory, items: [(issue: Issue, no: Int)])] {
        IssueCategory.allCases
            .map { cat in (cat, filtered.filter { $0.issue.category == cat }) }
            .filter { !$0.items.isEmpty }
    }

    /// 本页实际出现的来源与分类（清除弹窗只列出这些）
    private var presentSources: [IssueSource] {
        Array(Set(issues.map(displaySource))).sorted { $0.rawValue < $1.rawValue }
    }

    private var presentCats: [IssueCategory] {
        IssueCategory.allCases.filter { cat in issues.contains { $0.category == cat } }
    }

    /// 当前勾选命中的待清除标注（来源或分类任一命中即算）
    private var clearTargets: [Issue] {
        issues.filter {
            clearSelection.contains("src:\(displaySource($0).rawValue)") || clearSelection.contains("cat:\($0.category.rawValue)")
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            filterTabs
            sourceTabs
            if showAdd, onAdd != nil {
                addForm
                Divider()
            }
            list
        }
        .frame(width: 300)
        .background(Color(nsColor: .controlBackgroundColor))
        .alert(
            pendingAction?.title ?? "",
            isPresented: Binding(
                get: { pendingAction != nil },
                set: { if !$0 { pendingAction = nil } }
            ),
            presenting: pendingAction
        ) { action in
            Button("删除", role: .destructive) {
                switch action {
                case .deleteOne(let issue): deleteOne(issue)
                case .ignoreCandidate(let issue): ignoreCandidate(issue)
                }
            }
            Button("取消", role: .cancel) {}
        } message: { action in
            Text(action.message)
        }
        .sheet(isPresented: $clearOpen) {
            clearSheet
        }
    }

    // MARK: - 头部 / 筛选

    private var header: some View {
        HStack(spacing: 8) {
            Text("标注")
                .font(.headline)
            Text("\(filtered.count)")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(Capsule().fill(Color.secondary.opacity(0.15)))
                .foregroundStyle(.secondary)
            Spacer()
            Button("清除") {
                clearSelection = []
                clearOpen = true
            }
            .disabled(issues.isEmpty)
            .help("按类型清除标注")
            if onAdd != nil {
                Button(showAdd ? "收起表单" : "添加") { showAdd.toggle() }
            }
            Button {
                onClose()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
            }
            .help("收起面板")
        }
        .buttonStyle(.borderless)
        .controlSize(.small)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    private var filterTabs: some View {
        Picker("状态筛选", selection: $filter) {
            ForEach(DrawerFilter.allCases) { f in
                Text(f.label).tag(f)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.small)
        .padding(.horizontal, 10)
    }

    private var sourceTabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(DrawerSourceFilter.allCases) { s in
                    Button {
                        sourceFilter = s
                    } label: {
                        Text(s.label)
                            .font(.caption)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(
                                RoundedRectangle(cornerRadius: 5)
                                    .fill(sourceFilter == s ? Color.accentColor.opacity(0.14) : .clear)
                            )
                            .foregroundStyle(sourceFilter == s ? Color.accentColor : Color.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 10)
        }
        .padding(.vertical, 4)
    }

    // MARK: - 快捷添加表单

    private var addForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("问题描述", text: $addDesc)
                .textFieldStyle(.roundedBorder)
                .onSubmit { submitAdd() }
            HStack(spacing: 6) {
                Picker("分类", selection: $addCategory) {
                    ForEach(IssueCategory.allCases) { c in Text(c.label).tag(c) }
                }
                .labelsHidden()
                Picker("严重度", selection: $addSeverity) {
                    ForEach(Severity.allCases) { s in Text(s.label).tag(s) }
                }
                .labelsHidden()
                Picker("所在图", selection: $addTarget) {
                    ForEach(TargetImage.allCases) { t in Text(t.label).tag(t) }
                }
                .labelsHidden()
            }
            HStack {
                Button("添加") { submitAdd() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(trimmedAdd.isEmpty)
                Button("取消") { showAdd = false }
                    .controlSize(.small)
                Spacer()
            }
            .buttonStyle(.bordered)
        }
        .padding(10)
    }

    private func submitAdd() {
        guard !trimmedAdd.isEmpty, let onAdd else { return }
        onAdd(DrawerQuickAdd(
            issueDescription: trimmedAdd,
            severity: addSeverity,
            category: addCategory,
            targetImage: addTarget
        ))
        addDesc = ""
        showAdd = false
    }

    // MARK: - 列表

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(groups, id: \.cat) { group in
                    groupHeader(group.cat, count: group.items.count)
                    if !collapsed.contains(group.cat) {
                        ForEach(group.items, id: \.issue.id) { entry in
                            itemRow(entry)
                            Divider().padding(.leading, 10)
                        }
                    }
                }
                if filtered.isEmpty {
                    Text(
                        filter == .all && sourceFilter == .all
                            ? "还没有标注，可在图上框选或点击「添加」"
                            : "当前筛选条件下暂无标注"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 32)
                }
            }
        }
    }

    private func groupHeader(_ cat: IssueCategory, count: Int) -> some View {
        Button {
            if collapsed.contains(cat) { collapsed.remove(cat) } else { collapsed.insert(cat) }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .bold))
                    .rotationEffect(.degrees(collapsed.contains(cat) ? -90 : 0))
                Text(cat.label)
                    .font(.system(size: 12, weight: .semibold))
                Text("\(count)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .help(collapsed.contains(cat) ? "展开该分类" : "折叠该分类")
    }

    private func itemRow(_ entry: (issue: Issue, no: Int)) -> some View {
        let issue = entry.issue
        let isCandidate = issue.isAISuggested == true && issue.aiConfirmed != true
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                Text("\(entry.no)")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 18, height: 18)
                    .background(
                        Circle().fill(colorFromHex(SeverityRenderColor.numHex(severity: issue.severity)) ?? .gray)
                    )
                VStack(alignment: .leading, spacing: 4) {
                    Text(issue.issueDescription)
                        .font(.system(size: 12.5))
                        .lineLimit(3)
                    HStack(spacing: 6) {
                        severityBadge(issue.severity)
                        Text(issue.category.label)
                            .font(.system(size: 10.5))
                            .foregroundStyle(.secondary)
                        switch issue.source {
                        case .structured, .visual, .spec:
                            sourceBadge(issue.source!)
                        default:
                            EmptyView()
                        }
                        if issue.isAISuggested == true {
                            Text(isCandidate ? "AI 候选" : "AI")
                                .font(.system(size: 10, weight: .semibold))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(
                                    Capsule().fill(isCandidate ? Color.orange.opacity(0.15) : Color.blue.opacity(0.12))
                                )
                                .foregroundStyle(isCandidate ? Color.orange : Color.blue)
                        }
                    }
                }
                Spacer(minLength: 4)
                if !isCandidate {
                    Menu {
                        ForEach(IssueStatus.allCases) { s in
                            Button(s.label) { updateStatus(issue, s) }
                        }
                    } label: {
                        Label(issue.status.label, systemImage: "chevron.up.chevron.down")
                            .font(.system(size: 10.5))
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.visible)
                    .fixedSize()
                }
            }
            if isCandidate {
                HStack(spacing: 8) {
                    Text("待人工审核，采纳后计入报告")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("采纳") { confirmCandidate(issue) }
                    Button("编辑") { onEdit(issue) }
                        .help("编辑后保存即采纳")
                    Button("忽略") { pendingAction = .ignoreCandidate(issue) }
                }
                .buttonStyle(.borderless)
                .font(.caption)
            } else {
                HStack(spacing: 8) {
                    if issue.fixStatus == .passed {
                        fixBadge(passed: true, count: issue.reverifyCount ?? 0)
                    }
                    if issue.fixStatus == .failed {
                        fixBadge(passed: false, count: issue.reverifyCount ?? 0)
                    }
                    Spacer()
                    Button("复验") { onReverify(issue) }
                    Button("删除") { pendingAction = .deleteOne(issue) }
                        .foregroundStyle(.red)
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(isCandidate ? Color.orange.opacity(0.05) : .clear)
        .contentShape(Rectangle())
        .onTapGesture { onHighlight(issue) }
        .help("点击在标注图上高亮定位该问题")
    }

    // MARK: - 徽标

    private func severityBadge(_ severity: Severity) -> some View {
        Text(severity.label)
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(colorFromHex(severity.colorHex) ?? .gray))
            .foregroundStyle(.white)
    }

    private func sourceBadge(_ source: IssueSource) -> some View {
        let color: Color = switch source {
        case .structured: Color.blue
        case .visual: Color.purple
        case .spec: Color.green
        default: .gray
        }
        return Text(source.label)
            .font(.system(size: 10))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.12)))
            .foregroundStyle(color)
    }

    private func fixBadge(passed: Bool, count: Int) -> some View {
        Text(passed ? "已通过" : (count > 1 ? "未通过 ×\(count)" : "未通过"))
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(passed ? Color.green.opacity(0.14) : Color.red.opacity(0.12)))
            .foregroundStyle(passed ? .green : .red)
    }

    // MARK: - 写库动作（对齐 Electron 抽屉直写 db，不入撤销历史）

    private func updateStatus(_ issue: Issue, _ status: IssueStatus) {
        issue.status = status
        touchPage(issue.pageId)
    }

    private func confirmCandidate(_ issue: Issue) {
        issue.aiConfirmed = true
        touchPage(issue.pageId)
    }

    private func ignoreCandidate(_ issue: Issue) {
        context.delete(issue)
        touchPage(issue.pageId)
    }

    private func deleteOne(_ issue: Issue) {
        context.delete(issue)
        touchPage(issue.pageId)
    }

    // MARK: - 按类型清除弹窗

    private var clearSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("清除标注").font(.headline)
            Text("勾选要清除的标注类型（不选则无法清除），避免误删全部。")
                .font(.caption)
                .foregroundStyle(.secondary)

            if !presentSources.isEmpty {
                Text("按来源").font(.caption).foregroundStyle(.secondary)
                ForEach(presentSources, id: \.rawValue) { s in
                    Toggle(isOn: selectionBinding("src:\(s.rawValue)")) {
                        Text(s.fullLabel).font(.callout)
                    }
                }
            }

            if !presentCats.isEmpty {
                Text("按分类").font(.caption).foregroundStyle(.secondary)
                ForEach(presentCats) { c in
                    Toggle(isOn: selectionBinding("cat:\(c.rawValue)")) {
                        Text(c.label).font(.callout)
                    }
                }
            }

            Text(
                clearSelection.isEmpty
                    ? "请先勾选要清除的类型"
                    : "将清除 \(clearTargets.count) 个标注"
            )
            .font(.caption)
            .foregroundStyle(.secondary)

            HStack {
                Spacer()
                Button("取消") { clearOpen = false }
                Button("清除") { performClear() }
                    .buttonStyle(.borderedProminent)
                    .disabled(clearSelection.isEmpty || clearTargets.isEmpty)
            }
        }
        .padding(16)
        .frame(width: 380)
        .confirmationDialog(
            "确定清除选中的 \(clearTargets.count) 个标注吗？删除后不可恢复。",
            isPresented: Binding(
                get: { clearConfirmOpen },
                set: { clearConfirmOpen = $0 }
            ),
            titleVisibility: .visible
        ) {
            Button("清除", role: .destructive) { reallyClear() }
            Button("取消", role: .cancel) {}
        }
    }

    @State private var clearConfirmOpen = false

    private var displaySourceFallback: IssueSource { .manual }

    private func selectionBinding(_ key: String) -> Binding<Bool> {
        Binding(
            get: { clearSelection.contains(key) },
            set: {
                if $0 { clearSelection.insert(key) } else { clearSelection.remove(key) }
            }
        )
    }

    private func performClear() {
        clearConfirmOpen = true
    }

    private func reallyClear() {
        let targets = clearTargets
        guard !targets.isEmpty else { return }
        for target in targets { context.delete(target) }
        if let pageId = targets.first?.pageId { touchPage(pageId) }
        clearOpen = false
        clearSelection = []
    }
}

/// IssueSource → 清除弹窗完整文案
private extension IssueSource {
    var fullLabel: String {
        switch self {
        case .structured: "结构化分析"
        case .visual: "视觉比对（AI 识别）"
        case .spec: "设计规范校验"
        case .element: "元素清单一致性校验"
        case .a11y: "无障碍检查"
        case .manual: "手动标注"
        }
    }
}

// MARK: - 复验弹窗（对齐 ReverifyModal.tsx）

/// 复验问题：上传修复后截图，与修复前截图滑块对比，判定通过 / 打回。
/// 直接写库（fixStatus / fixNote / verifiedAt / reverifyCount），对齐 Electron 不入撤销历史。
struct ReverifySheet: View {
    let issue: Issue
    /// 页面原开发截图（修复前基准）
    let oldScreenshot: NSImage?
    var onSubmit: (_ passed: Bool, _ fixPath: String?, _ note: String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var fixPath: String?
    @State private var fixImage: NSImage?
    @State private var note = ""
    @State private var slider: Double = 50

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("复验问题").font(.headline)

            HStack(alignment: .top, spacing: 8) {
                Text(issue.severity.label)
                    .font(.system(size: 10, weight: .semibold))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(colorFromHex(issue.severity.colorHex) ?? .gray))
                    .foregroundStyle(.white)
                Text(issue.category.label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(issue.issueDescription)
                    .font(.callout)
                    .lineLimit(2)
                Spacer()
            }

            Button(fixImage == nil ? "选择修复后截图" : "重新选择修复后截图") { pickImage() }
                .controlSize(.small)

            if fixImage != nil {
                compareArea
                if oldScreenshot != nil {
                    Slider(value: $slider, in: 0...100)
                }
            }

            Text("复验备注（可选）")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextEditor(text: $note)
                .font(.body)
                .scrollContentBackground(.hidden)
                .frame(height: 48)
                .padding(6)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(Color(nsColor: .separatorColor))
                )

            HStack {
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("未通过（打回）", role: .destructive) { submit(passed: false) }
                    .help("判定未通过，状态回到「待修复」")
                Button("已修复（通过）") { submit(passed: true) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(fixImage == nil)
                    .help(fixImage == nil ? "需先上传修复后截图" : "判定已修复")
            }
        }
        .padding(16)
        .frame(width: 640)
        .onAppear {
            if let existing = issue.fixScreenshotPath, let img = ImageStore.image(of: existing) {
                fixPath = existing
                fixImage = img
            }
            note = issue.fixNote ?? ""
        }
    }

    private func pickImage() {
        guard let url = ImagePicker.pickImage(),
              let rel = try? ImageStore.importFile(at: url) else { return }
        if let previous = fixPath, previous != rel { ImageStore.delete(previous) }
        fixPath = rel
        fixImage = ImageStore.image(of: rel)
    }

    private func submit(passed: Bool) {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        onSubmit(passed, fixPath, trimmed.isEmpty ? nil : trimmed)
        dismiss()
    }

    /// 修复前 / 后滑块对比（对齐 verify-wrap + clipPath inset）；无修复前图时仅展示修复后
    private var compareArea: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                if let old = oldScreenshot {
                    fittedImage(old, geo: geo.size)
                    if let fix = fixImage {
                        fittedImage(fix, geo: geo.size)
                            .mask(alignment: .leading) {
                                Color.white.frame(width: fittedWidth(geo: geo.size) * (1 - slider / 100))
                            }
                    }
                    // 分割线
                    Rectangle()
                        .fill(Color.white)
                        .frame(width: 2)
                        .shadow(color: .black.opacity(0.35), radius: 1)
                        .position(
                            x: (geo.size.width - fittedWidth(geo: geo.size)) / 2 + fittedWidth(geo: geo.size) * CGFloat(slider) / 100,
                            y: geo.size.height / 2
                        )
                } else if let fix = fixImage {
                    fittedImage(fix, geo: geo.size)
                }
            }
            .overlay(alignment: .bottomLeading) {
                if oldScreenshot != nil { tag("修复前") }
            }
            .overlay(alignment: .bottomTrailing) {
                tag("修复后")
            }
        }
        .frame(height: 260)
        .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
    }

    private func fittedWidth(geo: CGSize) -> CGFloat {
        guard let image = oldScreenshot ?? fixImage,
              image.size.height > 0 else { return geo.width }
        let aspect = image.size.width / image.size.height
        return min(geo.width, geo.height * aspect)
    }

    private func fittedImage(_ image: NSImage, geo: CGSize) -> some View {
        Image(nsImage: image)
            .resizable()
            .scaledToFit()
            .frame(width: geo.width, height: geo.height)
    }

    private func tag(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(Color.black.opacity(0.55)))
            .foregroundStyle(.white)
            .padding(6)
    }
}
