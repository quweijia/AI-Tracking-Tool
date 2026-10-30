import SwiftUI
import SwiftData
import AppKit

// MARK: - 规范详情页（/specs/:categoryId/spec/:specId）
// 横幅（编辑/删除 + 导出 Token 菜单 + 同步 Figma）、来源卡（链接验证 / .fig 存档 / JSON 导入 + 连接状态）、
// 当前版本卡、Design Token 卡（类别/层级左栏 + 多模式并列表格 + 点击复制）、项目绑定卡、历史版本抽屉。

// MARK: - Token 深浅模式派生（对齐 SpecCategoryPage nameMode / splitModeOf）

/// 深浅模式命名识别：中文 浅色/亮色/日间 → light，深色/暗色/夜间 → dark；英文按词边界 light/dark（兼容驼峰/lightmode）
private func specNameMode(_ name: String) -> String? {
    if name.range(of: "浅色|亮色|日间", options: .regularExpression) != nil { return "light" }
    if name.range(of: "深色|暗色|夜间", options: .regularExpression) != nil { return "dark" }
    // 驼峰拆词后小写，词边界匹配避免 highlight/darken 误判
    var lower = ""
    for (i, ch) in name.enumerated() {
        if i > 0, ch.isUppercase, name[name.index(name.startIndex, offsetBy: i - 1)].isLowercase {
            lower.append(" ")
        }
        lower.append(ch)
    }
    lower = lower.lowercased()
    if lower.range(of: "(^|[^a-z])light([^a-z]|$)") != nil || lower.contains("lightmode") { return "light" }
    if lower.range(of: "(^|[^a-z])dark([^a-z]|$)") != nil || lower.contains("darkmode") { return "dark" }
    return nil
}

/// Token 深浅视图：mode 字段优先；无 mode 时从 path 各段派生，并剔除模式段得基础路径
private func splitModeOf(_ tok: SpecToken) -> (mode: String, basePath: String) {
    if let mode = tok.mode { return (mode, tok.path) }
    var kept: [String] = []
    var mode: String?
    for seg in tok.path.split(separator: "/").map(String.init) {
        if let m = specNameMode(seg) {
            if mode == nil { mode = m }
            continue
        }
        kept.append(seg)
    }
    if let mode { return (mode, kept.joined(separator: "/")) }
    return ("", tok.path)
}

// MARK: - 规范详情视图

struct SpecDetailView: View {
    let specId: String

    @Environment(\.modelContext) private var ctx
    @Query private var specsAll: [DesignSpec]
    @Query private var categories: [SpecCategory]
    @Query private var versionsAll: [SpecVersion]
    @Query private var tokensAll: [SpecToken]
    @Query private var bindingsAll: [ProjectSpecBinding]
    @Query private var projects: [Project]

    // 本地状态
    @State private var srcTab: SrcTab = .url
    @State private var urlDraft = ""
    @State private var verifyMsg: (ok: Bool, text: String)?
    @State private var kindFilter: TokenKind?
    @State private var pathFilter: String?
    @State private var tierFilter: String?
    @State private var query = ""
    @State private var syncing = false
    @State private var syncOk: SpecSyncOutcome?
    @State private var syncErr: String?
    @State private var exportMsg: (ok: Bool, text: String)?
    @State private var importing = false
    @State private var importMsg: (ok: Bool, text: String)?
    @State private var copiedId = ""
    @State private var editing = false
    @State private var showHist = false
    @State private var histVerId = ""
    @State private var refPop: SpecToken?
    @State private var modeAskKind: ModeAskKind?
    @State private var deleteConfirm: DeleteConfirmKind?

    enum SrcTab: String, CaseIterable {
        case url, fig, json
        var label: String {
            switch self {
            case .url: "Figma 链接"
            case .fig: "上传 .fig"
            case .json: "JSON 导入"
            }
        }
    }

    /// 导入模式选择（同步 / JSON 导入共用）
    enum ModeAskKind: Identifiable {
        case sync, importJSON
        var id: String { "mode-\(self == .sync ? "sync" : "import")" }
    }

    enum DeleteConfirmKind: Identifiable {
        case spec
        var id: String { "delete-spec" }
    }

    // MARK: 派生数据

    private var spec: DesignSpec? { specsAll.first { $0.id == specId } }
    private var category: SpecCategory? { spec.flatMap { s in categories.first { $0.id == s.categoryId } } }
    private var versions: [SpecVersion] { versionsAll.filter { $0.specId == specId }.sorted { $0.no > $1.no } }
    private var latest: SpecVersion? { versions.first }
    private var tokens: [SpecToken] {
        guard let latest else { return [] }
        return tokensAll.filter { $0.versionId == latest.id }.sorted { ($0.sortNo ?? 0) < ($1.sortNo ?? 0) }
    }
    private var histTokens: [SpecToken] {
        guard !histVerId.isEmpty else { return [] }
        return tokensAll.filter { $0.versionId == histVerId }.sorted { ($0.sortNo ?? 0) < ($1.sortNo ?? 0) }
    }
    private var boundCount: Int { bindingsAll.filter { $0.specId == specId }.count }

    /// 应用徽标：本分类任一规范被绑定
    private var applied: Bool {
        guard let spec else { return false }
        let catSpecIds = Set(specsAll.filter { $0.categoryId == spec.categoryId }.map(\.id))
        return bindingsAll.contains { catSpecIds.contains($0.specId) }
    }

