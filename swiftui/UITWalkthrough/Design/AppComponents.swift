import SwiftUI

// MARK: - 通用组件库（对齐 Electron Diffboard 风格）
// AppButton | AppCard | AppInput | AppPanel | AppSidebar | AppBadge | AppSegmented

// MARK: - AppButton

/// 按钮风格枚举
enum AppButtonStyle {
    case primary
    case secondary
    case text
    case danger
    case destructive

    var isPrimary: Bool { self == .primary }
    var isDestructive: Bool { self == .danger || self == .destructive }
    var isText: Bool { self == .text }
}

struct AppButton: View {
    let title: String
    let icon: String?
    let style: AppButtonStyle
    let isLoading: Bool
    let isDisabled: Bool
    let action: () -> Void

    init(_ title: String, icon: String? = nil, style: AppButtonStyle = .secondary, isLoading: Bool = false, isDisabled: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.icon = icon
        self.style = style
        self.isLoading = isLoading
        self.isDisabled = isDisabled
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            label
        }
        .buttonStyle(AppButtonStyleWrapper(
            style: style,
            isDisabled: isDisabled || isLoading
        ))
    }

    @ViewBuilder
    private var label: some View {
        HStack(spacing: SizeTokens.buttonGap) {
            if isLoading {
                ProgressView()
                    .progressViewStyle(.circular)
                    .scaleEffect(0.7)
            } else if let icon {
                Image(systemName: icon)
                    .font(.system(size: FontTokens.Size.captionSmall))
            }
            Text(title)
        }
    }
}

/// 无标题图标按钮（顶栏/工具栏用）
struct AppIconButton: View {
    let icon: String
    let isActive: Bool
    let isDisabled: Bool
    let action: () -> Void

    init(_ icon: String, isActive: Bool = false, isDisabled: Bool = false, action: @escaping () -> Void) {
        self.icon = icon
        self.isActive = isActive
        self.isDisabled = isDisabled
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: FontTokens.Size.bodySmall))
        }
        .buttonStyle(AppIconButtonStyle(isActive: isActive, isDisabled: isDisabled))
    }
}

// MARK: - ButtonStyle 实现

struct AppButtonStyleWrapper: ButtonStyle {
    let style: AppButtonStyle
    let isDisabled: Bool

    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovering = false

    func makeBody(configuration: Configuration) -> some View {
        if style.isText {
            configuration.label
                .foregroundStyle(style.isDestructive ? Color.danger : Color.primary)
                .font(.system(size: FontTokens.Size.bodySmall))
                .opacity(isDisabled ? 0.4 : 1)
                .onHover { hovering in isHovering = hovering }
        } else {
            configuration.label
                .font(.system(size: FontTokens.Size.bodySmall, weight: .medium))
                .padding(.horizontal, SizeTokens.buttonPaddingH)
                .padding(.vertical, SizeTokens.buttonPaddingV)
                .background(background(for: configuration), in: RoundedRectangle(cornerRadius: Radius.sm))
                .foregroundStyle(foreground(for: configuration))
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.sm)
                        .strokeBorder(borderColor(for: configuration), lineWidth: 1)
                )
                .animation(.easeInOut(duration: AnimationDuration.normal), value: isHovering)
                .onHover { hovering in isHovering = hovering }
        }
    }

    private func background(for config: Configuration) -> Color {
        switch style {
        case .primary:
            // CSS: 默认 --primary，hover/按下 → --primary-dark；禁用 #b8ccf7 实底
            if isDisabled { return Color.disabled }
            return (isHovering || config.isPressed) ? Color.primaryDark : Color.primary
        case .secondary:
            // CSS: 默认白底，hover #f7f8fa，按下 --fill；禁用保持白底
            if isDisabled { return Color.cardBg }
            if config.isPressed { return Color.fill }
            return isHovering ? Color.buttonSecondaryHover : Color.cardBg
        case .danger:
            return config.isPressed ? Color.dangerHover : Color.cardBg
        case .text:
            return Color.clear
        case .destructive:
            return Color.clear
        }
    }

    private func foreground(for config: Configuration) -> Color {
        if isDisabled {
            // CSS: primary 禁用白字；secondary 禁用 #c3c9d4（均不降透明度）
            return style.isPrimary ? Color.white : Color.disabledText
        }
        switch style {
        case .primary:
            return Color.white
        case .secondary:
            return Color.buttonSecondaryText
        case .danger:
            return Color.danger
        case .text:
            return style.isDestructive ? Color.danger : Color.primary
        case .destructive:
            return Color.danger
        }
    }

    private func borderColor(for config: Configuration) -> Color {
        if isDisabled { return Color.border }
        switch style {
        case .primary:
            return Color.clear
        case .secondary:
            // CSS: 默认 --border-strong，hover #cdd3de
            return isHovering ? Color.buttonSecondaryHoverBorder : Color.borderStrong
        case .danger:
            return Color.dangerBorder
        case .text:
            return Color.clear
        case .destructive:
            return Color.clear
        }
    }
}

