import AppKit
import Foundation

/// 图片像素取样：吸色取色 / 测量按图片原始像素计算（对齐 Electron 离屏 canvas getImageData 语义）。
/// 按 NSBitmapImageRep 缓存，同一张图重复取样不重复解码。
@MainActor
enum ImageSampler {
    private static var repCache: [String: NSBitmapImageRep] = [:]

    /// 归一化坐标（0~1）处像素色（#RRGGBB 大写），图缺失/解析失败返回 nil
    static func pixelHex(of relativePath: String?, nx: Double, ny: Double) -> String? {
        guard let relativePath, !relativePath.isEmpty, let rep = bitmapRep(of: relativePath),
              rep.pixelsWide > 0, rep.pixelsHigh > 0 else { return nil }
        let px = min(rep.pixelsWide - 1, max(0, Int((nx * Double(rep.pixelsWide)).rounded())))
        let py = min(rep.pixelsHigh - 1, max(0, Int((ny * Double(rep.pixelsHigh)).rounded())))
        guard let color = rep.colorAt(x: px, y: py)?.usingColorSpace(.deviceRGB) else { return nil }
        return rgbToHex(color.redComponent, color.greenComponent, color.blueComponent)
    }

    /// 图片原始像素尺寸（测量 px 换算用，对齐 img.naturalWidth/Height）
    static func pixelSize(of relativePath: String?) -> CGSize {
        guard let relativePath, !relativePath.isEmpty, let rep = bitmapRep(of: relativePath) else {
            return .zero
        }
        return CGSize(width: rep.pixelsWide, height: rep.pixelsHigh)
    }

    private static func bitmapRep(of relativePath: String) -> NSBitmapImageRep? {
        if let hit = repCache[relativePath] { return hit }
        guard let image = ImageStore.image(of: relativePath),
              let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let rep = NSBitmapImageRep(cgImage: cg)
        repCache[relativePath] = rep
        return rep
    }

    private static func rgbToHex(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> String {
        func byte(_ v: CGFloat) -> Int { Int((min(1, max(0, v)) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", byte(r), byte(g), byte(b))
    }
}
