import Foundation

// MARK: - 应用配置（对齐 Electron config.json：config:getAll / setConfig；落盘 Application Support/UITWalkthrough/config.json）

/// MCP 管理条目（config.json `mcps` 数组；自动走查只消费 pat / enabled / proxy 三个字段，其余键解码时忽略）
struct McpEntryConfig: Codable, Equatable, Sendable {
    var name: String?
    var pat: String?
    var enabled: Bool?
    var proxy: String?
}

/// 旧版 Figma 令牌字段（config.json `figmaMcp`）
struct FigmaMcpConfig: Codable, Equatable, Sendable {
    var pat: String?
}

/// 应用配置（对齐 Electron config.json 全部消费键）
struct AppConfig: Codable, Equatable, Sendable {
    var mcps: [McpEntryConfig]?
    var figmaMcp: FigmaMcpConfig?
    /// 结构化比对容差（walkTolerance）
    var walkTolerance: ToleranceConfig?
    /// 自动走查自定义检查项（walkCheckOptions）
    var walkCheckOptions: WalkCheckOptions?
    /// 高级调试子开关（结构化尺寸 diff，默认关闭）
    var walkAdvancedDebug: Bool?
    /// AI 模型列表（aiModels，OpenAI 兼容协议）
    var aiModels: [AIModelConfig]?
    /// 默认 AI 模型 id（aiDefaultModelId）
    var aiDefaultModelId: String?
    /// AI 任务完成提示音开关（soundEnabled，缺省开启）
    var soundEnabled: Bool?

    static let defaultValue = AppConfig()

    private func trimmed(_ raw: String?) -> String? {
        let s = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty ? nil : s
    }

    /// Figma PAT：取第一个「已启用且带令牌」的 MCP 条目，否则回退旧版 figmaMcp.pat（对齐 AutoWalkPanel `patFromConfig`）
    var figmaPAT: String? {
        if let entry = mcps?.first(where: { $0.enabled != false && trimmed($0.pat) != nil }) {
            return trimmed(entry.pat)
        }
        return trimmed(figmaMcp?.pat)
    }

    /// 上述 PAT 条目配置的自定义代理（engine-bridge 的 Figma REST 请求走代理链用）
    var figmaProxy: String? {
        if let entry = mcps?.first(where: { $0.enabled != false && trimmed($0.pat) != nil }) {
            return trimmed(entry.proxy)
        }
        return nil
    }
}

/// 配置文件读写（同步小文件，主线程调用）
enum AppConfigStore {
    static var fileURL: URL {
        let dir = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("UITWalkthrough", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("config.json")
    }

    static func load() -> AppConfig {
        guard let data = try? Data(contentsOf: fileURL) else { return .defaultValue }
        return (try? JSONDecoder().decode(AppConfig.self, from: data)) ?? .defaultValue
    }

    static func save(_ config: AppConfig) {
        guard let data = try? JSONEncoder().encode(config) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}