struct AppIconButtonStyle: ButtonStyle {
    let isActive: Bool
    let isDisabled: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(width: SizeTokens.iconButtonSize, height: SizeTokens.iconButtonSize)
            .background(background(for: configuration), in: RoundedRectangle(cornerRadius: Radius.sm))
            .foregroundStyle(foregroundColor(for: configuration))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.sm)
                    .strokeBorder(isActive ? Color.primary : Color.clear, lineWidth: 1)
            )
            .opacity(isDisabled ? 0.4 : 1)
    }

    private func background(for config: Configuration) -> Color {
        if isActive { return Color.primarySoft }
        if config.isPressed { return Color.fill }
        return Color.clear
    }

    private func foregroundColor(for config: Configuration) -> Color {
        if isActive { return Color.primary }
        if config.isPressed { return Color.text }
        return Color.textSecondary
    }
}

// MARK: - AppCard

struct AppCard<Content: View>: View {
    var padding: CGFloat = SizeTokens.cardPadding
    var margin: CGFloat = 0
    @ViewBuilder var content: () -> Content

    init(padding: CGFloat = SizeTokens.cardPadding, margin: CGFloat = 0, @ViewBuilder content: @escaping () -> Content) {
        self.padding = padding
        self.margin = margin
        self.content = content
    }

    var body: some View {
        content()
            .padding(padding)
            .background(Color.cardBg, in: RoundedRectangle(cornerRadius: Radius.lg))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.lg)
                    .strokeBorder(Color.border, lineWidth: 1)
            )
            .shadow(color: Shadow.card.color, radius: Shadow.card.radius, x: Shadow.card.x, y: Shadow.card.y)
            .padding(.bottom, margin)
    }
}

/// 带悬停效果的卡片（项目卡片/页面卡片）
struct AppCardHover<Content: View>: View {
    var padding: CGFloat = SizeTokens.cardPadding
    var cornerRadius: CGFloat = Radius.lg
    var action: (() -> Void)? = nil
    @ViewBuilder var content: () -> Content

    init(padding: CGFloat = SizeTokens.cardPadding, cornerRadius: CGFloat = Radius.lg, action: (() -> Void)? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.padding = padding
        self.cornerRadius = cornerRadius
        self.action = action
        self.content = content
    }

    @State private var isHovering = false

    var body: some View {
        content()
            .padding(padding)
            .background(Color.cardBg, in: RoundedRectangle(cornerRadius: cornerRadius))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(isHovering ? Color(hex: "#b8ccf7") : Color.border, lineWidth: 1)
            )
            .shadow(
                color: isHovering ? Shadow.hover.color : Shadow.card.color,
                radius: isHovering ? Shadow.hover.radius : Shadow.card.radius,
                x: 0, y: isHovering ? Shadow.hover.y : Shadow.card.y
            )
            .offset(y: isHovering ? -1 : 0)
            .animation(.easeInOut(duration: AnimationDuration.normal), value: isHovering)
            .onHover { hovering in isHovering = hovering }
            .contentShape(Rectangle())
            .onTapGesture { action?() }
    }
}

