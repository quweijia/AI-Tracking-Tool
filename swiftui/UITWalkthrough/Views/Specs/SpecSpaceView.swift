import SwiftUI
import SwiftData

// MARK: - 设计规范空间（对齐 Electron 版 /specs 路由三页：总览 SpecsIndex / 端分类列表 SpecsCategoryIndex / 规范详情）

// MARK: - 预置端分类补种（镜像 db/index.ts ensureSpecCategories：按 platformKey 缺失补种）

@MainActor
func ensureBuiltinSpecCategories(_ ctx: ModelContext) {
    let existing = (try? ctx.fetch(FetchDescriptor<SpecCategory>())) ?? []
    let keys = Set(existing.map(\.platformKey))
    let base = nowMs()
    for (i, item) in BuiltinSpecCategories.items.enumerated() where !keys.contains(item.platformKey) {
        ctx.insert(
            SpecCategory(
                name: item.name,
                platformKey: item.platformKey,
                builtin: 1,
                sortNo: existing.count + i,
                createdAt: base + Double(i)
            )
        )
    }
    try? ctx.save()
}

// MARK: - 小组件

/// 状态胶囊（ok=绿 / warn=橙 / gray=灰 / err=红）
struct SpecPill: View {
    enum Tone { case ok, warn, gray, err }
    let text: String
    var tone: Tone = .gray

    private var color: Color {
        switch tone {
        case .ok: .green
        case .warn: .orange
        case .err: .red
        case .gray: .secondary
        }
    }

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.14), in: Capsule())
            .foregroundStyle(color)
    }
}

/// 同步状态圆点（对齐 specx-state）
struct SyncStateDot: View {
    let label: String
    var ok: Bool
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(ok ? Color.green : Color.secondary.opacity(0.5)).frame(width: 6, height: 6)
            Text(label).font(.caption).foregroundStyle(ok ? Color.green : .secondary)
        }
    }
}

/// 端类型图标（对齐 SpecPlatIcon：显示器/手机/图表/桌面窗口四形）
struct SpecPlatformIcon: View {
    let platform: Platform
    var size: CGFloat = 16

    var body: some View {
        Image(systemName: icon)
            .font(.system(size: size))
            .foregroundStyle(.tint)
    }

    private var icon: String {
        switch platform {
        case .h5: "iphone"
        case .pc: "laptopcomputer"
        case .dashboard: "chart.bar.fill"
        case .electron: "menubar.dock.rectangle"
        }
    }
}

/// 色值小色块（Token 表 / 引用弹层共用）
struct TokenSwatch: View {
    let hex: String
    var size: CGFloat = 12
    var body: some View {
        RoundedRectangle(cornerRadius: 3)
            .fill(colorFromHex(hex) ?? .gray)
            .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(.quaternary, lineWidth: 0.5))
            .frame(width: size, height: size)
    }
}

// MARK: - 规范空间根视图（.specs 侧边栏入口）

struct SpecSpaceView: View {
    @Environment(\.modelContext) private var ctx

    var body: some View {
        NavigationStack {
            SpecsIndexView()
                .navigationDestination(for: String.self) { categoryId in
                    SpecCategoryListView(categoryId: categoryId)
                }
                .navigationDestination(for: SpecSpecRoute.self) { route in
                    SpecDetailView(specId: route.specId)
                }
        }
        .onAppear { ensureBuiltinSpecCategories(ctx) }
    }
}

/// 规范详情页路由值（分类列表卡 → 详情页）
struct SpecSpecRoute: Hashable {
    let specId: String
}

// MARK: - 总览页（/specs：Banner + 端分类卡 + 最近使用 + 三步指引 + 统计条 + 检查更新）

struct SpecsIndexView: View {
    @Environment(\.modelContext) private var ctx
    @Query private var categories: [SpecCategory]
    @Query private var specsAll: [DesignSpec]
    @Query private var versionsAll: [SpecVersion]
    @Query private var bindings: [ProjectSpecBinding]
    @Query private var projects: [Project]

    @State private var showGuide = false
    @State private var creatingIn: CategoryPick?
    @State private var checking = false
    @State private var checkResult: SpecCheckState?

