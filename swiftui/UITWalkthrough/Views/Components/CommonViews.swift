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
                colorFromHex(ProjectBranding.logoBgHex(of: project)) ?? Color.primary
                Text(String(project.name.prefix(1)))
                    .font(.system(size: size * 0.5, weight: FontTokens.Weight.semibold))
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

    private var badgeColor: Color {
        switch platform {
        case .h5: return .badgeH5Text
        case .pc: return .badgePCText
        case .dashboard: return .badgeDashboardText
        case .electron: return .badgeElectronText
        }
    }

    private var badgeBg: Color {
        switch platform {
        case .h5: return Color.badgeH5
        case .pc: return Color.badgePC
        case .dashboard: return Color.badgeDashboard
        case .electron: return Color.badgeElectron
        }
    }

    var body: some View {
        Text(platform.label)
            .font(.system(size: FontTokens.Size.captionSmall, weight: .medium))
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.xs)
            .background(badgeBg, in: Capsule())
            .foregroundStyle(badgeColor)
    }
}

/// 页面走查状态徽章
struct PageStatusBadgeView: View {
    let status: PageStatus

    private var textColor: Color {
        switch status {
        case .pending: .textSecondary
        case .reviewing: .warning
        case .completed: .success
        }
    }

    private var bgColor: Color {
        switch status {
        case .pending: .fill
        case .reviewing: Color(hex: "#fef3e2") ?? .fill
        case .completed: .successBg
        }
    }

    var body: some View {
        Text(status.label)
            .font(.system(size: FontTokens.Size.captionSmall, weight: .medium))
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.xs)
            .background(bgColor, in: Capsule())
            .foregroundStyle(textColor)
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
                Rectangle().fill(Color.fill)
                Image(systemName: "photo")
                    .foregroundStyle(Color.textTertiary)
            }
        }
    }
}