// MARK: - AppPanel（面板容器：带标题栏 + 分隔线）

struct AppPanel<Header: View, Content: View>: View {
    let header: Header
    let content: Content

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().padding(.horizontal, Spacing.xlg)
            content
                .padding(.top, Spacing.xlg)
        }
        .padding(Spacing.xlg)
    }
}

// MARK: - AppInput（输入框 + 聚焦环）

struct AppInput: View {
    @Binding var text: String
    let placeholder: String
    let font: Font

    @FocusState private var isFocused: Bool

    init(_ binding: Binding<String>, placeholder: String = "", font: Font = .system(size: FontTokens.Size.bodySmall)) {
        self._text = binding
        self.placeholder = placeholder
        self.font = font
    }

    var body: some View {
        TextField(placeholder, text: $text)
            .font(font)
            .padding(.horizontal, SizeTokens.inputPaddingH)
            .padding(.vertical, SizeTokens.inputPaddingV)
            .background(Color.cardBg, in: RoundedRectangle(cornerRadius: Radius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.sm)
                    .strokeBorder(isFocused ? Color.primary : Color.inputBorder, lineWidth: 1)
            )
            .shadow(
                color: isFocused ? Color.inputFocusRing : Color.clear,
                radius: 0, x: 0, y: 0
            )
            .focusable()
            .focused($isFocused)
    }
}

// MARK: - AppBadge（徽章）

struct AppBadge: View {
    let text: String
    var color: Color = Color.primaryDark
    var bgColor: Color = Color.primarySoft

    var body: some View {
        Text(text)
            .font(.system(size: FontTokens.Size.captionSmall, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, Spacing.mg)
            .padding(.vertical, Spacing.xxs)
            .background(bgColor, in: Capsule())
    }
}

// MARK: - AppSegmented（分段选择器）

struct AppSegmented<Option: Hashable & CustomStringConvertible>: View {
    let options: [Option]
    @Binding var selection: Option

    var body: some View {
        Picker("", selection: $selection) {
            ForEach(options, id: \.self) { option in
                Text(option.description)
                    .tag(option)
            }
        }
        .pickerStyle(.segmented)
    }
}

// MARK: - AppFieldLabel（表单标签）

struct AppFieldLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: FontTokens.Size.bodySmall, weight: .medium))
            .foregroundStyle(Color.textSecondary)
            .padding(.bottom, Spacing.sm)
    }
}

// MARK: - AppEmptyState（空状态占位）

struct AppEmptyState: View {
    let title: String
    let description: String?
    let systemImage: String?

    init(_ title: String, description: String? = nil, systemImage: String? = "square.grid.2x2") {
        self.title = title
        self.description = description
        self.systemImage = systemImage
    }

    var body: some View {
        ContentUnavailableView(
            title,
            systemImage: systemImage ?? "exclamationmark.triangle",
            description: description.map { Text($0) } ?? Text("")
        )
        .frame(maxWidth: .infinity, minHeight: 400)
    }
}

// MARK: - AppDivider（分隔线）

struct AppDivider: View {
    var color: Color = Color.border
    var spacing: CGFloat = 0

    var body: some View {
        Divider()
            .background(color)
            .padding(.vertical, spacing)
    }
}

// MARK: - 字段标签（对齐 Electron .field-label）

struct FieldLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: FontTokens.Size.bodySmall, weight: .medium))
            .foregroundStyle(Color.textSecondary)
    }
}

// MARK: - 成功标签（对齐 Electron .ok-label）

struct OKLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: FontTokens.Size.captionSmall, weight: .medium))
            .foregroundStyle(Color.success)
    }
}
