import SwiftUI

// MARK: - 通用小组件（项目/页面列表与工作台共用）

/// 项目 Logo 头像：有图显示图片，无图显示名称首字符 + 占位底色（对齐 ProjectCard.tsx ProjectLogo）
struct ProjectLogoView: View {
    let project: Project
    var size: CGFloat = 36

    var body: some View {
        ZStack {
            if let img = ImageStore.image(of: project.logoPath) {
                Image(nsImage: img)
                    .resizable()
                    .scaledToFill()
            } else {
                colorFromHex(ProjectBranding.logoBgHex(of: project)) ?? Color.accentColor
                Text(String(project.name.prefix(1)))
                    .font(.system(size: size * 0.5, weight: .semibold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22))
    }
}

/// 端类型徽章
struct PlatformBadgeView: View {
    let platform: Platform

    var body: some View {
        Text(platform.label)
            .font(.caption2)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.quaternary, in: Capsule())
            .foregroundStyle(.secondary)
    }
}

/// 页面走查状态徽章
struct PageStatusBadgeView: View {
    let status: PageStatus

    private var color: Color {
        switch status {
        case .pending: .secondary
        case .reviewing: .orange
        case .completed: .green
        }
    }

    var body: some View {
        Text(status.label)
            .font(.caption2)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}

/// 本地图片视图：按相对路径从 ImageStore 加载（缩略图/画布共用）
struct LocalImageView: View {
    let relativePath: String?
    var contentMode: ContentMode = .fill

    var body: some View {
        if let nsImage = ImageStore.image(of: relativePath) {
            Image(nsImage: nsImage)
                .resizable()
                .aspectRatio(contentMode: contentMode)
        } else {
            ZStack {
                Rectangle().fill(.quaternary)
                Image(systemName: "photo")
                    .foregroundStyle(.tertiary)
            }
        }
    }
}
