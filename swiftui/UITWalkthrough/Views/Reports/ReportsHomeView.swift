import SwiftData
import SwiftUI

// MARK: - 分析报告页（对齐 Electron ReportsPage）

/// 报告版本分组：同一页面的多次导出聚合为一组，旧→新编号 V1..Vn
private struct ReportGroup: Identifiable {
    let key: String
    let projectId: String
    let pageId: String
    let pageName: String
    /// 版本列表（新→旧排列，ver = 1 为最早导出）
    var versions: [Version]

    var id: String { key }
    var latestAt: Double { versions[0].record.createdAt }
    var latest: Version { versions[0] }

    struct Version: Identifiable {
        let record: ReportRecord
        let ver: Int

        var id: String { record.id }
        var displayName: String { record.name.isEmpty ? "走查报告 V\(ver)" : record.name }
    }
}

/// 打开报告结果提示（ok=绿色 / error=红色）
private struct ReportOpenMsg: Equatable {
    let ok: Bool
    let text: String
}

/// 分析报告页：顶部横幅 + 报告列表卡片。
/// 同一页面的多次导出按版本归组：列表视图组行展示最新版本摘要、可展开历史版本行；网格视图展示组卡片。
/// 支持项目筛选、关键词搜索（页面/项目/文件名）、列表与网格双视图、分页。
/// Swift 版无内置浏览器，报告统一用系统浏览器打开。
struct ReportsHomeView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.modelContext) private var context

    @Query private var allRecords: [ReportRecord]
    @Query private var allProjects: [Project]
    @Query private var allPages: [WalkthroughPage]

    @State private var projectFilter = "all"
    @State private var keyword = ""
    @State private var viewMode: ViewMode = .list
    /// 展开的分组 key 集合（默认全部收起，仅展示组摘要）
    @State private var expanded: Set<String> = []
    @State private var page = 1
    @State private var pageSize = 8
    @State private var msg: ReportOpenMsg?

    private enum ViewMode { case list, grid }

    /// 分页每页条数选项（对齐 Electron PAGE_SIZES）
    private static let pageSizes = [8, 16, 32]

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy/MM/dd HH:mm:ss"
        f.locale = Locale(identifier: "zh_CN")
        return f
    }()

    /// 列表固定列宽（表头与行共用，保证对齐）
    private enum Col {
        static let issues: CGFloat = 56
        static let time: CGFloat = 148
        static let status: CGFloat = 64
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                hero
                reportsCard
            }
            .padding(20)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - 派生数据

    /// 仅统计 HTML 导出记录（对齐 db.reportRecords.filter(type === 'html')）
    private var htmlRecords: [ReportRecord] {
        allRecords.filter { $0.type == .html }
    }

    private func projectName(_ id: String) -> String {
        allProjects.first { $0.id == id }?.name ?? "未知项目"
    }

    /// 按「项目 + 页面」聚合为版本组；组按最新导出时间倒序
    private var groups: [ReportGroup] {
        let sorted = htmlRecords.sorted { $0.createdAt < $1.createdAt }
        var map: [String: [ReportRecord]] = [:]
        var keyOrder: [String] = []
        for r in sorted {
            let k = "\(r.projectId)|\(r.pageId)"
            if map[k] == nil { keyOrder.append(k) }
            map[k, default: []].append(r)
        }
        return keyOrder.compactMap { key in
            guard let list = map[key], let first = list.first else { return nil }
            let versions = list.enumerated()
                .map { ReportGroup.Version(record: $1, ver: $0 + 1) }
                .reversed()
            let pageName = allPages.first { $0.id == first.pageId }?.pageName ?? "页面已删除"
            return ReportGroup(
                key: key,
                projectId: first.projectId,
                pageId: first.pageId,
                pageName: pageName,
                versions: Array(versions)
            )
        }
        .sorted { $0.latestAt > $1.latestAt }
    }

    /// 项目筛选（有记录的项目才出现在下拉里，按名称排序）
    private var projectOptions: [Project] {
        let ids = Set(htmlRecords.map(\.projectId))
        return allProjects
            .filter { ids.contains($0.id) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// 筛选 + 搜索（页面名 / 项目名 / 报告文件名）
    private var filtered: [ReportGroup] {
        let k = keyword.trimmingCharacters(in: .whitespaces).lowercased()
        return groups.filter { g in
            if projectFilter != "all" && g.projectId != projectFilter { return false }
            if !k.isEmpty {
                let hit = g.pageName.lowercased().contains(k)
                    || projectName(g.projectId).lowercased().contains(k)
                    || g.versions.contains { $0.record.name.lowercased().contains(k) }
                if !hit { return false }
            }
            return true
        }
    }

    /// 分页（组维度）
    private var totalPages: Int { max(1, (filtered.count + pageSize - 1) / pageSize) }
    private var safePage: Int { min(page, totalPages) }
    private var pageGroups: [ReportGroup] {
        let start = (safePage - 1) * pageSize
        guard start < filtered.count else { return [] }
        return Array(filtered[start..<min(start + pageSize, filtered.count)])
    }

    // MARK: - 顶部横幅

    private var hero: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 8) {
                Text("用 AI 发现问题，让产品更好")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundStyle(.white)
                Text("基于智能分析与专业检测，为您提供高质量的走查报告")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.85))
                HStack(spacing: 22) {
                    feat(icon: "chart.pie", tint: .cyan, title: "多维度分析", desc: "全面检测")
                    feat(icon: "scope", tint: .purple, title: "问题定位", desc: "精准高效")
                    feat(icon: "wand.and.stars", tint: .teal, title: "专业建议", desc: "可执行方案")
                }
                .padding(.top, 6)
            }
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(
                colors: [
                    Color(red: 0.23, green: 0.38, blue: 0.92),
                    Color(red: 0.48, green: 0.30, blue: 0.88)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 14)
        )
    }

    private func feat(icon: String, tint: Color, title: String, desc: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(tint.opacity(0.45), in: Circle())
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                Text(desc)
                    .font(.system(size: 10))
                    .foregroundStyle(.white.opacity(0.75))
            }
        }
    }

    // MARK: - 报告列表卡片

    private var reportsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            toolbar
            if viewMode == .list {
                listView
            } else {
                gridView
            }
            pagination
            resultMsg
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color(nsColor: .separatorColor).opacity(0.6))
        )
    }

    /// 工具栏：项目筛选 + 搜索 + 视图切换
    private var toolbar: some View {
        HStack(spacing: 10) {
            Picker("", selection: $projectFilter) {
                Text("全部项目").tag("all")
                ForEach(projectOptions) { p in
                    Text(p.name).tag(p.id)
                }
            }
            .labelsHidden()
            .frame(width: 190)
            .onChange(of: projectFilter) { _, _ in page = 1 }

            Spacer()

            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                TextField("搜索报告名称、项目名称...", text: $keyword)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                    .frame(width: 190)
                    .onChange(of: keyword) { _, _ in page = 1 }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(.quinary, in: RoundedRectangle(cornerRadius: 7))

            Picker("", selection: $viewMode) {
                Image(systemName: "square.grid.2x2").tag(ViewMode.grid)
                Image(systemName: "list.bullet").tag(ViewMode.list)
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .frame(width: 88)
            .help("切换视图")
        }
    }

    // MARK: - 列表视图

    private var listView: some View {
        VStack(spacing: 0) {
            tableHeader
            if pageGroups.isEmpty {
                emptyHint
            } else {
                ForEach(pageGroups) { g in
                    groupRow(g)
                    if expanded.contains(g.key) {
                        versionList(g)
                    }
                    Divider().padding(.leading, 12)
                }
            }
        }
    }

    private var tableHeader: some View {
        HStack(spacing: 12) {
            Text("报告名称").frame(minWidth: 240, maxWidth: .infinity, alignment: .leading)
            Text("项目 / 页面").frame(minWidth: 150, maxWidth: .infinity, alignment: .leading)
            Text("问题数").frame(width: Col.issues, alignment: .leading)
            Text("生成时间").frame(width: Col.time, alignment: .leading)
            Text("状态").frame(width: Col.status, alignment: .leading)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
    }

    /// 组行：点击整行展开/收起历史版本；页面名可点击跳转工作台
    private func groupRow(_ g: ReportGroup) -> some View {
        let accepted = allPages.first { $0.id == g.pageId }?.accepted ?? false
        return row(
            name: HStack(spacing: 10) {
                thumb(g.pageName, large: false)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(g.pageName)
                            .font(.system(size: 13, weight: .semibold))
                            .lineLimit(1)
                        Text("\(g.versions.count) 个版本")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Text(g.latest.record.name.isEmpty ? "走查报告-\(g.pageName).html" : g.latest.record.name)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            },
            path: pathCell(projectId: g.projectId, pageId: g.pageId, pageName: g.pageName),
            issues: g.latest.record.total,
            time: fmtTime(g.latest.record.createdAt),
            status: accepted
        )
        .contentShape(Rectangle())
        .onTapGesture { toggle(g.key) }
        .help(expanded.contains(g.key) ? "点击收起历史版本" : "点击展开历史版本")
    }

    /// 版本行（展开时显示，旧→新；点击整行打开该版本报告）
    private func versionList(_ g: ReportGroup) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(g.versions.reversed())) { v in
                let accepted = allPages.first { $0.id == g.pageId }?.accepted ?? false
                let hasPath = !(v.record.filePath ?? "").isEmpty
                row(
                    name: HStack(spacing: 10) {
                        verBadge(v.ver)
                        Text(v.displayName)
                            .font(.system(size: 13, weight: .medium))
                            .lineLimit(1)
                    },
                    path: pathCell(projectId: g.projectId, pageId: g.pageId, pageName: g.pageName),
                    issues: v.record.total,
                    time: fmtTime(v.record.createdAt),
                    status: accepted
                )
                .padding(.leading, 22)
                .contentShape(Rectangle())
                .onTapGesture { openReport(v.record) }
                .help(hasPath ? "点击打开该版本报告" : "旧版本未记录文件路径，无法打开")
                Divider().padding(.leading, 34)
            }
        }
        .background(Color.primary.opacity(0.025))
    }

    /// 「项目 / 页面」单元格：项目名 + 可点击的页面名（跳转工作台）
    private func pathCell(projectId: String, pageId: String, pageName: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(projectName(projectId))
                .font(.system(size: 13))
                .lineLimit(1)
            if let pg = allPages.first(where: { $0.id == pageId }) {
                Button {
                    appState.open(page: pg, context: context)
                } label: {
                    Text(pg.pageName)
                        .font(.caption)
                        .lineLimit(1)
                }
                .buttonStyle(.link)
            } else {
                Text("页面已删除")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// 统一列布局行（表头与行共用列宽）
    private func row<Name: View, Path: View>(
        name: Name,
        path: Path,
        issues: Int,
        time: String,
        status: Bool
    ) -> some View {
        HStack(spacing: 12) {
            name.frame(minWidth: 240, maxWidth: .infinity, alignment: .leading)
            path.frame(minWidth: 150, maxWidth: .infinity, alignment: .leading)
            Text("\(issues)")
                .font(.system(size: 13))
                .frame(width: Col.issues, alignment: .leading)
            Text(time)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: Col.time, alignment: .leading)
            statusBadge(status)
                .frame(width: Col.status, alignment: .leading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }

    // MARK: - 网格视图

    private var gridView: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 320), spacing: 14)],
            spacing: 14
        ) {
            if pageGroups.isEmpty {
                emptyHint
                    .gridCellColumns(2)
                    .frame(maxWidth: .infinity)
            } else {
                ForEach(pageGroups) { g in
                    gridCard(g)
                }
            }
        }
    }

    /// 组卡片：头部（缩略图 + 页面名 + 状态）+ 统计 + 操作行 + 可展开历史版本
    private func gridCard(_ g: ReportGroup) -> some View {
        let accepted = allPages.first { $0.id == g.pageId }?.accepted ?? false
        let open = expanded.contains(g.key)
        let latestHasPath = !(g.latest.record.filePath ?? "").isEmpty
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                thumb(g.pageName, large: true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(g.pageName)
                        .font(.system(size: 14, weight: .semibold))
                        .lineLimit(1)
                        .help(g.pageName)
                    Text("\(projectName(g.projectId)) · \(g.versions.count) 个版本")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                statusBadge(accepted)
            }
            HStack(spacing: 12) {
                HStack(spacing: 3) {
                    Text("\(g.latest.record.total)")
                        .font(.system(size: 15, weight: .semibold))
                    Text("个问题")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(fmtTime(g.latest.record.createdAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                if latestHasPath {
                    Button("查看") { openReport(g.latest.record) }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                } else {
                    Text("路径缺失")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(open ? "收起版本" : "历史版本（\(g.versions.count - 1)）") {
                    toggle(g.key)
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
            }
            if open {
                VStack(spacing: 6) {
                    ForEach(Array(g.versions.reversed())) { v in
                        let hasPath = !(v.record.filePath ?? "").isEmpty
                        Button {
                            openReport(v.record)
                        } label: {
                            HStack(spacing: 8) {
                                verBadge(v.ver)
                                Text(fmtTime(v.record.createdAt))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text("\(v.record.total) 问题")
                                    .font(.caption)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(!hasPath)
                        .help(hasPath ? "打开该版本报告" : "旧版本未记录文件路径，请重新导出")
                    }
                }
                .padding(8)
                .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color(nsColor: .separatorColor).opacity(0.6))
        )
    }

    // MARK: - 分页 / 提示

    @ViewBuilder
    private var pagination: some View {
        if !filtered.isEmpty {
            HStack(spacing: 10) {
                Text("共 \(filtered.count) 组报告")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                HStack(spacing: 2) {
                    Button {
                        page = safePage - 1
                    } label: {
                        Text("‹").frame(width: 20)
                    }
                    .disabled(safePage <= 1)
                    ForEach(1...totalPages, id: \.self) { n in
                        Button {
                            page = n
                        } label: {
                            Text("\(n)")
                                .font(.caption)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(
                                    n == safePage ? Color.accentColor.opacity(0.15) : Color.clear,
                                    in: Capsule()
                                )
                                .foregroundStyle(n == safePage ? Color.accentColor : Color.primary)
                        }
                        .buttonStyle(.plain)
                    }
                    Button {
                        page = safePage + 1
                    } label: {
                        Text("›").frame(width: 20)
                    }
                    .disabled(safePage >= totalPages)
                }
                Picker("", selection: $pageSize) {
                    ForEach(Self.pageSizes, id: \.self) { n in
                        Text("\(n) 组/页").tag(n)
                    }
                }
                .labelsHidden()
                .frame(width: 104)
                .onChange(of: pageSize) { _, _ in page = 1 }
            }
        }
    }

    private var emptyHint: some View {
        Text(groups.isEmpty
            ? "暂无导出记录，在对比工作台右上角「导出报告」导出 HTML 报告后，这里会自动汇总"
            : "当前筛选条件下暂无报告")
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 48)
    }

    @ViewBuilder
    private var resultMsg: some View {
        if let msg {
            Text(msg.text)
                .font(.callout)
                .foregroundStyle(msg.ok ? Color.green : Color.red)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - 小组件

    /// 报告缩略图占位：页面名首字符 + 渐变底（报告记录未存缩略图）
    private func thumb(_ name: String, large: Bool) -> some View {
        let size: CGFloat = large ? 40 : 30
        return Text(String(name.prefix(1)))
            .font(.system(size: size * 0.45, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(
                LinearGradient(
                    colors: [
                        Color(red: 0.30, green: 0.50, blue: 0.95),
                        Color(red: 0.55, green: 0.35, blue: 0.90)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                ),
                in: RoundedRectangle(cornerRadius: size * 0.24)
            )
    }

    /// 版本徽章：ver = 1（最早导出）显示「最新」，其余 V{n}
    private func verBadge(_ ver: Int) -> some View {
        Text(ver == 1 ? "最新" : "V\(ver)")
            .font(.caption2)
            .fontWeight(.semibold)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(
                ver == 1 ? Color.green.opacity(0.15) : Color.primary.opacity(0.07),
                in: Capsule()
            )
            .foregroundStyle(ver == 1 ? Color.green : Color.secondary)
    }

    /// 页面验收状态徽章
    private func statusBadge(_ accepted: Bool) -> some View {
        Text(accepted ? "已完成" : "进行中")
            .font(.caption2)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(
                (accepted ? Color.green : Color.orange).opacity(0.15),
                in: Capsule()
            )
            .foregroundStyle(accepted ? Color.green : Color.orange)
    }

    // MARK: - 操作

    private func fmtTime(_ ts: Double) -> String {
        Self.timeFormatter.string(from: Date(timeIntervalSince1970: ts / 1000))
    }

    private func toggle(_ key: String) {
        if expanded.contains(key) {
            expanded.remove(key)
        } else {
            expanded.insert(key)
        }
    }

    /// 打开报告：系统浏览器；旧记录无 filePath 时提示重新导出
    private func openReport(_ record: ReportRecord) {
        guard let path = record.filePath, !path.isEmpty else {
            msg = ReportOpenMsg(ok: false, text: "旧版本未记录文件路径，无法打开")
            return
        }
        if NSWorkspace.shared.open(URL(fileURLWithPath: path)) {
            msg = ReportOpenMsg(ok: true, text: "已在系统浏览器打开报告")
        } else {
            msg = ReportOpenMsg(ok: false, text: "打开失败")
        }
    }
}
