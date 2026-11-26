import SwiftData
import SwiftUI

/// 项目列表页（对齐 Electron ProjectList：项目卡片网格 + 新建/编辑/删除）
struct ProjectsHomeView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.modelContext) private var context

    @Query(sort: [SortDescriptor(\Project.createdAt)]) private var projects: [Project]
    @Query private var pages: [WalkthroughPage]
    @Query private var issues: [Issue]

    @State private var sheetMode: ProjectSheetMode?
    @State private var deletingProject: Project?

    var body: some View {
        NavigationStack {
            ScrollView {
                if projects.isEmpty {
                    AppEmptyState(
                        "暂无项目",
                        description: "点击右上角「新建项目」创建第一个走查项目",
                        systemImage: "square.grid.2x2"
                    )
                } else {
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: SizeTokens.projectGridMin), spacing: Spacing.xlg)],
                        spacing: Spacing.xlg
                    ) {
                        ForEach(projects.sorted { $0.sortOrder < $1.sortOrder }) { project in
                            NavigationLink(value: project.id) {
                                ProjectCardView(
                                    project: project,
                                    pageCount: pageStats[project.id]?.pages ?? 0,
                                    unresolvedCount: pageStats[project.id]?.unresolved ?? 0
                                )
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button("编辑项目") { sheetMode = .edit(project) }
                                Button("删除项目", role: .destructive) { deletingProject = project }
                            }
                        }
                    }
                    .padding(Spacing.hero)
                }
            }
            .navigationTitle("项目")
            .navigationDestination(for: String.self) { projectID in
                ProjectDetailView(projectID: projectID)
            }
            .toolbar {
                AppButton("新建项目", icon: "plus", style: .primary) {
                    sheetMode = .create
                }
            }
            .sheet(item: $sheetMode) { mode in
                ProjectSheet(mode: mode)
            }
            .confirmationDialog(
                "删除项目「\(deletingProject?.name ?? "")」？",
                isPresented: Binding(
                    get: { deletingProject != nil },
                    set: { if !$0 { deletingProject = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("删除（级联清理页面、标注与图片）", role: .destructive) {
                    if let p = deletingProject {
                        Cascade.deleteProject(p.id, context: context)
                        if appState.activeProjectID == p.id { appState.activeProjectID = nil }
                    }
                    deletingProject = nil
                }
                Button("取消", role: .cancel) { deletingProject = nil }
            } message: {
                Text("该操作不可恢复，其下全部文件夹、页面、标注与图片文件将一并删除。")
            }
        }
    }

    /// 项目统计：页面数 / 未解决问题数（fixed/ignored/design-confirmed 视为已解决）
    private var pageStats: [String: (pages: Int, unresolved: Int)] {
        var result: [String: (Int, Int)] = [:]
        for p in pages { result[p.projectId, default: (0, 0)].0 += 1 }
        for i in issues where !i.status.isResolved {
            if let pid = pages.first(where: { $0.id == i.pageId })?.projectId {
                result[pid, default: (0, 0)].1 += 1
            }
        }
        return result
    }
}

/// 项目卡片
struct ProjectCardView: View {
    let project: Project
    let pageCount: Int
    let unresolvedCount: Int