    /// 是否三层 Token 体系数据（任一 token 带层级即启用层级菜单）
    private var hasTiers: Bool { tokens.contains { $0.tier != nil && !($0.tier ?? "").isEmpty } }

    /// Token 深浅视图缓存（id → mode/basePath）
    private var modeView: [String: (mode: String, basePath: String)] {
        Dictionary(uniqueKeysWithValues: tokens.map { ($0.id, splitModeOf($0)) })
    }

    /// 各类别计数
    private var countByKind: [TokenKind: Int] {
        var m: [TokenKind: Int] = [:]
        for t in tokens { m[t.kind, default: 0] += 1 }
        return m
    }

    /// 层级计数（保持导入首次出现序）
    private var tierCounts: [(tier: String, count: Int)] {
        var m: [String: Int] = [:]
        for t in tokens { m[t.tier ?? ""] = (m[t.tier ?? ""] ?? 0) + 1 }
        return m.map { ($0.key, $0.value) }
    }

    private var kindList: [TokenKind] { [.color, .spacing, .fontSize, .lineHeight, .radius, .shadow, .border] }

    /// 过滤后的 Token（层级/类别 + 分组 + 关键词）
    private var filtered: [SpecToken] {
        let mv = modeView
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return tokens.filter { tok in
            if hasTiers {
                if tierFilter != nil, (tok.tier ?? "") != tierFilter { return false }
            } else if let kf = kindFilter, tok.kind != kf {
                return false
            }
            if let pf = pathFilter {
                let bp = mv[tok.id]?.basePath ?? tok.path
                if bp != pf && !bp.hasPrefix("\(pf)/") { return false }
            }
            if q.isEmpty { return true }
            return tok.name.lowercased().contains(q)
                || tok.path.lowercased().contains(q)
                || tok.value.lowercased().contains(q)
                || (tok.tokenDescription ?? "").lowercased().contains(q)
        }
    }

    /// 表格并列模式列（浅/深同时存在固定两列，否则全部模式；无模式退化为单值列）
    private var modeColumns: [String?] {
        let mv = modeView
        var modes: [String] = []
        for tok in filtered {
            let m = mv[tok.id]?.mode ?? ""
            if !m.isEmpty, !modes.contains(m) { modes.append(m) }
        }
        let light = modes.first { specNameMode($0) == "light" }
        let dark = modes.first { specNameMode($0) == "dark" }
        if let light, let dark { return [light, dark] }
        return modes.isEmpty ? [nil] : modes.map { Optional($0) }
    }

    /// 表格平铺行：同名多模式并列（基础路径 + 名称聚合）
    struct TokenRow: Identifiable {
        let id: String
        let name: String
        let path: String
        var byMode: [(mode: String, tok: SpecToken)]
    }

    private var flatRows: [TokenRow] {
        let mv = modeView
        var rows: [TokenRow] = []
        var map: [String: TokenRow] = [:]
        for tok in filtered {
            let mvv = mv[tok.id]
            let basePath = mvv?.basePath ?? tok.path
            let key = "\(basePath)\u{0}\(tok.name)"
            if var row = map[key] {
                row.byMode.append((mvv?.mode ?? tok.mode ?? "", tok))
                map[key] = row
                if let idx = rows.firstIndex(where: { $0.id == key }) { rows[idx] = row }
            } else {
                let row = TokenRow(id: key, name: tok.name, path: basePath, byMode: [(mvv?.mode ?? tok.mode ?? "", tok)])
                map[key] = row
                rows.append(row)
            }
        }
        return rows
    }

    /// 左侧分组树节点（按 "/" 逐段编组，深浅模式段已剔除）
    final class SideNode: Identifiable {
        let seg: String
        var kids: [SideNode] = []
        var own = 0
        var total = 0
        let keyPath: String
        init(seg: String, keyPath: String) {
            self.seg = seg
            self.keyPath = keyPath
        }
        var id: String { keyPath }
    }

    private func buildSideTree() -> [SideNode] {
        let mv = modeView
        let src: [SpecToken]
        if hasTiers {
            guard let tf = tierFilter else { return [] }
            src = tokens.filter { ($0.tier ?? "") == tf }
        } else {
            guard let kf = kindFilter else { return [] }
            src = tokens.filter { $0.kind == kf }
        }
        var root = SideNode(seg: "", keyPath: "")
        for tok in src {
            let segs = (mv[tok.id]?.basePath ?? tok.path)
                .split(separator: "/").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            var node = root
            for seg in segs {
                let parentKey = node.keyPath
                let key = parentKey.isEmpty ? seg : "\(parentKey)/\(seg)"
                if let idx = node.kids.firstIndex(where: { $0.seg == seg }) {
                    node = node.kids[idx]
                    continue
                }
                let kid = SideNode(seg: seg, keyPath: key)
                node.kids.append(kid)
                node = kid
            }
            node.own += 1
        }
        func fill(_ n: SideNode) -> Int {
            n.total = n.own + n.kids.reduce(0) { $0 + fill($1) }
            return n.total
        }
        for k in root.kids { _ = fill(k) }
        return root.kids
    }

