import SwiftUI

// MARK: - 侧边栏（对齐 Electron .app-sidebar 200px 白底 + 导航圆点 + 折叠 footer）

/// 侧边栏容器
struct AppSidebar: View {
    @Binding var selection: AppSection
    @Binding var isCollapsed: Bool
    var logoImage: NSImage?
    let versionText: String

    var body: some View {
        VStack(spacing: 0) {
            // 导航区
            ScrollView {
                VStack(spacing: 0) {
                    // 一级菜单
                    ForEach(AppSection.allCases) { section in
                        AppNavItem(section: section, isSelected: selection == section) {
                            selection = section
                        }
                    }
                }
            }
            .padding(.horizontal, Spacing.md)

            Spacer()

            // Footer
            AppSidebarFooter(version: versionText)
        }
        .frame(width: SizeTokens.sidebarWidth)
        .background(Color.cardBg)
        .overlay(
            Rectangle()
                .fill(Color.border)
                .frame(width: 1)
                .offset(x: SizeTokens.sidebarWidth),
            alignment: .leading
        )
    }
}

/// 导航项（对齐 Electron .nav-item：圆点 + 文字 + hover/active 态）
struct AppNavItem: View {
    let section: AppSection
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: SizeTokens.navItemGap) {
                // 圆点指示器
                Circle()
                    .fill(isSelected ? Color.primary : Color.navDot)
                    .frame(width: SizeTokens.navDotSize, height: SizeTokens.navDotSize)
                // 文字 + 图标
                Label(section.title, systemImage: section.icon)
                    .font(.system(
                        size: FontTokens.Size.bodySmall,
                        weight: isSelected ? .semibold : .regular
                    ))
                    .foregroundStyle(isSelected ? Color.text : Color.textSecondary)
                Spacer()
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.sm)
            .background(isHovering ? Color.fill : Color.clear, in: RoundedRectangle(cornerRadius: Radius.sm))
            .animation(.easeInOut(duration: AnimationDuration.normal), value: isHovering)
        }
        .buttonStyle(.plain)
        .onHover { hovering in isHovering = hovering }
    }
}

/// 侧边栏底部（对齐 Electron .app-sidebar-footer）
struct AppSidebarFooter: View {
    let version: String

    var body: some View {
        HStack(spacing: Spacing.md) {
            Text(version)
                .font(.system(size: FontTokens.Size.micro))
                .foregroundStyle(Color.textTertiary)
                .lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.lg)
        .overlay(
            Rectangle()
                .fill(Color.border)
                .frame(height: 1),
            alignment: .top
        )
    }
}

// MARK: - 顶栏（对齐 Electron .app-topbar 52px + 红绿灯 + 搜索 + 品牌）

struct AppTopBar: View {
    let title: String
    let showSearch: Bool
    @Binding var searchText: String

    var body: some View {
        HStack(spacing: Spacing.xlg) {
            // 红绿灯按钮
            WindowControls()

            // 品牌
            Text(title)
                .font(.system(size: FontTokens.Size.body, weight: .bold))
                .foregroundStyle(Color.text)

            Spacer()

            // 搜索框
            if showSearch {
                HStack(spacing: Spacing.md) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(Color.textTertiary)
                    TextField("搜索", text: $searchText)
                        .font(.system(size: FontTokens.Size.bodySmall))
                }
                .padding(.horizontal, Spacing.md)
                .padding(.vertical, Spacing.sm)
                .background(Color.fill, in: RoundedRectangle(cornerRadius: Radius.sm))
                .frame(width: 200)
            }

            // 右侧操作按钮
            HStack(spacing: Spacing.sm) {
                AppIconButton("gearshape") {
                    // settings
                }
            }
        }
        .frame(height: SizeTokens.topbarHeight)
        .background(Color.cardBg)
        .overlay(
            Rectangle()
                .fill(Color.border)
                .frame(height: 1),
            alignment: .bottom
        )
    }
}

/// macOS 红绿灯窗口控制按钮
struct WindowControls: View {
    var body: some View {
        HStack(spacing: Spacing.md) {
            WindowControlButton(color: .windowClose, icon: "xmark") {
                NSApp.terminate(nil)
            }
            WindowControlButton(color: .windowMin, icon: "minus") {
                NSApp.keyWindow?.performMiniaturize(nil)
            }
            WindowControlButton(color: .windowMax, icon: "plus") {
                NSApp.keyWindow?.zoom(nil)
            }
        }
        .offset(x: 66) // 留出拖拽区偏移
    }
}

struct WindowControlButton: View {
    let color: Color
    let icon: String
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Circle()
                .fill(color)
                .frame(width: SizeTokens.windowControlSize, height: SizeTokens.windowControlSize)
                .overlay {
                    Image(systemName: icon)
                        .font(.system(size: 7, weight: .bold))
                        .foregroundStyle(.black.opacity(0.55))
                        .opacity(isHovering ? 0.6 : 0)
                }
        }
        .buttonStyle(.plain)
        .onHover { hovering in isHovering = hovering }
        .animation(.easeInOut(duration: AnimationDuration.fast), value: isHovering)
    }
}