    /// 每套规范最新版本（取 no 最大）
    private var latestBySpec: [String: SpecVersion] {
        var m: [String: SpecVersion] = [:]
        for v in versionsAll {
            if let cur = m[v.specId], cur.no >= v.no { continue }
            m[v.specId] = v
        }
        return m
    }

    /// 分类展示名（预置用平台口径名，自定义用原始名）
    private func catName(_ c: SpecCategory) -> String {
        c.isBuiltin ? builtinCatName(c.platformKey) : c.name
    }

    private func builtinCatName(_ p: Platform) -> String {
        switch p {
        case .h5: "移动端设计规范"
        case .pc: "PC 端设计规范"
        case .dashboard: "可视化大屏设计规范"
        case .electron: "Electron 端规范"
        }
    }

    private func builtinCatDesc(_ p: Platform) -> String {
        switch p {
        case .h5: "适用于移动端产品的设计规范，统一组件、手势与响应式标准。"
        case .pc: "适用于电脑端产品的设计规范，统一组件、样式与交互标准。"
        case .dashboard: "适用于数据大屏与可视化场景的设计规范，统一布局、图表与色彩标准。"
        case .electron: "适用于桌面应用的设计规范，统一窗口、菜单与原生控件标准。"
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                banner
                categoryGrid
                HStack(alignment: .top, spacing: 16) {
                    recentCard
                    howCard
                }
                statRow
            }
            .padding(20)
        }
        .navigationTitle("设计规范")
        .sheet(item: $creatingIn) { categoryId in
            SpecEditSheet(categoryId: categoryId.id, spec: nil)
        }
        .sheet(isPresented: $showGuide) { guideSheet }
        .sheet(item: $checkResult) { state in checkSheet(state) }
    }

    private var guideSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("规范使用指南").font(.headline)
            Text("三步将设计规范接入走查流程，让每一次走查都有据可依。")
                .font(.callout)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 10) {
                howStep(1, "link", "连接 Figma", "粘贴 Figma 规范链接或上传 .fig 存档，建立规范来源")
                howStep(2, "square.stack.3d.up.fill", "解析 Token", "自动提取颜色、间距、字号、圆角、阴影等设计属性")
                howStep(3, "checkmark.shield", "绑定项目自动校验", "项目绑定规范后，走查任务自动加载 Token 基线逐项校验")
            }
            Text("规范 Token 支持导出为 JSON / CSS / Tailwind 格式，可直接投入开发使用。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            HStack {
                Spacer()
                Button("知道了") { showGuide = false }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(width: 480, height: 360)
    }

    private var banner: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("让设计规范成为走查的统一标准")
                .font(.system(size: 24, weight: .bold))
            Text("支持 Figma 规范链接粘贴 / .fig 文件解析，自动提取设计 Token，并可一键同步最新版本，让走查自动校验设计合规性。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            HStack(spacing: 18) {
                feat("arrow.triangle.2.circlepath", "规范同步", "Figma 一键解析", .blue)
                feat("layeredshape.2", "Token 提取", "多端格式导出", .purple)
                feat("checkmark.circle", "走查校验", "合规自动检测", .green)
            }
            HStack {
                Spacer()
                HStack(spacing: 8) {
                    Button {
                        showGuide = true
                    } label: {
                        Label("规范使用指南", systemImage: "book")
                    }
                    Button {
                        Task { await runCheck() }
                    } label: {
                        Label(checking ? "检查中…" : "检查更新", systemImage: "arrow.triangle.2.circlepath")
                            .symbolEffect(.rotate, isActive: checking)
                    }
                    .disabled(checking)
                    Menu {
                        ForEach(sortedCategories) { c in
                            Button {
                                creatingIn = CategoryPick(id: c.id)
                            } label: {
                                Label(catName(c), systemImage: "plus")
                            }
                        }
                    } label: {
                        Label("新建规范", systemImage: "plus")
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.blue.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
    }

    private func feat(_ icon: String, _ title: String, _ sub: String, _ color: Color) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(color)
                .frame(width: 24, height: 24)
                .background(color.opacity(0.14), in: RoundedRectangle(cornerRadius: 6))
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.caption.weight(.semibold))
                Text(sub).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private var sortedCategories: [SpecCategory] {
        categories.sorted { $0.sortOrder < $1.sortOrder }
    }

    // MARK: 端分类卡

    private var categoryGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), spacing: 12)], spacing: 12) {
            ForEach(sortedCategories) { c in
                NavigationLink(value: c.id) { categoryCard(c) }
                    .buttonStyle(.plain)
            }
        }
    }

    private func categoryCard(_ c: SpecCategory) -> some View {
        let specs = specsAll.filter { $0.categoryId == c.id }
        let tokenCount = specs.reduce(0) { $0 + (latestBySpec[$1.id]?.tokenCount ?? 0) }
        let okCount = specs.filter { spec in
            guard spec.figmaFileKey != nil else { return false }
            let ts = max(latestBySpec[spec.id]?.syncedAt ?? 0, spec.lastSyncedAt ?? 0)
            return ts > 0
        }.count
        let state: (text: String, ok: Bool) = specs.isEmpty
            ? ("待创建", false)
            : (okCount == specs.count ? "同步正常" : okCount > 0 ? "部分同步" : "未同步", okCount == specs.count)
        let applied = bindings.contains { b in specs.contains { $0.id == b.specId } }
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                SpecPlatformIcon(platform: c.platformKey, size: 18)
                if applied { SpecPill(text: "已应用", tone: .ok) }
                Spacer()
            }
            Text(catName(c)).font(.headline).foregroundStyle(.primary)
            Text(c.isBuiltin ? builtinCatDesc(c.platformKey) : "团队自定义端分类，沉淀该端专属的设计规范与 Token 基线。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            HStack(spacing: 10) {
                Label("\(specs.count) 套规范", systemImage: "square.stack.3d.up")
                Text("·")
                Label("\(tokenCount) 个 Token", systemImage: "square.grid.2x2")
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            HStack {
                SyncStateDot(label: state.text, ok: state.ok)
                Spacer()
                Text("›").foregroundStyle(.tertiary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 150, alignment: .topLeading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
    }

    // MARK: 最近使用 + 指引

    /// 最近使用的规范：按最后同步/更新时间取前 5
    private var recentRows: [(spec: DesignSpec, cat: SpecCategory?, tokens: Int, ts: Double, projs: [String], synced: Bool)] {
        let catById = Dictionary(uniqueKeysWithValues: categories.map { ($0.id, $0) })
        let nameByProject = Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0.name) })
        var boundBySpec: [String: [String]] = [:]
        for b in bindings {
            guard let name = nameByProject[b.projectId] else { continue }
            boundBySpec[b.specId, default: []].append(name)
        }
        return specsAll.map { s -> (DesignSpec, SpecCategory?, Int, Double, [String], Bool) in
            let latest = latestBySpec[s.id]
            let ts = max(latest?.syncedAt ?? 0, s.updatedAt)
            return (s, catById[s.categoryId], latest?.tokenCount ?? 0, ts, boundBySpec[s.id] ?? [], s.figmaFileKey != nil && ts > 0)
        }
        .sorted { $0.3 > $1.3 }
        .prefix(5)
        .map { (spec: $0.0, cat: $0.1, tokens: $0.2, ts: $0.3, projs: $0.4, synced: $0.5) }
    }

    private var recentCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("最近使用的规范", systemImage: "clock")
                .font(.subheadline.weight(.semibold))
            if recentRows.isEmpty {
                Text("暂无规范，点击右上角「新建规范」开始")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 60)
            } else {
                VStack(spacing: 0) {
                    HStack {
                        Text("规范名称").frame(maxWidth: .infinity, alignment: .leading)
                        Text("所属项目").frame(width: 110, alignment: .leading)
                        Text("Token 数量").frame(width: 70, alignment: .leading)
                        Text("最后同步").frame(width: 100, alignment: .leading)
                        Text("状态").frame(width: 70, alignment: .leading)
                        Text("操作").frame(width: 40, alignment: .trailing)
                    }
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 4)
                    ForEach(recentRows, id: \.spec.id) { row in
                        NavigationLink(value: SpecSpecRoute(specId: row.spec.id)) {
                            HStack {
                                Text(row.spec.name).lineLimit(1)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Text(row.projs.isEmpty ? "未绑定" : row.projs.count == 1 ? row.projs[0] : "\(row.projs[0]) +\(row.projs.count - 1)")
                                    .lineLimit(1).frame(width: 110, alignment: .leading)
                                Text("\(row.tokens)").frame(width: 70, alignment: .leading)
                                Text(fmtShortTime(row.ts)).frame(width: 100, alignment: .leading)
                                Group {
                                    if row.projs.isEmpty {
                                        SyncStateDot(label: "未绑定", ok: false)
                                    } else {
                                        SyncStateDot(label: row.synced ? "同步正常" : "未同步", ok: row.synced)
                                    }
                                }
                                .frame(width: 70, alignment: .leading)
                                Text("查看").frame(width: 40, alignment: .trailing)
                            }
                            .font(.caption)
                            .foregroundStyle(.primary)
                            .padding(.vertical, 5)
                        }
                        .buttonStyle(.plain)
                        Divider()
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
    }

    private var howCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("规范如何融入走查").font(.subheadline.weight(.semibold))
            howStep(1, "link", "连接 Figma", "粘贴 Figma 规范链接或上传 .fig 存档，建立规范来源")
            howStep(2, "square.stack.3d.up.fill", "解析 Token", "自动提取颜色、间距、字号、圆角、阴影等设计属性")
            howStep(3, "checkmark.shield", "绑定项目自动校验", "项目绑定规范后，走查任务自动加载 Token 基线逐项校验")
        }
        .padding(14)
        .frame(width: 280, alignment: .topLeading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
    }

    private func howStep(_ no: Int, _ icon: String, _ title: String, _ desc: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("\(no)")
                .font(.caption2.weight(.bold))
                .frame(width: 16, height: 16)
                .background(.tint.opacity(0.14), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Label(title, systemImage: icon).font(.caption.weight(.semibold))
                Text(desc).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    // MARK: 统计条

    private var statRow: some View {
        let tokens = specsAll.reduce(0) { $0 + (latestBySpec[$1.id]?.tokenCount ?? 0) }
        let bound = Set(bindings.map(\.projectId)).count
        let connected = specsAll.filter { $0.figmaFileKey != nil }.count
        return HStack(spacing: 12) {
            statCard("layeredshape.2", String(format: "%02d", specsAll.count), "已管理规范")
            statCard("number.square", "\(tokens)", "已解析 Token")
            statCard("link", String(format: "%02d", bound), "已绑定项目")
            statCard("arrow.triangle.2.circlepath", "\(connected)/\(specsAll.count)", "同步正常")
        }
    }

    private func statCard(_ icon: String, _ value: String, _ label: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 15))
                .foregroundStyle(.tint)
                .frame(width: 30, height: 30)
                .background(.tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 1) {
                Text(value).font(.headline)
                Text(label).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
    }

    // MARK: 检查更新（逐套规范轻量比对 Figma last_modified）

    private func runCheck() async {
        checking = true
        defer { checking = false }
        let pat = SpecStore.figmaPAT()
        guard !pat.isEmpty else {
            checkResult = .noPat
            return
        }
        let withKey = specsAll.filter { $0.figmaFileKey != nil }
        do {
            let metas = withKey.isEmpty
                ? []
                : try await EngineBridge.figmaFileMeta(
                    pat: pat,
                    fileKeys: withKey.compactMap(\.figmaFileKey),
                    proxy: AppConfigStore.load().figmaProxy
                )
            var byKey: [String: EngineFileMetaDTO] = [:]
            for m in metas { byKey[m.fileKey] = m }
            var rows: [SpecCheckRow] = []
            for s in specsAll {
                let localTs = max(latestBySpec[s.id]?.syncedAt ?? 0, s.lastSyncedAt ?? 0)
                guard let key = s.figmaFileKey else {
                    rows.append(.init(spec: s, catName: catName(of: s), status: .noKey, message: nil, remoteTs: 0, localTs: localTs))
                    continue
                }
                guard let meta = byKey[key], meta.ok else {
                    rows.append(.init(spec: s, catName: catName(of: s), status: .error, message: byKey[key]?.message, remoteTs: 0, localTs: localTs))
                    continue
                }
                if localTs == 0 {
                    rows.append(.init(spec: s, catName: catName(of: s), status: .noSync, message: nil, remoteTs: meta.lastModified ?? 0, localTs: localTs))
                } else if (meta.lastModified ?? 0) > localTs {
                    rows.append(.init(spec: s, catName: catName(of: s), status: .update, message: nil, remoteTs: meta.lastModified ?? 0, localTs: localTs))
                } else {
                    rows.append(.init(spec: s, catName: catName(of: s), status: .latest, message: nil, remoteTs: meta.lastModified ?? 0, localTs: localTs))
                }
            }
            checkResult = .done(rows: rows)
        } catch {
            checkResult = .failed(error.localizedDescription)
        }
    }

    private func catName(of spec: DesignSpec) -> String {
        catName(byId: spec.categoryId)
    }

    private func catName(byId id: String) -> String {
        guard let c = categories.first(where: { $0.id == id }) else { return "—" }
        return catName(c)
    }

    private func checkSheet(_ state: SpecCheckState) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("规范版本检查").font(.headline)
            switch state {
            case .noPat:
                Text("未配置 Figma Token，请先在「MCP 服务」中配置 Figma PAT").font(.callout)
            case .failed(let msg):
                Text("检查失败：\(msg)").font(.callout).foregroundStyle(.red)
            case .done(let rows):
                if rows.isEmpty {
                    Text("暂无已关联 Figma 文件的设计规范").font(.callout)
                } else {
                    let outdated = rows.filter { $0.status == .update }.count
                    Text(outdated > 0 ? "\(outdated) 套规范有更新" : "全部 \(rows.count) 套规范均为最新版本")
                        .font(.callout.weight(.medium))
                    ScrollView {
                        VStack(spacing: 0) {
                            HStack {
                                Text("规范名称").frame(maxWidth: .infinity, alignment: .leading)
                                Text("端分类").frame(width: 110, alignment: .leading)
                                Text("检查结果").frame(width: 70, alignment: .leading)
                                Text("本地同步").frame(width: 90, alignment: .leading)
                                Text("Figma 更新").frame(width: 90, alignment: .leading)
                            }
                            .font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                            ForEach(rows) { row in
                                SpecCheckRowView(row: row)
                            }
                        }
                    }
                    .frame(minHeight: 120)
                }
            }
            HStack {
                Spacer()
                Button("知道了") { checkResult = nil }.buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(width: 560, height: 380)
    }
}