    /// 参与导出的 Token（排除启发式来源与损坏值）
    private var exportList: [[String: Any]] {
        tokens.compactMap { tok -> [String: Any]? in
            guard tok.source != .heuristic, let v = tok.tokenValue else { return nil }
            guard let data = try? JSONEncoder().encode(v), let obj = try? JSONSerialization.jsonObject(with: data) else { return nil }
            return ["kind": tok.kind.rawValue, "name": tok.name, "path": tok.path, "value": obj]
        }
    }

    /// 连接状态三态
    private var connState: (text: String, ok: Bool?) {
        guard let spec else { return ("未连接", nil) }
        if spec.figmaFileKey == nil { return ("未连接", nil) }
        let hasPat = !SpecStore.figmaPAT().isEmpty
        return hasPat ? ("连接正常", true) : ("未配置访问令牌", false)
    }

    // MARK: Body

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let spec {
                    hero(spec)
                    statusBar
                    topGrid(spec)
                    tokenCard
                    bindCard
                }
            }
            .padding(20)
        }
        .navigationTitle(spec?.name ?? "规范详情")
        .onAppear {
            if let spec { urlDraft = spec.figmaUrl ?? "" }
        }
        .onChange(of: specId) {
            if let spec { urlDraft = spec.figmaUrl ?? "" }
        }
        .sheet(isPresented: $editing) {
            if let spec { SpecEditSheet(categoryId: spec.categoryId, spec: spec) }
        }
        .sheet(isPresented: $showHist) { historyDrawer }
        .sheet(item: $modeAskKind) { kind in
            ModeAskSheet(kind: kind) { mode in
                handleModePicked(kind: kind, mode: mode)
            }
        }
        .alert("删除规范", isPresented: Binding(get: { deleteConfirm != nil }, set: { if !$0 { deleteConfirm = nil } })) {
            Button("取消", role: .cancel) { deleteConfirm = nil }
            Button("删除", role: .destructive) { deleteSpec() }
        } message: {
            Text("确定删除规范「\(spec?.name ?? "")」？其全部历史版本、Token 与项目绑定将一并删除。")
        }
        .popover(item: $refPop, arrowEdge: .edge) { tok in refPopover(tok) }
    }

    // MARK: 横幅

    private func hero(_ spec: DesignSpec) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    if let category {
                        SpecPlatformIcon(platform: category.platformKey, size: 20)
                    }
                    Text(spec.name).font(.system(size: 22, weight: .bold))
                    Button { editing = true } label: {
                        Image(systemName: "pencil").font(.system(size: 12))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    Button { deleteConfirm = .spec } label: {
                        Image(systemName: "trash").font(.system(size: 12))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                }
                if applied {
                    HStack(spacing: 3) {
                        Image(systemName: "checkmark").font(.system(size: 10, weight: .bold))
                        Text("已应用").font(.caption2)
                    }
                    .foregroundStyle(.green)
                }
            }
            Spacer()
            HStack(spacing: 8) {
                Menu {
                    Button("JSON（tokens.json）") { Task { await exportTokens("json", "tokens.json") } }
                    Button("CSS（tokens.css）") { Task { await exportTokens("css", "tokens.css") } }
                    Button("Tailwind（tailwind.tokens.js）") { Task { await exportTokens("tailwind", "tailwind.tokens.js") } }
                } label: {
                    Label("导出 Token", systemImage: "square.and.arrow.up")
                }
                Button {
                    Task { await askAndSync() }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .symbolEffect(.rotate, isActive: syncing)
                        Text("同步 Figma")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(syncing)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.blue.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
    }

    // MARK: 状态条（同步结果 / 降级透明化 / 导出与导入反馈）

    @ViewBuilder
    private var statusBar: some View {
        if syncing {
            statusBanner("正在同步 Figma Token…", color: .secondary)
        } else if let syncOk {
            statusBanner(
                "同步完成 · V\(syncOk.versionNo) · \(syncOk.tokenCount) 个 Token · \(syncOk.summary)\(syncOk.sourceLevel.isEmpty ? "" : " · \(sourceLabel(syncOk.sourceLevel))")",
                color: .green
            )
            if let degraded = syncOk.degraded, !degraded.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("本次同步发生降级：").font(.caption.weight(.bold)).foregroundStyle(.orange)
                    ForEach(Array(degraded.enumerated()), id: \.offset) { _, d in
                        Text("· [\(sourceLabel(d.level))] \(d.reason)\(d.hint.map { " — \($0)" } ?? "")")
                            .font(.caption).foregroundStyle(.orange)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }
        } else if let syncErr {
            statusBanner("同步失败：\(syncErr)", color: .red)
        }
        if let exportMsg {
            statusBanner(exportMsg.text, color: exportMsg.ok ? .green : .red)
        }
        if let importMsg {
            statusBanner(importMsg.text, color: importMsg.ok ? .green : .red)
        }
    }

    private func statusBanner(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(color)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }

    private func sourceLabel(_ level: String) -> String {
        switch level {
        case "variable": "变量"
        case "style": "样式"
        case "heuristic": "启发式"
        default: level
        }
    }

    // MARK: 顶部两卡（来源 + 当前版本）

    private func topGrid(_ spec: DesignSpec) -> some View {
        HStack(alignment: .top, spacing: 16) {
            sourceCard(spec)
                .frame(maxWidth: .infinity)
            versionCard
                .frame(width: 300)
        }
    }

    private func sourceCard(_ spec: DesignSpec) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("规范来源").font(.headline)
                    Text("支持粘贴同步 Figma 文件，或上传本地 .fig 文件解析")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Picker("", selection: $srcTab) {
                    ForEach(SrcTab.allCases, id: \.self) { t in
                        Text(t.label).tag(t)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 260)
                .labelsHidden()
            }
            switch srcTab {
            case .url:
                HStack(spacing: 8) {
                    Image(systemName: "link").foregroundStyle(.secondary)
                    TextField("https://www.figma.com/file/…", text: $urlDraft)
                        .textFieldStyle(.roundedBorder)
                    Button("验证链接") { verifyLink(spec) }
                }
                if let verifyMsg {
                    Text(verifyMsg.text)
                        .font(.caption)
                        .foregroundStyle(verifyMsg.ok ? .green : .red)
                }
            case .fig:
                HStack(spacing: 8) {
                    Button("上传 .fig 存档") { uploadFig(spec) }
                    Text(spec.figArchivePath.map { ".fig 存档 · \(($0 as NSString).lastPathComponent)" } ?? "未上传 .fig 存档")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            case .json:
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Button(importing ? "导入中…" : "导入 Token JSON") { Task { await pickAndImportJSON() } }
                            .disabled(importing)
                        Text("支持 Figma REST 同构 / Tokens Studio / W3C DTCG，多文件三层体系与别名解析")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            // 连接状态行
            HStack(spacing: 10) {
                Text("DS")
                    .font(.caption.weight(.bold))
                    .frame(width: 28, height: 28)
                    .background(.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 7))
                VStack(alignment: .leading, spacing: 1) {
                    Text(spec.figFileName ?? spec.name).font(.caption.weight(.semibold)).lineLimit(1)
                    Text(latest.map { "V\($0.no) · \(tokens.count) 个 Token" } ?? "未同步")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                HStack(spacing: 4) {
                    Circle()
                        .fill(connState.ok == true ? Color.green : connState.ok == false ? Color.orange : Color.secondary.opacity(0.5))
                        .frame(width: 6, height: 6)
                    Text(connState.text).font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(10)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
    }

    private var versionCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("当前版本").font(.headline)
                Spacer()
                if latest != nil {
                    SpecPill(text: "已是最新", tone: .ok)
                } else {
                    SpecPill(text: "暂无版本")
                }
            }
            Button {
                showHist = true
            } label: {
                Text(latest.map { "V\($0.no)" } ?? "—")
                    .font(.system(size: 26, weight: .bold, design: .rounded))
                    .foregroundStyle(.tint)
            }
            .buttonStyle(.plain)
            HStack(spacing: 0) {
                statBlock("\(tokens.count)", "Token 数")
                Divider().frame(height: 26)
                statBlock("\(versions.count)", "历史版本")
                Divider().frame(height: 26)
                statBlock("\(boundCount)", "绑定项目")
            }
            .frame(maxWidth: .infinity)
            HStack {
                Text("上次同步").font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Text(latest.map { fmtTime($0.syncedAt) } ?? "未同步")
                    .font(.caption2.weight(.medium))
            }
        }
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
    }

    private func statBlock(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.headline)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: Token 卡

    private var tokenCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Design Token").font(.headline)
                    Text("自动映射 Figma Variables、Styles 与组件基础属性")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                TextField("搜索 Token 名称 / 值 / 路径…", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 240)
            }
            if latest == nil {
                Text("暂无 Token，点击右上角「同步 Figma」从 Figma 提取")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 80)
            } else {
                HStack(alignment: .top, spacing: 0) {
                    sidebar
                    Divider()
                    tokenTable
                }
                .frame(height: 420)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.quaternary))
            }
        }
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
    }

    /// 左栏：三层体系（tier）或 7 类（kind）+ 计数 + 分组树
    private var sidebar: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                sideButton(title: "全部", count: tokens.count, active: hasTiers ? tierFilter == nil : kindFilter == nil) {
                    tierFilter = nil
                    kindFilter = nil
                    pathFilter = nil
                }
                if hasTiers {
                    ForEach(tierCounts, id: \.tier) { item in
                        sideButton(
                            title: item.tier.isEmpty ? "未分层" : item.tier,
                            count: item.count,
                            active: tierFilter == item.tier
                        ) {
                            if tierFilter == item.tier {
                                if pathFilter != nil { pathFilter = nil } else { tierFilter = nil }
                            } else {
                                tierFilter = item.tier
                                pathFilter = nil
                            }
                        }
                    }
                    if tierFilter != nil {
                        sideTreeNodes(buildSideTree(), depth: 0)
                    }
                } else {
                    ForEach(kindList, id: \.rawValue) { k in
                        sideButton(
                            title: kindLabel(k),
                            count: countByKind[k] ?? 0,
                            active: kindFilter == k
                        ) {
                            if kindFilter == k {
                                if pathFilter != nil { pathFilter = nil } else { kindFilter = nil }
                            } else {
                                kindFilter = k
                                pathFilter = nil
                            }
                        }
                    }
                    if kindFilter != nil {
                        sideTreeNodes(buildSideTree(), depth: 0)
                    }
                }
            }
            .padding(8)
        }
        .frame(width: 210)
    }

    private func sideButton(title: String, count: Int, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).lineLimit(1)
                Spacer()
                Text("\(count)").font(.caption2).foregroundStyle(.secondary)
            }
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(active ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(active ? Color.accentColor : .primary)
    }

    /// 递归分组树（点名称过滤该组含子级，再点取消；子树默认全展开，对齐 Electron 版）
    @ViewBuilder
    private func sideTreeNodes(_ nodes: [SideNode], depth: Int) -> some View {
        ForEach(nodes) { node in
            Button {
                pathFilter = pathFilter == node.keyPath ? nil : node.keyPath
            } label: {
                HStack {
                    Text(node.seg).lineLimit(1)
                    Spacer()
                    Text("\(node.total)").font(.caption2).foregroundStyle(.secondary)
                }
                .font(.caption)
                .padding(.leading, CGFloat(12 + depth * 14))
                .padding(.trailing, 8)
                .padding(.vertical, 4)
                .background(pathFilter == node.keyPath ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(pathFilter == node.keyPath ? Color.accentColor : .primary)
            sideTreeNodes(node.kids, depth: depth + 1)
        }
    }

    /// Token 表格：名称 + 各模式值列（点击复制 / 引用弹层）
    private var tokenTable: some View {
        let cols = modeColumns
        return VStack(spacing: 0) {
            HStack(spacing: 0) {
                Text("TOKEN 名称")
                    .frame(maxWidth: .infinity, alignment: .leading)
                ForEach(Array(cols.enumerated()), id: \.offset) { _, m in
                    Text(m.map { modeHead($0) } ?? "值")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.quaternary.opacity(0.4))
            Divider()
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(flatRows) { row in
                        HStack(spacing: 0) {
                            Text(row.name)
                                .font(.caption.weight(.medium))
                                .lineLimit(1)
                                .help(row.path.isEmpty ? row.name : "\(row.path)/\(row.name)")
                                .frame(maxWidth: .infinity, alignment: .leading)
                            ForEach(Array(cols.enumerated()), id: \.offset) { _, m in
                                modeCellView(row: row, mode: m)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        Divider().opacity(0.5)
                    }
                    if flatRows.isEmpty {
                        Text("无匹配 Token").font(.caption).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 60)
                    }
                }
            }
        }
    }

    private func modeHead(_ m: String) -> String {
        let cols = modeColumns.compactMap { $0 }
        let light = cols.first { specNameMode($0) == "light" }
        let dark = cols.first { specNameMode($0) == "dark" }
        if let light, light == m { return "浅色" }
        if let dark, dark == m { return "深色" }
        return m
    }

    /// 取一行在指定模式列的 token；无模式 Token 视为模式无关值回填首列
    private func modeCellToken(row: TokenRow, mode: String?) -> SpecToken? {
        guard let mode else { return row.byMode.first?.tok }
        if let hit = row.byMode.first(where: { $0.mode == mode }) { return hit.tok }
        if let bare = row.byMode.first(where: { $0.mode.isEmpty }), mode == modeColumns.first ?? nil {
            return bare.tok
        }
        return nil
    }

    @ViewBuilder
    private func modeCellView(row: TokenRow, mode: String?) -> some View {
        let tok = modeCellToken(row: row, mode: mode)
        Group {
            if let tok {
                if let aliasRef = tok.aliasRef, !aliasRef.isEmpty {
                    Button {
                        refPop = tok
                    } label: {
                        HStack(spacing: 3) {
                            Image(systemName: "arrow.up.right.square").font(.system(size: 9))
                            Text(refLeaf(aliasRef)).lineLimit(1)
                        }
                        .font(.caption)
                        .foregroundStyle(.tint)
                    }
                    .buttonStyle(.plain)
                    .help("引用自 \(aliasRef) · 点击查看解析值")
                } else if let v = tok.tokenValue {
                    Button {
                        copyToken(tok)
                    } label: {
                        HStack(spacing: 5) {
                            if case .color(let hex) = v { TokenSwatch(hex: hex) }
                            Text(copiedId == tok.id ? "已复制" : v.displayText)
                                .font(.system(size: 11, design: .monospaced))
                                .lineLimit(1)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.primary)
                    .help("\(v.displayText) · 复制")
                } else {
                    Text("—").font(.caption).foregroundStyle(.tertiary)
                }
            } else {
                Text("—").font(.caption).foregroundStyle(.clear)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func refLeaf(_ ref: String) -> String {
        let segs = ref.split(whereSeparator: { $0 == "." || $0 == "/" })
        return segs.last.map(String.init) ?? ref
    }

    private func kindLabel(_ k: TokenKind) -> String {
        switch k {
        case .color: "颜色"
        case .spacing: "间距"
        case .fontSize: "字号"
        case .lineHeight: "行高"
        case .radius: "圆角"
        case .shadow: "阴影"
        case .border: "边框"
        }
    }

    // MARK: 项目绑定卡

    private var bindCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("项目绑定").font(.headline)
                Text("一个项目只能绑定一套规范，后续再走查任务将自动加载对应 Token")
                    .font(.caption).foregroundStyle(.secondary)
            }
            let matched = matchedProjects
            if matched.isEmpty {
                Text("暂无匹配当前端的项目").font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 50)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 12)], spacing: 12) {
                    ForEach(matched) { p in bindCardRow(p) }
                }
            }
        }
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
    }

    /// 匹配分类端的项目（走查按页面端自动取套）
    private var matchedProjects: [Project] {
        guard let category else { return [] }
        return projects
            .filter { $0.platform.contains(category.platformKey) }
            .sorted { $0.sortOrder < $1.sortOrder }
    }

    private func bindCardRow(_ p: Project) -> some View {
        let mine = bindingsAll.contains { $0.projectId == p.id && $0.specId == specId }
        let catSpecIds = Set(specsAll.filter { $0.categoryId == spec.flatMap { s in categories.first { $0.id == s.categoryId } }?.categoryId }.map(\.id))
        let other = bindingsAll.first { $0.projectId == p.id && $0.specId != specId && catSpecIds.contains($0.specId) }
        let otherName = other.flatMap { o in specsAll.first { $0.id == o.specId } }?.name ?? "—"
        let pill: (String, SpecPill.Tone) = mine
            ? ("已绑定", .ok)
            : other != nil ? ("已绑其他", .warn) : ("待绑定", .gray)
        let desc = mine
            ? "走查任务将自动加载本规范的 Token 基线"
            : other != nil ? "当前绑定的是「\(otherName)」，可一键更换为本规范" : "尚未绑定规范，绑定后走查任务自动加载 Token"
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ProjectLogoView(project: p, size: 30)
                Text(p.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                SpecPill(text: pill.0, tone: pill.1)
            }
            Text(desc).font(.caption2).foregroundStyle(.secondary)
            HStack {
                Spacer()
                if mine {
                    Button("解绑") { unbind(projectId: p.id) }.buttonStyle(.bordered)
                } else if other != nil {
                    Button("更换为本规范") { bind(projectId: p.id) }.buttonStyle(.bordered)
                } else {
                    Button("绑定规范") { bind(projectId: p.id) }
                        .buttonStyle(.borderedProminent)
                }
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
    }

    private func bind(projectId: String) {
        guard let spec else { return }
        let catSpecIds = Set(specsAll.filter { $0.categoryId == spec.categoryId }.map(\.id))
        for b in bindingsAll where b.projectId == projectId && catSpecIds.contains(b.specId) {
            ctx.delete(b)
        }
        ctx.insert(ProjectSpecBinding(projectId: projectId, specId: spec.id))
        try? ctx.save()
    }

    private func unbind(projectId: String) {
        for b in bindingsAll where b.projectId == projectId && b.specId == specId {
            ctx.delete(b)
        }
        try? ctx.save()
    }

    // MARK: 历史版本抽屉

    private var historyDrawer: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("历史版本").font(.headline)
                Spacer()
                Button {
                    showHist = false
                    histVerId = ""
                } label: {
                    Image(systemName: "xmark").font(.system(size: 12))
                }
                .buttonStyle(.plain)
            }
            .padding(14)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if versions.isEmpty {
                        Text("未同步").font(.caption).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 60)
                    }
                    ForEach(versions) { v in
                        versionRow(v)
                    }
                }
                .padding(14)
            }
        }
        .frame(width: 520, height: 560)
        .background(.background.secondary)
    }

    private func versionRow(_ v: SpecVersion) -> some View {
        let isCurrent = latest?.id == v.id
        let expanded = histVerId == v.id
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                histVerId = expanded ? "" : v.id
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    Text("V\(v.no)").font(.subheadline.weight(.bold))
                    if isCurrent { SpecPill(text: "当前生效", tone: .ok) }
                    Spacer()
                    Text(fmtTime(v.syncedAt)).font(.caption2).foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Text("\(v.tokenCount) 个 Token\(v.summary.map { " · \($0)" } ?? "")")
                .font(.caption2).foregroundStyle(.secondary)
            if !isCurrent {
                HStack(spacing: 12) {
                    Button("回滚到此版本") { rollback(v) }.buttonStyle(.link)
                    Button("删除", role: .destructive) { deleteVer(v) }
                        .font(.caption)
                }
            }
            if expanded {
                VStack(alignment: .leading, spacing: 4) {
                    if histTokens.isEmpty {
                        Text("该版本暂无 Token 数据").font(.caption2).foregroundStyle(.secondary)
                    }
                    ForEach(histTokens) { tk in
                        HStack(spacing: 8) {
                            Text(kindLabel(tk.kind))
                                .font(.caption2)
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(.quaternary, in: Capsule())
                            Text(tk.name + (tk.mode.map { " · \($0)" } ?? ""))
                                .font(.caption).lineLimit(1)
                            Spacer()
                            Text(tk.tokenValue?.displayText ?? tk.value)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
                .padding(8)
                .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
            }
            Divider()
        }
    }

    // MARK: 引用弹层

    private func refPopover(_ tok: SpecToken) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("引用自").font(.caption2).foregroundStyle(.secondary)
            Text(tok.aliasRef ?? "—")
                .font(.system(size: 11, design: .monospaced))
                .lineLimit(2)
            if let v = tok.tokenValue {
                HStack(spacing: 5) {
                    if case .color(let hex) = v { TokenSwatch(hex: hex) }
                    Text(v.displayText).font(.system(size: 11, design: .monospaced))
                }
            } else {
                Text("—").font(.system(size: 11, design: .monospaced))
            }
        }
        .padding(10)
        .frame(width: 300)
    }

    // MARK: 动作

    private func fmtTime(_ ts: Double) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy/MM/dd HH:mm:ss"
        return f.string(from: Date(timeIntervalSince1970: ts / 1000))
    }

    private func copyToken(_ tok: SpecToken) {
        guard let v = tok.tokenValue else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(v.displayText, forType: .string)
        copiedId = tok.id
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            if copiedId == tok.id { copiedId = "" }
        }
    }

    /// 链接验证：file key 提取成功即保存回填
    private func verifyLink(_ spec: DesignSpec) {
        let url = urlDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let key = extractFigmaFileKey(url) else {
            verifyMsg = (false, "链接格式不正确，需为 Figma 文件/设计/原型链接")
            return
        }
        spec.figmaUrl = url
        spec.figmaFileKey = key
        spec.updatedAt = nowMs()
        try? ctx.save()
        verifyMsg = (true, "链接有效，已保存")
    }

    /// .fig 存档：选择文件复制进数据目录 specs/（仅存档不解析，对齐 spec:importFig IPC）
    private func uploadFig(_ spec: DesignSpec) {
        let panel = NSOpenPanel()
        panel.title = "选择 .fig 文件"
        panel.allowedContentTypes = []
        panel.allowsOtherFileTypes = true
        panel.allowedFileTypes = ["fig"]
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let dir = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("UITWalkthrough/specs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let base = url.lastPathComponent
        let fileName = "fig-\(UUID().uuidString.prefix(8))-\(base)"
        let dest = dir.appendingPathComponent(fileName)
        try? FileManager.default.copyItem(at: url, to: dest)
        spec.figArchivePath = "specs/\(fileName)"
        try? ctx.save()
    }

    /// 同步前询问导入模式（无历史直接叠加；有历史弹选择）
    private func askAndSync() async {
        if versions.isEmpty {
            await doSync(mode: .merge)
        } else {
            modeAskKind = .sync
        }
    }

    private func handleModePicked(kind: ModeAskKind, mode: SpecImportMode?) {
        guard let mode else { return }
        switch kind {
        case .sync:
            Task { await doSync(mode: mode) }
        case .importJSON:
            Task { await importJSON(mode: mode) }
        }
    }

    /// 一键同步：引擎三级解析 → 入库；变量级 403 询问是否改同步样式
    private func doSync(mode: SpecImportMode, startLevel: String? = nil) async {
        guard let spec, !syncing else { return }
        syncing = true
        syncOk = nil
        syncErr = nil
        defer { syncing = false }
        do {
            let res = try await SpecStore.syncFromFigma(ctx, spec: spec, mode: mode, startLevel: startLevel)
            if res.variableDenied == true {
                let ask = NSAlert()
                ask.messageText = "当前 Figma 令牌无「读取变量」权限（变量 API 为 Enterprise 套餐专属），无法导入自建 Token（变量）。\n\n是否改为同步样式？样式包含颜色 / 文字 / 效果等规范数据。"
                ask.addButton(withTitle: "改为同步样式")
                ask.addButton(withTitle: "取消")
                if ask.runModal() == .alertFirstButtonReturn {
                    syncing = true
                    defer { syncing = false }
                    let res2 = try await SpecStore.syncFromFigma(ctx, spec: spec, mode: mode, startLevel: "style")
                    syncOk = res2
                } else {
                    syncErr = "已取消同步。可改用「JSON 导入」导入变量插件导出的自建 Token"
                }
            } else {
                syncOk = res
            }
        } catch {
            syncErr = error.localizedDescription
        }
    }

    /// JSON 多文件导入
    private func pickAndImportJSON() async {
        guard let spec else { return }
        let panel = NSOpenPanel()
        panel.title = "选择 Token JSON 文件"
        panel.allowedFileTypes = ["json"]
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        guard panel.runModal() == .OK, !panel.urls.isEmpty else { return }
        importing = true
        importMsg = nil
        defer { importing = false }
        do {
            let files = try panel.urls.map { u in
                (name: u.lastPathComponent, text: try String(contentsOf: u, encoding: .utf8))
            }
            if versions.isEmpty {
                let res = try await SpecStore.importJSON(ctx, spec: spec, files: files, mode: .merge)
                importMsg = (true, "导入完成 · V\(res.versionNo) · \(res.tokenCount) 条 Token")
            } else {
                pendingJSONFiles = files
                modeAskKind = .importJSON
            }
        } catch {
            importMsg = (false, "导入失败：\(error.localizedDescription)")
        }
    }

    /// 模式选择后的 JSON 文件暂存（sheet 回调无法带参，经状态中转）
    @State private var pendingJSONFiles: [(name: String, text: String)] = []

    private func importJSON(mode: SpecImportMode) async {
        guard let spec, !pendingJSONFiles.isEmpty else { return }
        importing = true
        importMsg = nil
        defer { importing = false }
        do {
            let res = try await SpecStore.importJSON(ctx, spec: spec, files: pendingJSONFiles, mode: mode)
            importMsg = (true, "导入完成 · V\(res.versionNo) · \(res.tokenCount) 条 Token")
        } catch {
            importMsg = (false, "导入失败：\(error.localizedDescription)")
        }
        pendingJSONFiles = []
    }

    /// 导出 Token：引擎生成产物 → 另存对话框
    private func exportTokens(_ format: String, _ suffix: String) async {
        let list = exportList
        if list.isEmpty {
            exportMsg = (false, "当前无 Token 可导出（请先同步）")
            return
        }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "\(spec?.name ?? "tokens").\(suffix)"
        panel.allowedFileTypes = [suffix.components(separatedBy: ".").last ?? "json"]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let text = try await EngineBridge.exportTokens(list, format: format)
            try text.write(to: url, atomically: true, encoding: .utf8)
            exportMsg = (true, "已导出：\(url.path)")
        } catch {
            exportMsg = (false, "导出失败，请重试")
        }
    }

    private func rollback(_ v: SpecVersion) {
        syncOk = nil
        syncErr = nil
        do {
            syncOk = try SpecStore.rollback(ctx, specId: specId, versionId: v.id)
            showHist = false
        } catch {
            syncErr = error.localizedDescription
        }
    }

    private func deleteVer(_ v: SpecVersion) {
        syncOk = nil
        syncErr = nil
        do {
            try SpecStore.deleteVersion(ctx, specId: specId, versionId: v.id)
        } catch {
            syncErr = error.localizedDescription
        }
    }

    private func deleteSpec() {
        try? SpecStore.deleteSpecCascade(ctx, specId: specId)
    }
}