    var body: some View {
        AppCardHover(padding: SizeTokens.cardPadding, cornerRadius: Radius.lg) {
            VStack(alignment: .leading, spacing: Spacing.mg) {
                HStack(spacing: Spacing.mg) {
                    ProjectLogoView(project: project, size: 40)
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        Text(project.name)
                            .font(.system(size: FontTokens.Size.sectionHeader, weight: FontTokens.Weight.semibold))
                            .foregroundStyle(Color.text)
                            .lineLimit(1)
                        Text(timeAgo(project.updatedAt))
                            .font(.system(size: FontTokens.Size.captionSmall))
                            .foregroundStyle(Color.textSecondary)
                    }
                    Spacer()
                }
                FlowPlatformChips(platforms: project.platform)
                HStack(spacing: Spacing.lg) {
                    Label("\(pageCount)", systemImage: "photo.on.rectangle")
                    Label("\(unresolvedCount)", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(unresolvedCount > 0 ? Color.orange : .textSecondary)
                    Spacer()
                }
                .font(.system(size: FontTokens.Size.captionSmall))
                .foregroundStyle(Color.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// 多端类型徽章组
struct FlowPlatformChips: View {
    let platforms: [Platform]

    var body: some View {
        HStack(spacing: Spacing.xs) {
            ForEach(platforms) { p in
                PlatformBadgeView(platform: p)
            }
        }
    }
}

// MARK: - 新建/编辑项目弹窗（对齐 ProjectModal）

enum ProjectSheetMode: Identifiable {
    case create
    case edit(Project)

    var id: String {
        switch self {
        case .create: "create"
        case .edit(let p): p.id
        }
    }
}

struct ProjectSheet: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    let mode: ProjectSheetMode

    @State private var name = ""
    @State private var platforms: Set<Platform> = []
    @State private var logoColor: String?
    @State private var logoRelativePath: String?

    var body: some View {
        VStack(spacing: 0) {
            Text(isEdit ? "编辑项目" : "新建项目")
                .font(.system(size: FontTokens.Size.sectionHeader, weight: FontTokens.Weight.semibold))
                .foregroundStyle(Color.text)
                .padding(.top, Spacing.lg)
            Form {
                HStack(spacing: Spacing.lg) {
                    logoPreview
                    VStack(alignment: .leading, spacing: Spacing.xlg) {
                        AppButton("上传 Logo", icon: nil, style: .secondary) { importLogo() }
                        if logoRelativePath != nil {
                            AppButton("移除 Logo", icon: nil, style: .danger) { logoRelativePath = nil }
                        }
                    }
                }
                AppInput($name, placeholder: "项目名称")
                VStack(alignment: .leading, spacing: Spacing.xlg) {
                    FieldLabel(text: "适用端类型（可多选）")
                    HStack(spacing: Spacing.xlg) {
                        ForEach(Platform.allCases) { p in
                            chip(p)
                        }
                    }
                }
                VStack(alignment: .leading, spacing: Spacing.xlg) {
                    FieldLabel(text: "文字 Logo 底色")
                    HStack(spacing: Spacing.xlg) {
                        dot(nil, label: "自动")
                        ForEach(ProjectBranding.logoColors, id: \.self) { hex in
                            dot(hex, label: hex)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .padding(.horizontal, Spacing.lg)
            HStack {
                Spacer()
                AppButton("取消", icon: nil, style: .secondary) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                AppButton(isEdit ? "保存" : "创建", icon: nil, style: .primary, isDisabled: name.trimmingCharacters(in: .whitespaces).isEmpty) { submit() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(Spacing.lg)
        }
        .frame(width: 420)
        .onAppear { load() }
    }

    private var isEdit: Bool {
        if case .edit = mode { return true }
        return false
    }

    private var logoPreview: some View {
        ZStack {
            if let path = logoRelativePath, let img = ImageStore.image(of: path) {
                Image(nsImage: img).resizable().scaledToFill()
            } else {
                (colorFromHex(logoColor ?? "") ?? Color.gray)
                Text(String(name.prefix(1)).isEmpty ? "?" : String(name.prefix(1)))
                    .font(.system(size: FontTokens.Size.pageHeader, weight: FontTokens.Weight.semibold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: 56, height: 56)
        .clipShape(RoundedRectangle(cornerRadius: Radius.lg))
    }

    private func chip(_ p: Platform) -> some View {
        Button {
            if platforms.contains(p) { platforms.remove(p) } else { platforms.insert(p) }
        } label: {
            Text(p.label)
                .font(.system(size: FontTokens.Size.captionSmall))
                .padding(.horizontal, Spacing.mg)
                .padding(.vertical, Spacing.xxs)
                .background(
                    platforms.contains(p) ? Color.primarySoft : Color.fill,
                    in: Capsule()
                )
                .overlay(Capsule().strokeBorder(platforms.contains(p) ? Color.primary : Color.border, lineWidth: 1))
                .foregroundStyle(platforms.contains(p) ? Color.primaryDark : Color.text)
        }
        .buttonStyle(.plain)
    }

    private func dot(_ hex: String?, label: String) -> some View {
        Button {
            logoColor = hex
        } label: {
            Circle()
                .fill(hex.map { colorFromHex($0) ?? .fill } ?? .fill)
                .frame(width: SizeTokens.colorSwatchSize, height: SizeTokens.colorSwatchSize)
                .overlay(
                    Circle().strokeBorder(logoColor == hex ? Color.primary : Color.border, lineWidth: logoColor == hex ? 2 : 1)
                )
        }
        .buttonStyle(.plain)
        .help(label)
    }

    private func importLogo() {
        guard let url = ImagePicker.pickImage(),
              let path = try? ImageStore.importFile(at: url) else { return }
        if let old = logoRelativePath { ImageStore.delete(old) }
        logoRelativePath = path
    }

    private func load() {
        guard case .edit(let p) = mode else { return }
        name = p.name
        platforms = Set(p.platform)
        logoColor = p.logoColor
        logoRelativePath = p.logoPath
    }

    private func submit() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        let list = Platform.allCases.filter { platforms.contains($0) }
        switch mode {
        case .create:
            context.insert(Project(name: trimmed, platform: list, logoPath: logoRelativePath, logoColor: logoColor))
        case .edit(let p):
            p.name = trimmed
            p.platform = list
            if p.logoPath != logoRelativePath, let old = p.logoPath { ImageStore.delete(old) }
            p.logoPath = logoRelativePath
            p.logoColor = logoColor
            p.updatedAt = nowMs()
        }
        try? context.save()
        dismiss()
    }
}
