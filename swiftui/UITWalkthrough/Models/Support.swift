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