// MARK: - 导入模式选择弹窗（同步 Figma / JSON 导入共用）

struct ModeAskSheet: View {
    let kind: SpecDetailView.ModeAskKind
    let onPick: (SpecImportMode?) -> Void
    @State private var replaceConfirm = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("选择导入方式").font(.headline)
            Text("同一规范可保留历史版本：叠加生成新版本，或清空后按本次数据重新开始。")
                .font(.caption).foregroundStyle(.secondary)
            VStack(spacing: 8) {
                Button {
                    onPick(.merge)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("在原数据上去重叠加").font(.subheadline.weight(.semibold))
                        Text("同名 Token 以本次数据覆盖，原有而本次没有的保留，追加为新版本")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Button(role: .destructive) {
                    replaceConfirm = true
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("删除原数据重新导入").font(.subheadline.weight(.semibold))
                        Text("清空全部历史版本与 Token，本次数据作为 V1 导入")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(.red.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            HStack {
                Spacer()
                Button("取消") { onPick(nil) }
            }
        }
        .padding(20)
        .frame(width: 420)
        .confirmationDialog(
            "确定删除原数据？该规范全部历史版本与 Token 将被清空且不可恢复，导入后以本次数据为 V1。",
            isPresented: $replaceConfirm,
            titleVisibility: .visible
        ) {
            Button("删除原数据并导入", role: .destructive) { onPick(.replace) }
            Button("取消", role: .cancel) {}
        }
    }
}

// MARK: - 规范新建 / 编辑表单（对齐 SpecModal.tsx：名称与 Figma 链接必填，链接实时校验）

struct SpecEditSheet: View {
    let categoryId: String
    let spec: DesignSpec?

    @Environment(\.modelContext) private var ctx
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var url: String
    @State private var note: String
    @State private var urlTouched = false

    init(categoryId: String, spec: DesignSpec?) {
        self.categoryId = categoryId
        self.spec = spec
        _name = State(initialValue: spec?.name ?? "")
        _url = State(initialValue: spec?.figmaUrl ?? "")
        _note = State(initialValue: spec?.note ?? "")
    }

    private var fileKey: String? {
        let u = url.trimmingCharacters(in: .whitespaces)
        return u.isEmpty ? nil : extractFigmaFileKey(u)
    }

    private var urlInvalid: Bool {
        urlTouched && !url.trimmingCharacters(in: .whitespaces).isEmpty && fileKey == nil
    }

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
            && !url.trimmingCharacters(in: .whitespaces).isEmpty
            && fileKey != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(spec == nil ? "新建规范" : "编辑规范").font(.headline)
            fieldLabel("规范名称")
            TextField("如：Web 端基础视觉规范", text: $name)
                .textFieldStyle(.roundedBorder)
            fieldLabel("Figma 规范链接")
            TextField("https://www.figma.com/file/…", text: $url)
                .textFieldStyle(.roundedBorder)
                .onSubmit { urlTouched = true }
            if urlInvalid {
                Text("链接格式不正确，需为 Figma 文件/设计/原型链接")
                    .font(.caption).foregroundStyle(.red)
            } else if let key = fileKey {
                Text("已识别 file key：\(key)").font(.caption).foregroundStyle(.green)
            }
            fieldLabel("备注")
            TextEditor(text: $note)
                .font(.callout)
                .frame(height: 64)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                Button(spec == nil ? "创建" : "保存") { save() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSave)
            }
        }
        .padding(20)
        .frame(width: 440)
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text).font(.caption.weight(.medium)).foregroundStyle(.secondary)
    }

    private func save() {
        guard canSave, let key = fileKey else { return }
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        let trimmedUrl = url.trimmingCharacters(in: .whitespaces)
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if let spec {
            spec.name = trimmedName
            spec.figmaUrl = trimmedUrl
            spec.figmaFileKey = key
            spec.note = trimmedNote.isEmpty ? nil : trimmedNote
            spec.updatedAt = nowMs()
        } else {
            ctx.insert(
                DesignSpec(
                    categoryId: categoryId,
                    name: trimmedName,
                    figmaUrl: trimmedUrl,
                    figmaFileKey: key,
                    note: trimmedNote.isEmpty ? nil : trimmedNote
                )
            )
        }
        try? ctx.save()
        dismiss()
    }
}
