import SwiftUI
import AppKit

// MARK: - 设计 Token（对齐 Electron 版 Diffboard 风格设计系统）
// 色板 | 字体 | 间距 | 圆角 | 阴影 | 动画
// 所有数值来源于 src/renderer/src/styles/global.css

// MARK: - 色板

extension Color {
    // 主色
    static let primary = Color(hex: "#2563eb")
    static let primaryDark = Color(hex: "#1d4ed8")
    static let primarySoft = Color(hex: "#eff4ff")

    // 语义色
    static let success = Color(hex: "#16a34a")
    static let successBg = Color(hex: "#e8f7ee")
    static let successText = Color(hex: "#15803d")

    static let warning = Color(hex: "#f59e0b")
    static let danger = Color(hex: "#dc2626")
    // global.css: .btn-danger:hover 底色（非 --danger-soft #fde8e8，后者是浅底徽章语义）
    static let dangerHover = Color(hex: "#fef2f2")
    // P05: SwiftUI 端 danger 按钮描边专用（AppComponents.borderColor）；CSS 无对应使用场景，不补 CSS 死定义
    static let dangerBorder = Color(hex: "#f2c1c1")

    // 文字色
    static let text = Color(hex: "#1f2937")
    static let textSecondary = Color(hex: "#667085")
    static let textTertiary = Color(hex: "#98a2b3")

    // 背景色
    static let appBg = Color(hex: "#f5f6f8")
    static let cardBg = Color(hex: "#ffffff")
    static let fill = Color(hex: "#f2f4f8")

    // 边框色
    static let border = Color(hex: "#e7eaf0")
    static let borderStrong = Color(hex: "#dfe3ea")

    // 按钮交互态（.btn-secondary hover / 文字色，global.css L698-755）
    static let buttonSecondaryText = Color(hex: "#344054")
    static let buttonSecondaryHover = Color(hex: "#f7f8fa")
    static let buttonSecondaryHoverBorder = Color(hex: "#cdd3de")

    // 辅助色（表单/交互）
    static let inputBorder = Color(hex: "#dfe3ea")
    static let inputHover = Color(hex: "#fafbfd")
    static let inputFocusRing = Color(hex: "#2563eb").opacity(0.12)
    static let navDot = Color(hex: "#c6cbd6")
    static let navSection = Color(hex: "#8a93a6")
    static let disabled = Color(hex: "#b8ccf7")
    static let disabledText = Color(hex: "#c3c9d4")

    // 平台标签
    static let badgeH5 = Color(hex: "#e8f7ee")
    static let badgeH5Text = Color(hex: "#15803d")
    static let badgePC = Color(hex: "#eff4ff")
    static let badgePCText = Color(hex: "#1d4ed8")
    static let badgeDashboard = Color(hex: "#f3efff")
    static let badgeDashboardText = Color(hex: "#7c3aed")
    static let badgeElectron = Color(hex: "#fef3e2")
    static let badgeElectronText = Color(hex: "#b45309")

    // 窗口控制按钮
    static let windowClose = Color(hex: "#ff5f57")
    static let windowMin = Color(hex: "#febc2e")
    static let windowMax = Color(hex: "#28c840")

    /// 从 HEX 字符串创建颜色（#RRGGBB / #RRGGBBAA），失败回退 .clear
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard hex.hasPrefix("#") else { self.init(red: 0, green: 0, blue: 0); return }
        let start = hex.index(hex.startIndex, offsetBy: 1)
        let cStr = String(hex[start...])
        guard let rgb = UInt64(cStr, radix: 16) else { self.init(red: 0, green: 0, blue: 0); return }
        if cStr.count == 6 {
            let r = Double((rgb >> 16) & 0xFF) / 255.0
            let g = Double((rgb >> 8) & 0xFF) / 255.0
            let b = Double(rgb & 0xFF) / 255.0
            self.init(red: r, green: g, blue: b)
        } else if cStr.count == 8 {
            let r = Double((rgb >> 24) & 0xFF) / 255.0
            let g = Double((rgb >> 16) & 0xFF) / 255.0
            let b = Double((rgb >> 8) & 0xFF) / 255.0
            let a = Double(rgb & 0xFF) / 255.0
            self.init(red: r, green: g, blue: b, opacity: a)
        } else {
            self.init(red: 0, green: 0, blue: 0)
        }
    }
}

// MARK: - 深色模式色板

extension Color {
    enum Dark {}
}

extension Color.Dark {
    // 深色模式色板（[data-theme='dark'] 覆盖）
    static let primary = Color(hex: "#4f8dfd")
    static let primaryDark = Color(hex: "#3b82f6")
    static let primarySoft = Color(hex: "#4f8dfd").opacity(0.16)

    static let success = Color(hex: "#4ade80")
    static let warning = Color(hex: "#fbbf24")
    static let danger = Color(hex: "#f87171")

    static let text = Color(hex: "#e6e9ef")
    static let textSecondary = Color(hex: "#a2a9b8")
    static let textTertiary = Color(hex: "#6f7684")

    static let appBg = Color(hex: "#0f1216")
    static let cardBg = Color(hex: "#181c23")
    static let fill = Color(hex: "#20262f")
    static let surface = Color(hex: "#1c212a")
    static let canvasBg = Color(hex: "#141922")

    static let border = Color(hex: "#262c36")
    static let borderStrong = Color(hex: "#303845")

    static let inputBg = Color(hex: "#20262f")
    static let inputHover = Color(hex: "#242b36")
    static let kbdBg = Color(hex: "#2a2f3a")
    static let kbdBorder = Color(hex: "#3a4250")