/// 新建规范 sheet 的分类 id 载体（sheet(item:) 要求 Identifiable）
private struct CategoryPick: Identifiable {
    let id: String
}

// MARK: - 检查更新状态

enum SpecCheckRowStatus: Int, Comparable {
    case update = 0, latest, noSync, noKey, error
    static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }

    var statusText: String {
        switch self {
        case .update: "有更新"
        case .latest: "已是最新"
        case .noSync: "未同步"
        case .noKey: "未关联"
        case .error: "检查失败"
        }
    }

    var statusTone: SpecPill.Tone {
        switch self {
        case .update: .warn
        case .latest: .ok
        case .noKey, .noSync: .gray
        case .error: .err
        }
    }
}

struct SpecCheckRow: Identifiable {
    var id: String { spec.id }
    let spec: DesignSpec
    let catName: String
    let status: SpecCheckRowStatus
    let message: String?
    let remoteTs: Double
    let localTs: Double
}

/// 检查结果表格行（独立子视图，规避长 ViewBuilder 表达式的类型检查发散）
private struct SpecCheckRowView: View {
    let row: SpecCheckRow

    var body: some View {
        HStack {
            Text(row.spec.name).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            Text(row.catName).lineLimit(1).frame(width: 110, alignment: .leading)
            SpecPill(text: row.status.statusText, tone: row.status.statusTone).frame(width: 70, alignment: .leading)
            Text(row.localTs > 0 ? fmtShortTime(row.localTs) : "—").frame(width: 90, alignment: .leading)
            Text(row.remoteTs > 0 ? fmtShortTime(row.remoteTs) : "—").frame(width: 90, alignment: .leading)
        }
        .font(.caption)
        .padding(.vertical, 4)
    }
}

