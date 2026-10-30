import AppKit
import SwiftData
import SwiftUI
import UniformTypeIdentifiers

// MARK: - 导出报告页（对齐 Electron ExportReport.tsx：HTML 交互报告 + 飞书/腾讯/金山一键文档）

/// 文档目标（对齐 DOC_TARGET_KEYS）
enum ExportDocTarget: String, CaseIterable, Identifiable {
    case feishu
    case tencent
    case kingsoft

    var id: String { rawValue }

    var label: String {
        switch self {
        case .feishu: "飞书"
        case .tencent: "腾讯"
        case .kingsoft: "金山"
        }
    }

    var btn: String {
        switch self {
        case .feishu: "生成飞书文档"
        case .tencent: "生成腾讯文档"
        case .kingsoft: "生成金山文档"
        }
    }

    var name: String {
        switch self {
        case .feishu: "飞书文档"
        case .tencent: "腾讯文档"
        case .kingsoft: "金山文档"
        }
    }
}

/// 结果提示类型（ok 绿 / warn 橙 / error 红，对齐 export-result 类名）
private struct ExportResultMsg: Equatable {
    enum Kind { case ok, warn, error }
    let kind: Kind
    let text: String
}

/// 导出历史记录类型徽章文案（对齐 exportReport locale type.*）
private func exportTypeLabel(_ type: ReportType) -> String {
    switch type {
    case .html: "HTML 报告"
    case .feishu: "飞书文档"
    case .tencent: "腾讯文档"
    case .kingsoft: "金山文档"
    case .dev: "研发修改报告"
    }
}

/// 导出报告页：文档目标分段选择 + 摘要 + 操作行 + 导出历史。
/// HTML 报告经保存面板落盘并用系统浏览器打开；文档创建走三平台开放接口（内容口径与 HTML 报告一致：排除未审核 AI 候选）。
struct ExportReportView: View {
    let pageId: String

    @Environment(AppState.self) private var appState
    @Environment(\.modelContext) private var context

    @Query private var allPages: [WalkthroughPage]
    @Query private var allProjects: [Project]
    @Query private var allIssues: [Issue]
    @Query private var allRecords: [ReportRecord]

    @State private var docTarget: ExportDocTarget = .feishu
    @State private var exporting = false
    @State private var creating = false
    @State private var resultMsg: ExportResultMsg?
    /// 未审核候选确认弹窗（export/feishu/tencent 三态）
    @State private var pendingAction: PendingAction?
    @State private var deletingRecord: ReportRecord?
    @State private var confirmAccept = false
    @State private var confirmRevoke = false

    enum PendingAction {
        case export, feishu, tencent

