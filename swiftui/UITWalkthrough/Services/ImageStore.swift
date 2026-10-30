import AppKit
import Foundation

/// 本地图片存储：镜像 Electron `file:saveImage / selectImage / readImage / deleteImage` IPC 语义。
/// 数据库仅存相对路径（`images/<uuid>.<ext>`），物理位置 Application Support/UITWalkthrough/walkthrough-data/images/。
@MainActor
enum ImageStore {
    nonisolated private static let relativePrefix = "images/"

    /// 生成并确保图片目录存在
    nonisolated static func baseDir() -> URL {
        let fm = FileManager.default
        let dir = fm
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("UITWalkthrough/walkthrough-data/images", isDirectory: true)
        if !fm.fileExists(atPath: dir.path) {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    /// 相对路径 → 绝对 URL（相对路径形如 `images/<fileName>`）
    nonisolated static func resolve(_ relativePath: String) -> URL {
        let name = relativePath.hasPrefix(relativePrefix)
            ? String(relativePath.dropFirst(relativePrefix.count))
            : relativePath
        return baseDir().appendingPathComponent(name)
    }

    /// 保存图片二进制，返回相对路径（对齐 file:saveImage）
    static func save(_ data: Data, ext: String) throws -> String {
        let cleanExt = ext.lowercased() == "jpeg" ? "jpg" : ext.lowercased()
        let fileName = "\(UUID().uuidString).\(cleanExt)"
        try data.write(to: baseDir().appendingPathComponent(fileName))
        return relativePrefix + fileName
    }

    /// 把系统对话框选中的图片复制进数据目录，返回相对路径（对齐 file:selectImage 的落盘部分）
    static func importFile(at source: URL) throws -> String {
        let ext = source.pathExtension.lowercased()
        let fileName = "\(UUID().uuidString).\(ext.isEmpty ? "png" : ext)"
        let dest = baseDir().appendingPathComponent(fileName)
        try FileManager.default.copyItem(at: source, to: dest)
        return relativePrefix + fileName
    }

    /// 读取图片数据（对齐 file:readImage，缺失返回 nil 不阻塞）
    nonisolated static func data(of relativePath: String) -> Data? {
        try? Data(contentsOf: resolve(relativePath))
    }

    /// 读取图片（缩略图/画布加载用，带内存缓存）
    static func image(of relativePath: String?) -> NSImage? {
        guard let relativePath, !relativePath.isEmpty else { return nil }
        if let hit = cache.object(forKey: relativePath as NSString) { return hit }
        guard let img = NSImage(contentsOf: resolve(relativePath)) else { return nil }
        cache.setObject(img, forKey: relativePath as NSString)
        return img
    }

    private static let cache = NSCache<NSString, NSImage>()

    /// 删除图片文件（失败不阻塞，对齐 file:deleteImage）
    static func delete(_ relativePath: String) {
        guard !relativePath.isEmpty else { return }
        try? FileManager.default.removeItem(at: resolve(relativePath))
        cache.removeObject(forKey: relativePath as NSString)
    }
}

/// 系统图片选择对话框（NSOpenPanel，对应 Electron file:selectImage 的选择部分）
@MainActor
enum ImagePicker {
    static func pickImage() -> URL? {
        let panel = NSOpenPanel()
        panel.title = "选择图片"
        panel.allowedContentTypes = [.png, .jpeg, .webP]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        return panel.runModal() == .OK ? panel.url : nil
    }
}
