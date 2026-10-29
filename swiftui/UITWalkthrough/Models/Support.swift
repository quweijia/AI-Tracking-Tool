import SwiftUI

// MARK: - 通用工具（对齐 db/index.ts genId / bySort）

/// 当前时间毫秒时间戳（与 Dexie Date.now() 同口径）
func nowMs() -> Double {
    Date().timeIntervalSince1970 * 1000
}

/// 生成记录 id（Electron 用 crypto.randomUUID()，此处大写 UUID，仅作主键唯一性使用）
func genId() -> String {
    UUID().uuidString
}

/// 树状菜单/列表统一排序值：手动 sortNo 优先（小值在前），未拖过的按创建时间（对齐 db/index.ts `bySort`）
func effectiveSortOrder(sortNo: Int?, createdAt: Double) -> Double {
    Double(sortNo ?? Int(createdAt))
}

/// 相对时间文案（对齐 ProjectCard.tsx `timeAgo`）
func timeAgo(_ ms: Double) -> String {
    let diff = nowMs() - ms
    let m = 60_000.0
    let h = 3_600_000.0
    let d = 86_400_000.0
    if diff < m { return "刚刚" }
    if diff < h { return "\(Int(diff / m)) 分钟前" }
    if diff < d { return "\(Int(diff / h)) 小时前" }
    if diff < 30 * d { return "\(Int(diff / d)) 天前" }
    return "\(Int(diff / (30 * d))) 个月前"
}

// MARK: - 项目 Logo 占位（对齐 ProjectCard.tsx LOGO_COLORS / logoColorOf / logoBgOf）

enum ProjectBranding {
    static let logoColors = [
        "#3b82f6", "#8b5cf6", "#ec4899", "#f43f5e", "#14b8a6", "#0ea5e9", "#f97316", "#22c55e"
    ]

    /// 无 Logo 占位底色：按项目 id 稳定散列取色（h*31+charCode，UInt32 环绕与 JS >>> 0 一致）
    static func logoColorHex(of id: String) -> String {
        var h: UInt32 = 0
        for scalar in id.unicodeScalars {
            h = h &* 31 &+ UInt32(truncatingIfNeeded: scalar.value)
        }
        return logoColors[Int(h % UInt32(logoColors.count))]
    }

    /// 文字 Logo 实际底色：自选色优先，否则按 id 散列
    static func logoBgHex(of project: Project) -> String {
        project.logoColor ?? logoColorHex(of: project.id)
    }
}

/// 已解决问题状态（与问题清单「已解决」筛选口径一致，对齐 ProjectCard.tsx RESOLVED_STATUSES）
extension IssueStatus {
    static let resolvedStatuses: Set<IssueStatus> = [.fixed, .ignored, .designConfirmed]
    var isResolved: Bool { Self.resolvedStatuses.contains(self) }
}

// MARK: - 颜色工具

/// hex 字符串 → Color（支持 #RGB / #RRGGBB / #RRGGBBAA；非法输入返回灰）
func colorFromHex(_ hex: String) -> Color? {
    var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6 || s.count == 8 else { return nil }
    var value: UInt64 = 0
    guard Scanner(string: s).scanHexInt64(&value) else { return nil }
    let r, g, b, a: Double
    if s.count == 6 {
        r = Double((value >> 16) & 0xFF) / 255
        g = Double((value >> 8) & 0xFF) / 255
        b = Double(value & 0xFF) / 255
        a = 1
    } else {
        r = Double((value >> 24) & 0xFF) / 255
        g = Double((value >> 16) & 0xFF) / 255
        b = Double((value >> 8) & 0xFF) / 255
        a = Double(value & 0xFF) / 255
    }
    return Color(.sRGB, red: r, green: g, blue: b, opacity: a)
}