/// 短时间格式（MM/dd HH:mm， ts 为毫秒）
private func fmtShortTime(_ ts: Double) -> String {
    guard ts > 0 else { return "—" }
    let f = DateFormatter()
    f.dateFormat = "MM/dd HH:mm"
    return f.string(from: Date(timeIntervalSince1970: ts / 1000))
}

enum SpecCheckState: Identifiable {
    case noPat
    case failed(String)
    case done(rows: [SpecCheckRow])
    var id: String { "check" }
}

// MARK: - 端分类列表页（/specs/:categoryId：该端多套规范卡片网格）

struct SpecCategoryListView: View {
    let categoryId: String
    @Query private var categories: [SpecCategory]
    @Query private var versionsAll: [SpecVersion]
    @Query private var bindings: [ProjectSpecBinding]
    @State private var creating = false

    @Query private var specs: [DesignSpec]

    init(categoryId: String) {
        self.categoryId = categoryId
        _specs = Query(filter: #Predicate<DesignSpec> { $0.categoryId == categoryId })
    }

    private var category: SpecCategory? {
        categories.first { $0.id == categoryId }
    }

    private func catName(_ c: SpecCategory) -> String {
        switch c.platformKey {
        case .h5: "移动端设计规范"
        case .pc: "PC 端设计规范"
        case .dashboard: "可视化大屏设计规范"
        case .electron: "Electron 端规范"
        }
    }

    private func builtinDesc(_ p: Platform) -> String {
        switch p {
        case .h5: "适用于移动端产品的设计规范，统一组件、手势与响应式标准。"
        case .pc: "适用于电脑端产品的设计规范，统一组件、样式与交互标准。"
        case .dashboard: "适用于数据大屏与可视化场景的设计规范，统一布局、图表与色彩标准。"
        case .electron: "适用于桌面应用的设计规范，统一窗口、菜单与原生控件标准。"
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let category {
                    header
                }
                if specs.isEmpty {
                    emptyState
                } else {
                    grid
                }
            }
            .padding(20)
        }
        .navigationTitle(category.map { $0.isBuiltin ? catName($0) : $0.name } ?? "设计规范")
        .toolbar {
            Button {
                creating = true
            } label: {
                Label("新建规范", systemImage: "plus")
            }
        }
        .sheet(isPresented: $creating) {
            SpecEditSheet(categoryId: categoryId, spec: nil)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                SpecPlatformIcon(platform: category?.platformKey ?? .pc, size: 18)
                Text(category.map { $0.isBuiltin ? catName($0) : $0.name } ?? "")
                    .font(.system(size: 22, weight: .bold))
            }
            Text(category.map { $0.isBuiltin ? builtinDesc($0.platformKey) : "团队自定义端分类，沉淀该端专属的设计规范与 Token 基线。" } ?? "")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(.blue.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Text("该端还没有规范").font(.headline)
            Text("创建规范并连接 Figma，即可同步 Token 作为走查基线")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("新建规范") { creating = true }
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, minHeight: 180)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
    }