        var continueLabel: String {
            switch self {
            case .export: "继续导出"
            case .feishu: "继续创建飞书文档"
            case .tencent: "继续创建腾讯文档"
            }
        }
    }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy/MM/dd HH:mm:ss"
        f.locale = Locale(identifier: "zh_CN")
        return f
    }()

    private var page: WalkthroughPage? {
        allPages.first { $0.id == pageId }
    }

    private var project: Project? {
        allProjects.first { $0.id == page?.projectId }
    }

    private var issues: [Issue] {
        allIssues.filter { $0.pageId == pageId }.sorted { $0.createdAt < $1.createdAt }
    }

    /// 当前页面已导出的报告历史（按时间升序）
    private var history: [ReportRecord] {
        allRecords.filter { $0.pageId == pageId }.sorted { $0.createdAt < $1.createdAt }
    }

    /// 未审核 AI 候选数量
    private var unreviewed: Int {
        issues.filter { ($0.isAISuggested ?? false) && !($0.aiConfirmed ?? false) }.count
    }

    /// 可导出问题（排除未审核候选；创建时间升序，编号 idx+1）
    private var reportable: [Issue] {
        issues.filter { !(($0.isAISuggested ?? false) && !($0.aiConfirmed ?? false)) }
    }

    private var total: Int { issues.count }
    private var pending: Int { issues.filter { $0.status == .pending }.count }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                exportCard
                if !history.isEmpty {
                    historyCard
                }
            }
            .padding(20)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .sheet(isPresented: Binding(
            get: { pendingAction != nil },
            set: { if !$0 { pendingAction = nil } }
        )) {
            unreviewedSheet
        }
        .confirmationDialog(
            "确认将页面「\(page?.pageName ?? "")」标记为验收通过吗？\n分析报告列表中该页面的状态将显示为「已完成」。",
            isPresented: $confirmAccept,
            titleVisibility: .visible
        ) {
            Button("验收通过") {
                if let page {
                    page.accepted = true
                    page.acceptedAt = Double(Date().timeIntervalSince1970 * 1000)
                    try? context.save()
                }
            }
            Button("取消", role: .cancel) {}
        }
        .confirmationDialog(
            "确认取消页面「\(page?.pageName ?? "")」的验收状态吗？\n分析报告列表中该页面的状态将恢复为「进行中」。",
            isPresented: $confirmRevoke,
            titleVisibility: .visible
        ) {
            Button("取消验收") {
                if let page {
                    page.accepted = false
                    try? context.save()
                }
            }
            Button("返回", role: .cancel) {}
        }
        .confirmationDialog(
            "确认删除该导出记录？",
            isPresented: Binding(
                get: { deletingRecord != nil },
                set: { if !$0 { deletingRecord = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("删除", role: .destructive) {
                if let rec = deletingRecord {
                    context.delete(rec)
                    try? context.save()
                }
                deletingRecord = nil
            }
            Button("取消", role: .cancel) { deletingRecord = nil }
        }
    }

    // MARK: - 头部

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                if let page { appState.open(page: page, context: context) }
            } label: {
                Label("返回对比", systemImage: "chevron.left")
                    .labelStyle(.titleAndIcon)
            }
            .controlSize(.small)
            Text("导出报告")
                .font(.title2.bold())
        }
    }

    // MARK: - 导出卡片

    private var exportCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("", selection: $docTarget) {
                ForEach(ExportDocTarget.allCases) { t in
                    Text(t.label).tag(t)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 250)
            .help("选择报告文档目标")

            summaryLine(label: "项目：", value: project?.name ?? "")
            summaryLine(label: "页面：", value: page?.pageName ?? "")
            summaryLine(label: "问题：", value: "共 \(total) 个，待修复 \(pending) 个")
            Text("报告为交互式：研发可在报告内点击图上标注查看详情、回应「已修复 / 无法修复（原因）」，全部回应后可在报告内一键导出研发修改报告。")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    Button {
                        handleExport()
                    } label: {
                        Text(exporting ? "导出中..." : "导出 HTML 报告")
                            .frame(minWidth: 120)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(exporting || creating || page == nil)

                    Button {
                        handleCreateDoc()
                    } label: {
                        Text(creating ? "创建中..." : docTarget.btn)
                            .frame(minWidth: 120)
                    }
                    .buttonStyle(.bordered)
                    .disabled(creating || exporting || page == nil)
                    .help(docTargetTip)
                }
                Spacer()
                if page?.accepted == true {
                    Text("✓ 已验收通过")
                        .font(.callout)
                        .foregroundStyle(.green)
                    Button("取消验收") { confirmRevoke = true }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .help("取消后分析报告状态恢复为「进行中」")
                } else {
                    Button("验收通过") { confirmAccept = true }
                        .buttonStyle(.bordered)
                        .disabled(page == nil)
                        .help("通过后分析报告列表中该页面状态将显示为「已完成」")
                }
            }

            if let msg = resultMsg {
                Text(msg.text)
                    .font(.callout)
                    .foregroundStyle(color(of: msg.kind))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color(nsColor: .separatorColor).opacity(0.6))
        )
    }

    private var docTargetTip: String {
        if docTarget == .feishu {
            return FeishuService.isReady ? "将报告一键创建为飞书文档" : "需先在「设置 → 应用授权」配置飞书应用"
        }
        return "将报告一键创建为\(docTarget.name)"
    }

    private func summaryLine(label: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(label).fontWeight(.semibold)
            Text(value)
        }
        .font(.callout)
    }

    // MARK: - 导出历史

    private var historyCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("导出历史")
                .font(.headline)
            VStack(spacing: 0) {
                ForEach(history) { rec in
                    historyRow(rec)
                    if rec.id != history.last?.id {
                        Divider()
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color(nsColor: .separatorColor).opacity(0.6))
        )
    }

    private func historyRow(_ rec: ReportRecord) -> some View {
        HStack(spacing: 10) {
            Text(exportTypeLabel(rec.type))
                .font(.caption2)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Color.accentColor.opacity(0.12), in: Capsule())
                .foregroundStyle(.secondary)
            Text(rec.name)
                .font(.system(size: 13))
                .lineLimit(1)
                .help(rec.name)
            Text("共 \(rec.total) 个问题")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(Self.timeFormatter.string(from: Date(timeIntervalSince1970: rec.createdAt / 1000)))
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                deletingRecord = rec
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .help("删除记录")
        }
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .onTapGesture { openRecord(rec) }
        .help("点击查看报告")
    }

    /// 打开记录：HTML 报告打开本地文件，在线文档打开链接
    private func openRecord(_ rec: ReportRecord) {
        if rec.type == .html, let path = rec.filePath, !path.isEmpty {
            _ = NSWorkspace.shared.open(URL(fileURLWithPath: path))
        } else if let url = rec.url, !url.isEmpty, let u = URL(string: url) {
            NSWorkspace.shared.open(u)
        }
    }

    // MARK: - 未审核候选弹窗

    private var unreviewedSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("存在未审核的 AI 候选标注")
                .font(.headline)
            let target = pendingAction == .feishu ? "飞书文档" : "本次导出的报告"
            Text("当前页面有 \(unreviewed) 条 AI 候选标注尚未审核，它们不会计入\(target)。可先返回工作台逐条采纳或忽略，也可以直接继续。")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("返回审核") {
                    pendingAction = nil
                    if let page { appState.open(page: page, context: context) }
                }
                .buttonStyle(.bordered)
                Button {
                    let action = pendingAction
                    pendingAction = nil
                    switch action {
                    case .export: doExport()
                    case .tencent: doTencent()
                    case .feishu, .none: doFeishu()
                    }
                } label: {
                    Text(pendingAction?.continueLabel ?? "继续导出")
                        .frame(minWidth: 100)
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(22)
        .frame(width: 480, alignment: .leading)
    }

    // MARK: - HTML 导出

    private func handleExport() {
        if unreviewed > 0 {
            pendingAction = .export
            return
        }
        doExport()
    }

    private func handleCreateDoc() {
        switch docTarget {
        case .feishu:
            guard FeishuService.isReady else {
                resultMsg = ExportResultMsg(
                    kind: .warn,
                    text: "请先在「设置 → 应用授权」配置飞书自建应用的 App ID / App Secret"
                )
                return
            }
            if unreviewed > 0 {
                pendingAction = .feishu
                return
            }
            doFeishu()
        case .tencent:
            if unreviewed > 0 {
                pendingAction = .tencent
                return
            }
            doTencent()
        case .kingsoft:
            doKingsoft()
        }
    }

    /// 实际执行导出：生成 HTML → 保存面板 → 落盘 → 系统浏览器打开 → 写导出历史
    private func doExport() {
        guard let page else { return }
        exporting = true
        resultMsg = nil
        let html = buildHtml(compressed: false)
        let name = "走查报告_\(page.pageName)_\(ReportHTMLBuilder.isoDateString()).html"
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.allowedContentTypes = [.html]
        let resp = panel.runModal()
        guard resp == .OK, let url = panel.url else {
            exporting = false
            return
        }
        do {
            try Data(html.utf8).write(to: url)
            let exportTotal = reportable.count
            context.insert(
                ReportRecord(
                    pageId: page.id,
                    projectId: page.projectId,
                    type: .html,
                    name: name,
                    filePath: url.path,
                    total: exportTotal
                )
            )
            try? context.save()
            if NSWorkspace.shared.open(url) {
                resultMsg = ExportResultMsg(kind: .ok, text: "已导出：\(url.path)")
            } else {
                resultMsg = ExportResultMsg(kind: .warn, text: "已导出（文件已保存，但自动打开失败）：\(url.path)")
            }
        } catch {
            resultMsg = ExportResultMsg(kind: .error, text: "导出失败：\(error.localizedDescription)")
        }
        exporting = false
    }

    /// 组装文档导出 payload（飞书 / 腾讯共用；内容口径与 HTML 报告一致：排除未审核候选）
    private func buildDocPayload() throws -> (payload: DocExportPayload, reportable: [Issue]) {
        guard let page else { throw DocExportError("页面数据未加载") }
        // 与 HTML 报告口径一致：手动标注图与自动走查采集图分别压缩
        let designImg = uploadImage(page.designImagePath)
        let shotImg = uploadImage(page.screenshotPath)
        let walkDesignImg = uploadImage(page.walkDesignPath)
        let walkShotImg = uploadImage(page.walkShotPath)
        let exportable = reportable
        let doneCount = exportable.filter { $0.status == .fixed }.count
        var images: [DocExportPayload.Image] = []
        if let img = designImg { images.append(.init(name: "设计稿", dataUrl: img)) }
        if let img = shotImg { images.append(.init(name: "开发截图", dataUrl: img)) }
        if let img = walkDesignImg { images.append(.init(name: "走查设计稿", dataUrl: img)) }
        if let img = walkShotImg { images.append(.init(name: "走查开发截图", dataUrl: img)) }
        // 附件版 HTML 用压缩图重新生成，避免内嵌原图导致附件超过上传上限
        let attachHtml = ReportHTMLBuilder.generateReportHTML(
            projectName: project?.name ?? "",
            pageName: page.pageName,
            platformLabel: page.platform.label,
            figmaUrl: page.figmaUrl,
            designImg: designImg,
            shotImg: shotImg,
            walkDesignImg: walkDesignImg,
            walkShotImg: walkShotImg,
            issues: reportable.enumerated().map { ReportHTMLBuilder.makeIssueData($1, no: $0 + 1) }
        )
        var metaLines = [
            "项目：\(project?.name ?? "")　页面：\(page.pageName)　端类型：\(page.platform.label)"
        ]
        if let figmaUrl = page.figmaUrl, !figmaUrl.isEmpty {
            metaLines.append("设计稿：\(figmaUrl)")
        }
        metaLines.append("生成时间：\(ReportHTMLBuilder.zhTimeString())")
        let payload = DocExportPayload(
            title: "UI 走查报告 - \(page.pageName)",
            metaLines: metaLines,
            stats: [
                .init(label: "问题总数", value: String(reportable.count)),
                .init(label: "已修复", value: String(doneCount)),
                .init(label: "待处理", value: String(reportable.count - doneCount))
            ],
            issues: exportable.enumerated().map { idx, issue in
                DocExportPayload.Issue(
                    no: idx + 1,
                    title: issue.issueDescription,
                    severityLabel: issue.severity.label,
                    categoryLabel: issue.category.label,
                    sourceLabel: issue.source?.label ?? IssueSource.manual.label,
                    targetLabel: issue.targetImage == .design ? "设计稿" : "开发截图",
                    statusLabel: issue.status.label,
                    suggestion: issue.aiSuggestion.map {
                        AISuggestionData(current: $0.current, fix: $0.fix, properties: $0.properties)
                    }
                )
            },
            images: images,
            htmlReport: (
                name: "UI 走查报告 - \(page.pageName).html",
                dataUrl: DocExportUtil.htmlToDataUrl(attachHtml)
            )
        )
        return (payload, reportable)
    }

    /// 飞书：一键创建文档（内容 + 附件），失败不落历史
    private func doFeishu() {
        guard let page else { return }
        creating = true
        resultMsg = nil
        Task {
            do {
                let (payload, reportable) = try buildDocPayload()
                let res = await FeishuService.createReport(payload)
                if !res.ok {
                    resultMsg = ExportResultMsg(kind: .error, text: "创建飞书文档失败：\(res.message)")
                    creating = false
                    return
                }
                context.insert(
                    ReportRecord(
                        pageId: page.id,
                        projectId: page.projectId,
                        type: .feishu,
                        name: "UI 走查报告 - \(page.pageName)",
                        url: res.url,
                        total: reportable.count
                    )
                )
                try? context.save()
                // ok 时 message 可能携带降级 warning（附件上传失败、多维表降级等），需完整透出
                let msg = res.message
                let warn = !msg.isEmpty && msg != "文档创建成功"
                resultMsg = ExportResultMsg(
                    kind: warn ? .warn : .ok,
                    text: msg.isEmpty ? "飞书文档已创建，浏览器将自动打开" : msg
                )
            } catch {
                resultMsg = ExportResultMsg(kind: .error, text: "创建飞书文档失败：\(error.localizedDescription)")
            }
            creating = false
        }
    }

    /// 腾讯：报告内容生成 docx 后导入为在线文档
    private func doTencent() {
        guard let page else { return }
        creating = true
        resultMsg = nil
        Task {
            do {
                let (payload, reportable) = try buildDocPayload()
                let res = await TencentDocService.createReport(payload)
                if !res.ok {
                    resultMsg = ExportResultMsg(kind: .error, text: "创建腾讯文档失败：\(res.message)")
                    creating = false
                    return
                }
                context.insert(
                    ReportRecord(
                        pageId: page.id,
                        projectId: page.projectId,
                        type: .tencent,
                        name: payload.title,
                        url: res.url,
                        total: reportable.count
                    )
                )
                try? context.save()
                let msg = res.message
                let warn = msg.contains("超时") || msg.contains("失败")
                resultMsg = ExportResultMsg(
                    kind: warn ? .warn : .ok,
                    text: msg.isEmpty ? "腾讯文档已创建，浏览器将自动打开" : msg
                )
            } catch {
                resultMsg = ExportResultMsg(kind: .error, text: "创建腾讯文档失败：\(error.localizedDescription)")
            }
            creating = false
        }
    }

    /// 金山：创建在线文档（标题为报告名）
    private func doKingsoft() {
        guard let page else { return }
        creating = true
        resultMsg = nil
        Task {
            let title = "UI 走查报告 - \(page.pageName)"
            let reportable = reportable
            let res = await KingsoftDocService.createReport(title)
            if !res.ok {
                resultMsg = ExportResultMsg(kind: .error, text: "创建金山文档失败：\(res.message)")
            } else {
                context.insert(
                    ReportRecord(
                        pageId: page.id,
                        projectId: page.projectId,
                        type: .kingsoft,
                        name: title,
                        url: res.url,
                        total: reportable.count
                    )
                )
                try? context.save()
                resultMsg = ExportResultMsg(
                    kind: .ok,
                    text: res.message.isEmpty ? "金山文档已创建，浏览器将自动打开" : res.message
                )
            }
            creating = false
        }
    }

    // MARK: - 工具

    /// 页面图片 → dataUrl（压缩供文档上传用；读不到返回 nil）
    private func uploadImage(_ relativePath: String?) -> String? {
        guard let raw = ReportHTMLBuilder.imageDataUrl(relativePath) else { return nil }
        return DocExportUtil.compressedJpegDataUrl(raw)
    }

    /// 生成交互式报告 HTML（compressed = 文档附件场景，用压缩图）
    private func buildHtml(compressed: Bool) -> String {
        guard let page else { return "" }
        func image(_ path: String?) -> String? {
            guard let raw = ReportHTMLBuilder.imageDataUrl(path) else { return nil }
            return compressed ? DocExportUtil.compressedJpegDataUrl(raw) : raw
        }
        return ReportHTMLBuilder.generateReportHTML(
            projectName: project?.name ?? "",
            pageName: page.pageName,
            platformLabel: page.platform.label,
            figmaUrl: page.figmaUrl,
            designImg: image(page.designImagePath),
            shotImg: image(page.screenshotPath),
            walkDesignImg: image(page.walkDesignPath),
            walkShotImg: image(page.walkShotPath),
            issues: reportable.enumerated().map { ReportHTMLBuilder.makeIssueData($1, no: $0 + 1) }
        )
    }

    private func color(of kind: ExportResultMsg.Kind) -> Color {
        switch kind {
        case .ok: .green
        case .warn: .orange
        case .error: .red
        }
    }
}
