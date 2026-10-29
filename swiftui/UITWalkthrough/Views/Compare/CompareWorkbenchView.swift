import SwiftData
import SwiftUI

/// 工作台模式：手动标注（双图对比）/ 自动走查（Figma 结构化比对）
/// （对齐 CompareWorkbench.tsx `WorkMode`；自动走查面板见 Walk/AutoWalkPanelView）
enum WorkbenchWorkMode: String, CaseIterable, Identifiable {
    case manual
    case auto

    var id: String { rawValue }

    var label: String { self == .manual ? "手动标注" : "自动走查" }
}

/// 对比工作台：顶栏（返回/页面信息/问题清单）+ 聚焦条 + 画布工具条 + 三栏主体 + 底部工具栏
/// （对齐 Electron CompareWorkbench：hero 头部 + focus-bar + workbench-header + compare-body + anno-toolbar）
/// 手动标注的新增/删除/编辑/移动入撤销历史；抽屉内状态变更/采纳/忽略/复验/快捷添加直写库（与 Electron 一致）。
struct CompareWorkbenchView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.modelContext) private var context
    @Query private var allPages: [WalkthroughPage]
    @Query private var allProjects: [Project]
    @Query private var allIssues: [Issue]

    @State private var canvasModel = CompareCanvasModel()
    @State private var workMode: WorkbenchWorkMode = .manual
    @State private var editPageOpen = false

    // 标注交互状态（对齐 Electron CompareWorkbench state）
    @State private var tool: AnnotationTool = .hand
    @State private var drawerOpen = false
    @State private var creating: CreatingDraft?
    @State private var editingIssue: Issue?
    @State private var reverifyIssue: Issue?
    @State private var oldScreenshot: NSImage?
    @State private var flashId: String?
    @State private var flashTask: Task<Void, Never>?
    @State private var focusIssue: Issue?
    @State private var history = AnnotationHistory()

    private var page: WalkthroughPage? {
        allPages.first { $0.id == appState.activePageID }
    }

    private var project: Project? {
        allProjects.first { $0.id == appState.activeProjectID }
    }

    // MARK: - 派生数据

    /// 当前工作模式的页内标注（对齐 issueNos / drawer 过滤口径：手动 imgSet!=='walk'，自动 imgSet==='walk'）
    private var modeIssues: [Issue] {
        guard let page else { return [] }
        return allIssues.filter {
            $0.pageId == page.id && (workMode == .auto ? $0.imgSet == .walk : $0.imgSet != .walk)
        }
    }

    /// 全局编号：modeIssues 按创建时间升序 idx+1（与问题清单一致）
    private var issueNos: [String: Int] {
        var nos: [String: Int] = [:]
        for (idx, issue) in modeIssues.sorted(by: { $0.createdAt < $1.createdAt }).enumerated() {
            nos[issue.id] = idx + 1
        }
        return nos
    }

    /// 该标注是否带坐标信息、需要渲染到图上（列表手加的问题无坐标不渲染）
    private func rendersOnCanvas(_ issue: Issue) -> Bool {
        switch issue.displayShape {
        case .point, .text, .measure, .picker:
            true
        case .rect, .arrow:
            issue.width != 0 || issue.height != 0
        }
    }

    private var designIssues: [Issue] {
        modeIssues.filter { $0.targetImage == .design && rendersOnCanvas($0) }
    }

    private var shotIssues: [Issue] {
        modeIssues.filter { $0.targetImage == .screenshot && rendersOnCanvas($0) }
    }

    /// 聚焦标注中心（归一化）
    private var focusAnchor: CGPoint? {
        guard let focusIssue else { return nil }
        return CGPoint(x: focusIssue.x + focusIssue.width / 2, y: focusIssue.y + focusIssue.height / 2)
    }

    /// 标注层回调集合（onCreate 仅在形状工具下生效；抓手只点击已有标注）
    private var handlers: AnnotationHandlers {
        AnnotationHandlers(
            noOf: { issueNos[$0.id] ?? 0 },
            onCreate: { rect, target in
                guard let shape = tool.shape else { return }
                creating = CreatingDraft(rect: rect, targetImage: target, shape: shape)
            },
            onQuickCreate: { rect, target, data in
                handleQuickCreate(rect, target: target, data: data)
            },
            onMove: { issue, rect in
                handleMove(issue, rect: rect)
            },
            onEdit: { editingIssue = $0 }
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            headerBar
            // 聚焦条：手动/自动两种模式共用（自动走查抽屉点卡片同样进入聚焦）
            focusBar
            toolbar
            Divider()
            if workMode == .manual {
                HStack(spacing: 0) {
                    VStack(spacing: 0) {
                        canvasBody
                        if canvasModel.mode.isOverlay {
                            overlayHint
                        }
                    }
                    if drawerOpen {
                        Divider()
                        IssueDrawerPanel(
                            issues: modeIssues,
                            onHighlight: handleFlash,
                            onEdit: { editingIssue = $0 },
                            onReverify: openReverify,
                            onAdd: { quickAdd($0) },
                            onClose: { drawerOpen = false },
                            touchPage: touchPage
                        )
                    }
                }
                toolRail
            } else {
                HStack(spacing: 0) {
                    if let page {
                        AutoWalkPanelView(page: page, walkIssues: modeIssues, numbers: issueNos)
                    } else {
                        ContentUnavailableView {
                            Label("未打开页面", systemImage: "photo.on.rectangle.angled")
                        } description: {
                            Text("从「项目」选择页面打开，即可开始自动走查")
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    if drawerOpen {
                        Divider()
                        IssueDrawerPanel(
                            issues: modeIssues,
                            onHighlight: handleFlash,
                            onEdit: { editingIssue = $0 },
                            onReverify: openReverify,
                            onAdd: nil,
                            onClose: { drawerOpen = false },
                            touchPage: touchPage
                        )
                    }
                }
            }
        }
        .background(Color(nsColor: .controlBackgroundColor))
        .background { undoRedoShortcuts }
        .sheet(isPresented: $editPageOpen) {
            if let page {
                PageSheet(mode: .edit(page))
            }
        }
        .sheet(item: $creating) { draft in
            IssueEditorSheet(mode: .create(draft)) { fields in
                createIssue(draft, fields: fields)
            }
        }
        .sheet(item: $editingIssue) { issue in
            IssueEditorSheet(
                mode: .edit(issue),
                onSave: { fields in
                    updateIssue(issue, fields: fields)
                },
                onDelete: {
                    deleteIssue(issue)
                    editingIssue = nil
                }
            )
        }
        .sheet(item: $reverifyIssue) { issue in
            ReverifySheet(issue: issue, oldScreenshot: oldScreenshot) { passed, fixPath, note in
                submitReverify(issue, passed: passed, fixPath: fixPath, note: note)
            }
        }
        .onChange(of: appState.activePageID) { _, _ in
            history.clear()
            focusIssue = nil
            flashId = nil
            flashTask?.cancel()
            flashTask = nil
        }
        // 聚焦查看：放大 2x（退出聚焦不回退缩放，对齐 Electron）
        .onChange(of: focusIssue?.id) { _, newId in
            if newId != nil { canvasModel.zoom = 2 }
        }
    }

    // MARK: - 顶栏（对齐 hero：返回项目 + 页面标题 + 平台徽标 + Figma 链接 + 问题清单 + 编辑信息）

    private var headerBar: some View {
        HStack(spacing: 10) {
            Button {
                appState.closePage()
            } label: {
                Label("返回项目", systemImage: "chevron.left")
            }
            .controlSize(.small)

            if let page {
                Divider().frame(height: 16)
                Text(page.pageName)
                    .font(.headline)
                    .lineLimit(1)
                PlatformBadgeView(platform: page.platform)
                if let url = page.figmaUrl, !url.isEmpty, let dest = URL(string: url) {
                    Link(destination: dest) {
                        Label("Figma 设计稿", systemImage: "link")
                            .labelStyle(.titleAndIcon)
                    }
                    .controlSize(.small)
                    .help(url)
                }
            }
            Spacer()
            if page != nil {
                Button {
                    drawerOpen.toggle()
                } label: {
                    Label("问题清单", systemImage: "list.bullet")
                }
                .controlSize(.small)
                Button("编辑页面信息") { editPageOpen = true }
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    // MARK: - 聚焦条（对齐 aw-focus-bar：正在聚焦查看 + 退出聚焦）

    @ViewBuilder
    private var focusBar: some View {
        if let focusIssue {
            let desc = focusIssue.issueDescription
            HStack(spacing: 8) {
                Image(systemName: "scope")
                Text("正在聚焦查看：\(desc.count > 32 ? String(desc.prefix(32)) + "…" : desc)")
                    .lineLimit(1)
                Spacer()
                Button("退出聚焦") { focusIssue = nil }
                    .controlSize(.small)
            }
            .font(.callout)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color.accentColor.opacity(0.08))
        }
    }

    // MARK: - 画布工具条（对齐 workbench-header：同步滚动 / 分割线 / 缩放 / 视图模式 / 工作模式）

    private var toolbar: some View {
        HStack(spacing: 14) {
            if workMode == .manual {
                if !canvasModel.mode.isOverlay {
                    Toggle("同步滚动", isOn: $canvasModel.syncScroll)
                }
                if canvasModel.mode == .slider {
                    HStack(spacing: 6) {
                        Text("分割线")
                        Slider(value: $canvasModel.sliderPos, in: 0...100)
                            .frame(width: 140)
                    }
                    Toggle("显示分界线", isOn: $canvasModel.showDivider)
                }
                HStack(spacing: 6) {
                    Text("缩放")
                    Slider(value: $canvasModel.zoom, in: 0.25...3, step: 0.05)
                        .frame(width: 120)
                    Text("\(Int((canvasModel.zoom * 100).rounded()))%")
                        .monospacedDigit()
                        .frame(width: 44, alignment: .leading)
                }
                Picker("视图模式", selection: $canvasModel.mode) {
                    ForEach(CanvasViewMode.allCases) { m in
                        Text(m.label).tag(m)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            Spacer()
            Picker("工作模式", selection: $workMode) {
                ForEach(WorkbenchWorkMode.allCases) { m in
                    Text(m.label).tag(m)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .help("切换手动标注与自动走查模式")
        }
        .controlSize(.small)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    // MARK: - 底部工具栏（对齐 anno-toolbar：抓手/点位/箭头/框选/文字/测量/吸色 + 工具提示）

    private var toolRail: some View {
        HStack(spacing: 8) {
            ForEach(AnnotationTool.railOrder, id: \.self) { t in
                Button {
                    tool = t
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: t.systemImage)
                            .font(.system(size: 15))
                        Text(t.label)
                            .font(.system(size: 11))
                    }
                    .frame(width: 56, height: 44)
                    .background(
                        RoundedRectangle(cornerRadius: 8)
                            .fill(tool == t ? Color.accentColor.opacity(0.14) : Color.clear)
                    )
                    .foregroundStyle(tool == t ? Color.accentColor : Color.primary)
                }
                .buttonStyle(.plain)
                .help(t.hint)
            }
            Spacer()
            Text(tool.hint + "；按住已有标注可拖动移动位置，松开后弹出详情")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .frame(maxWidth: 340, alignment: .leading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    /// 隐藏快捷键承载（⌘Z 撤销 / ⇧⌘Z 重做，对齐 Electron keydown 监听）
    private var undoRedoShortcuts: some View {
        VStack {
            Button {
                history.undo(context: context, pageId: page?.id)
            } label: { EmptyView() }
            .keyboardShortcut("z", modifiers: .command)
            Button {
                history.redo(context: context, pageId: page?.id)
            } label: { EmptyView() }
            .keyboardShortcut("z", modifiers: .command.shift)
        }
        .frame(width: 0, height: 0)
        .opacity(0)
        .accessibilityHidden(true)
    }

    // MARK: - 画布主体（手动图集：designImagePath / screenshotPath）

    @ViewBuilder
    private var canvasBody: some View {
        if let page {
            CompareCanvasView(
                designImage: ImageStore.image(of: page.designImagePath),
                shotImage: ImageStore.image(of: page.screenshotPath),
                model: canvasModel,
                designIssues: designIssues,
                shotIssues: shotIssues,
                tool: tool,
                handlers: handlers,
                flashId: flashId,
                focusId: focusIssue?.id,
                focusAnchor: focusAnchor,
                designPixelSize: ImageSampler.pixelSize(of: page.designImagePath),
                shotPixelSize: ImageSampler.pixelSize(of: page.screenshotPath),
                canUndo: history.canUndo,
                canRedo: history.canRedo,
                onUndo: { history.undo(context: context, pageId: page.id) },
                onRedo: { history.redo(context: context, pageId: page.id) },
                onReupload: { reupload($0, page: page) }
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView {
                Label("未打开页面", systemImage: "photo.on.rectangle.angled")
            } description: {
                Text("从「项目」选择页面打开，即可开始双图对比走查")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// 重新上传双图（对齐 handleReupload：选图 → 落盘 → 删旧图 → 更新路径 + touch updatedAt）
    private func reupload(_ target: TargetImage, page: WalkthroughPage) {
        guard let url = ImagePicker.pickImage(),
              let newRel = try? ImageStore.importFile(at: url) else { return }
        switch target {
        case .design:
            if !page.designImagePath.isEmpty { ImageStore.delete(page.designImagePath) }
            page.designImagePath = newRel
        case .screenshot:
            if !page.screenshotPath.isEmpty { ImageStore.delete(page.screenshotPath) }
            page.screenshotPath = newRel
        }
        page.updatedAt = nowMs()
        try? context.save()
    }

    /// 叠加模式底部提示（对齐 annotation-hint）
    private var overlayHint: some View {
        Text("叠加 / 滑块 / 闪烁模式下标注显示在开发截图图层上，可直接标注")
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
    }

    // MARK: - 标注动作

    /// 问题清单点击卡片 → 画布闪烁定位（约 2.3s 自动清除）+ 进入/退出聚焦查看
    private func handleFlash(_ issue: Issue) {
        flashId = issue.id
        flashTask?.cancel()
        flashTask = Task {
            try? await Task.sleep(for: .seconds(2.3))
            guard !Task.isCancelled else { return }
            flashId = nil
        }
        focusIssue = focusIssue?.id == issue.id ? nil : issue
    }

    /// 快速创建（不弹窗）：测量距离 / 吸色取样（对齐 handleQuickCreate）
    private func handleQuickCreate(_ rect: CGRect, target: TargetImage, data: QuickCreateData) {
        guard let page else { return }
        if let px = data.measurePx {
            let n = Int(px.rounded())
            let issue = Issue(
                pageId: page.id,
                targetImage: target,
                x: rect.origin.x,
                y: rect.origin.y,
                width: rect.width,
                height: rect.height,
                issueDescription: "尺寸标注 \(n)px",
                severity: .suggestion,
                category: .spacing,
                status: .pending,
                shape: .measure,
                measureValue: "\(n)px",
                imgSet: .manual
            )
            context.insert(issue)
            history.push(.add([IssueSnapshot(issue)]))
            touchPage(page.id)
            return
        }
        // 吸色：一次点击同时取设计稿与开发截图同一坐标的颜色，双图各生成一条吸色标注
        let ownPath = target == .design ? page.designImagePath : page.screenshotPath
        let otherPath = target == .design ? page.screenshotPath : page.designImagePath
        let ownHex = data.colorHex ?? ImageSampler.pixelHex(of: ownPath, nx: rect.origin.x, ny: rect.origin.y)
        let otherHex = ImageSampler.pixelHex(of: otherPath, nx: rect.origin.x, ny: rect.origin.y)
        let now = nowMs()
        var rows: [Issue] = []
        if let ownHex {
            rows.append(Issue(
                pageId: page.id,
                targetImage: target,
                x: rect.origin.x,
                y: rect.origin.y,
                width: 0,
                height: 0,
                issueDescription: ownHex,
                severity: .suggestion,
                category: .color,
                status: .pending,
                shape: .picker,
                sampleA: target == .design ? ownHex : nil,
                sampleB: target == .screenshot ? ownHex : nil,
                imgSet: .manual,
                createdAt: now
            ))
        }
        if let otherHex {
            let otherTarget: TargetImage = target == .design ? .screenshot : .design
            rows.append(Issue(
                pageId: page.id,
                targetImage: otherTarget,
                x: rect.origin.x,
                y: rect.origin.y,
                width: 0,
                height: 0,
                issueDescription: otherHex,
                severity: .suggestion,
                category: .color,
                status: .pending,
                shape: .picker,
                sampleA: otherTarget == .design ? otherHex : nil,
                sampleB: otherTarget == .screenshot ? otherHex : nil,
                imgSet: .manual,
                createdAt: now + 1
            ))
        }
        guard !rows.isEmpty else { return }
        for issue in rows { context.insert(issue) }
        history.push(.add(rows.map { IssueSnapshot($0) }))
        touchPage(page.id)
    }

    /// 画布拖拽完成 → 弹详情创建（对齐 handleCreate：所在图用草稿值，状态强制待修复）
    private func createIssue(_ draft: CreatingDraft, fields: IssueEditorFields) {
        guard let page else { return }
        let issue = Issue(
            pageId: page.id,
            targetImage: draft.targetImage,
            x: draft.rect.origin.x,
            y: draft.rect.origin.y,
            width: draft.rect.width,
            height: draft.rect.height,
            issueDescription: fields.issueDescription,
            severity: fields.severity,
            category: fields.category,
            status: .pending,
            shape: draft.shape,
            color: fields.color,
            imgSet: .manual
        )
        context.insert(issue)
        history.push(.add([IssueSnapshot(issue)]))
        touchPage(page.id)
    }

    /// 编辑保存（对齐 handleUpdate：AI 候选保存即采纳，入撤销历史）
    private func updateIssue(_ issue: Issue, fields: IssueEditorFields) {
        let before = IssueSnapshot(issue)
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
        history.push(.update(before: before, after: IssueSnapshot(issue)))
        touchPage(issue.pageId)
    }

    /// 删除标注（编辑弹窗删除按钮，入撤销历史）
    private func deleteIssue(_ issue: Issue) {
        history.push(.delete([IssueSnapshot(issue)]))
        context.delete(issue)
        touchPage(issue.pageId)
    }

    /// 拖拽移动标注后提交新位置（对齐 handleMove，入撤销历史）
    private func handleMove(_ issue: Issue, rect: CGRect) {
        let before = IssueSnapshot(issue)
        issue.x = rect.origin.x
        issue.y = rect.origin.y
        issue.width = rect.width
        issue.height = rect.height
        history.push(.update(before: before, after: IssueSnapshot(issue)))
        touchPage(issue.pageId)
    }

    /// 抽屉快捷添加（无坐标不上图，不入撤销历史，对齐 handleQuickAdd）
    private func quickAdd(_ fields: DrawerQuickAdd) {
        guard let page else { return }
        context.insert(Issue(
            pageId: page.id,
            targetImage: fields.targetImage,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            issueDescription: fields.issueDescription,
            severity: fields.severity,
            category: fields.category,
            status: .pending,
            imgSet: .manual
        ))
        touchPage(page.id)
    }

    /// 抽屉复验入口：携带页面原开发截图作为修复前基准（对齐 openReverify）
    private func openReverify(_ issue: Issue) {
        reverifyIssue = issue
        oldScreenshot = page.flatMap { ImageStore.image(of: $0.screenshotPath) }
    }

    /// 复验提交（对齐 ReverifyModal submit：通过=已修复，打回=回到待修复）
    private func submitReverify(_ issue: Issue, passed: Bool, fixPath: String?, note: String?) {
        issue.fixScreenshotPath = fixPath
        issue.fixNote = note
        issue.fixStatus = passed ? .passed : .failed
        issue.status = passed ? .fixed : .pending
        issue.verifiedAt = nowMs()
        issue.reverifyCount = (issue.reverifyCount ?? 0) + 1
        touchPage(issue.pageId)
    }

    /// 触碰页面（updatedAt + save，驱动项目列表「最近更新」）
    private func touchPage(_ pageId: String) {
        if let p = allPages.first(where: { $0.id == pageId }) {
            p.updatedAt = nowMs()
        }
        try? context.save()
    }
}

#Preview {
    CompareWorkbenchView()
        .frame(width: 1200, height: 760)
}