    private var sortedSpecs: [DesignSpec] {
        specs.sorted { $0.createdAt < $1.createdAt }
    }

    private var grid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 250), spacing: 12)], spacing: 12) {
            ForEach(sortedSpecs) { s in
                NavigationLink(value: SpecSpecRoute(specId: s.id)) { card(s) }
                    .buttonStyle(.plain)
            }
        }
    }

    private func card(_ s: DesignSpec) -> some View {
        let latest = versionsAll.filter { $0.specId == s.id }.max { $0.no < $1.no }
        let verCount = versionsAll.filter { $0.specId == s.id }.count
        let connected = s.figmaFileKey != nil && max(latest?.syncedAt ?? 0, s.lastSyncedAt ?? 0) > 0
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "square.stack.3d.up.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(.tint)
                if let latest { SpecPill(text: "V\(latest.no)") }
                Spacer()
            }
            Text(s.name).font(.headline).foregroundStyle(.primary).lineLimit(1)
            Text(s.figFileName ?? "未关联 Figma 文件")
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            HStack(spacing: 10) {
                Label("\(verCount) 个版本", systemImage: "clock")
                Text("·")
                Label("\(latest?.tokenCount ?? 0) 个 Token", systemImage: "number.square")
            }
            .font(.caption2).foregroundStyle(.secondary)
            HStack {
                SyncStateDot(label: connected ? "同步正常" : "未同步", ok: connected)
                Spacer()
                Text("›").foregroundStyle(.tertiary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 140, alignment: .topLeading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
    }
}