    static let scrollbarThumb = Color(hex: "#333b48")
    static let scrollbarHover = Color(hex: "#434e5e")

    // global.css: [data-theme='dark'] .window-controls.inactive 的置灰色
    static let windowInactive = Color(hex: "#4b5058")
}

// MARK: - 字体

enum FontTokens {
    // 字号/字重/行高对照表
    // CSS: body 14px, nav-item 13px, page-header h1 20px
    enum Size {
        static let pageHeader: CGFloat = 20
        static let sectionHeader: CGFloat = 16
        static let body: CGFloat = 14
        static let bodySmall: CGFloat = 13
        static let caption: CGFloat = 12
        static let captionSmall: CGFloat = 12
        static let tiny: CGFloat = 11
        static let micro: CGFloat = 11
        static let nano: CGFloat = 10
    }

    enum Weight {
        static let regular: Font.Weight = .regular
        static let medium: Font.Weight = .medium
        static let semibold: Font.Weight = .semibold
        static let bold: Font.Weight = .bold
    }

    static let family = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif"
}

// MARK: - 间距（4px 基准栅格）

enum Spacing {
    static let zero: CGFloat = 0
    static let xs: CGFloat = 4
    static let xxs: CGFloat = 2
    static let sm: CGFloat = 6
    static let md: CGFloat = 8
    static let mg: CGFloat = 10
    static let lg: CGFloat = 12
    static let xl: CGFloat = 14
    static let xlg: CGFloat = 16
    static let xxl: CGFloat = 18
    static let xlg2: CGFloat = 20
    static let hero: CGFloat = 24
    static let hlg: CGFloat = 30
    static let hlg2: CGFloat = 32
    static let huge: CGFloat = 40
    static let xhuge: CGFloat = 48
    static let massive: CGFloat = 60
    static let xmassive: CGFloat = 80
}

// MARK: - 圆角

enum Radius {
    static let none: CGFloat = 0
    static let tiny: CGFloat = 4
    static let xs: CGFloat = 6
    static let sm: CGFloat = 8
    static let md: CGFloat = 10
    static let lg: CGFloat = 12
    static let pill: CGFloat = 999
}

// MARK: - 阴影

// P05: 基色 #101828 与 CSS rgba(16,24,40,…) 同值异写法（SwiftUI 无 rgba() 构造，hex + opacity 等价），四档对齐 CSS var(--shadow-card/pop/hover/float)
enum Shadow {
    struct Token {
        let color: Color
        let radius: CGFloat
        let x: CGFloat
        let y: CGFloat

        func apply(to content: some View) -> some View {
            content.shadow(color: color, radius: radius, x: x, y: y)
        }
    }

    static let card = Token(color: Color(hex: "#101828").opacity(0.04), radius: 2, x: 0, y: 1)
    static let pop = Token(color: Color(hex: "#101828").opacity(0.14), radius: 32, x: 0, y: 12)
    static let hover = Token(color: Color(hex: "#101828").opacity(0.08), radius: 14, x: 0, y: 4)
    static let batchBar = Token(color: Color(hex: "#101828").opacity(0.16), radius: 28, x: 0, y: 8)

    // 深色模式
    static let cardDark = Token(color: .black.opacity(0.4), radius: 2, x: 0, y: 1)
    static let popDark = Token(color: .black.opacity(0.6), radius: 32, x: 0, y: 12)
}

// MARK: - 动画时长

enum AnimationDuration {
    static let fast: Double = 0.12
    static let normal: Double = 0.15
    // P05 新增（对齐 CSS 过渡档位）：transform/background/left 过渡与 toast-in、ai-panel-in 入场
    static let medium: Double = 0.18
    // P05 新增：侧栏等宽度过渡（transition: width 0.3s）与 animation-delay 0.3s
    static let extended: Double = 0.3
    static let slow: Double = 0.4
    static let aiShine: Double = 3.2
    static let aiPulse: Double = 1.5
    static let aiSpark: Double = 1.2
}

// MARK: - 尺寸常量

enum SizeTokens {
    // 布局
    static let topbarHeight: CGFloat = 52
    static let sidebarWidth: CGFloat = 200
    static let sidebarCollapsed: CGFloat = 52

    // 控件
    static let iconButtonSize: CGFloat = 30
    static let windowControlSize: CGFloat = 12
    static let colorSwatchSize: CGFloat = 22
    static let logoDotSize: CGFloat = 22
    static let projectLogoSize: CGFloat = 36
    static let logoAvatarSize: CGFloat = 52

    // 卡片
    static let cardPadding: CGFloat = 20
    static let cardPaddingSmall: CGFloat = 14
    static let cardPaddingCompact: CGFloat = 10

    // 按钮
    static let buttonPaddingH: CGFloat = 14
    static let buttonPaddingV: CGFloat = 7
    static let buttonGap: CGFloat = 6

    // 输入框
    static let inputPaddingH: CGFloat = 11
    static let inputPaddingV: CGFloat = 7

    // 导航
    static let navItemPadding: CGFloat = 7
    static let navItemGap: CGFloat = 8
    static let navDotSize: CGFloat = 6

    // 网格
    static let projectGridMin: CGFloat = 296
    static let projectGridGap: CGFloat = 16
    static let pageGridMin: CGFloat = 190
    static let pageGridGap: CGFloat = 12
}

// MARK: - 深色模式检测（对齐 Electron [data-theme='dark']）

struct AppTheme: EnvironmentKey {
    static let defaultValue: ColorScheme = .light
}

extension EnvironmentValues {
    var appTheme: ColorScheme {
        get { self[AppTheme.self] }
        set { self[AppTheme.self] = newValue }
    }
}
