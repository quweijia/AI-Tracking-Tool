import Foundation

// MARK: - 引擎桥接（第一阶段：Process 调用 engine-bridge CLI，复用 Electron 纯逻辑引擎模块）
//
// 协议：argv[2] = 子命令；stdin = JSON 入参；stdout = 单个 JSON 出参（ok 字段标识成败，始终 exit 0）。
// CLI 产物：swiftui/engine-bridge/dist/engine-bridge.cjs（esbuild 打包 src/entry.ts + 仓库内引擎模块）。

// MARK: - 引擎输出 DTO（字段名与引擎 TS 结构一致）

/// 归一化标注框（引擎 rect {x,y,width,height}，0~1）
struct EngineRect: Codable, Sendable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double
}

/// 输出节点只保留 domPath 回溯字段（children 子树体积大，壳层落库用不到）
struct EngineNodeRef: Decodable, Sendable {
    var domPath: String?
}

/// 结构化样式差异（对齐 shared/types.ts StyleDiff）
struct EngineDiffDTO: Decodable, Sendable {
    var category: IssueCategory
    var severity: Severity
    var property: String
    var label: String
    var designValue: String
    var devValue: String
    /// 颜色类差异的开发侧色值（hex）
    var colorHex: String?
    /// 差异描述（引擎字段 description）
    var diffDescription: String
    var figmaNodeId: String?
    var domPath: String?
    var matchConfidence: Double
    var rect: EngineRect

    enum CodingKeys: String, CodingKey {
        case category, severity, property, label, designValue, devValue, colorHex
        case diffDescription = "description"
        case figmaNodeId, domPath, matchConfidence, rect
    }
}

struct EngineCompareDTO: Decodable, Sendable {
    var ok: Bool
    var message: String?
    var diffs: [EngineDiffDTO]?
    var unmatchedDesignCount: Int?
    var unmatchedDomCount: Int?
}

/// 规范 Token 校验违规（对齐 specCheck.ts SpecViolation）
struct EngineSpecViolationDTO: Decodable, Sendable {
    var node: EngineNodeRef?
    var rect: EngineRect
    var category: IssueCategory
    var severity: Severity
    var property: String
    /// 属性名 i18n key（specProp_*）
    var propKey: String
    var actualText: String
    var tokenName: String
    var expectedText: String
    /// deltaE / px；阴影描边结构不匹配时缺省
    var deltaKind: String?
    var deltaValue: Double?
}

struct EngineSpecDTO: Decodable, Sendable {
    var ok: Bool
    var message: String?
    var violations: [EngineSpecViolationDTO]?
}

/// 元素清单发现（对齐 elementCheck.ts ElementFinding）
struct EngineElementFindingDTO: Decodable, Sendable {
    /// img-broken / element-missing / text-mismatch
    var kind: String
    var category: IssueCategory
    var severity: Severity
    var targetImage: TargetImage
    var rect: EngineRect
    var node: EngineNodeRef?
    var designNode: EngineNodeRef?
    var designText: String?
    var domText: String?
    var domPath: String?
}

struct EngineElementDTO: Decodable, Sendable {
    var ok: Bool
    var message: String?
    var findings: [EngineElementFindingDTO]?
}

/// 无障碍发现（对齐 a11yCheck.ts A11yFinding）
struct EngineA11yFindingDTO: Decodable, Sendable {
    /// img-alt-missing / contrast-low / font-too-small / tap-target-small / input-no-label
    var kind: String
    var category: IssueCategory
    var severity: Severity
    var rect: EngineRect
    var node: EngineNodeRef?
    var domPath: String?
    var actualText: String?
    var expectedText: String?
}

struct EngineA11yDTO: Decodable, Sendable {
    var ok: Bool
    var message: String?
    var findings: [EngineA11yFindingDTO]?
}

struct EngineSize: Decodable, Sendable {
    var width: Double
    var height: Double
}

/// figma-node-size 出参（fetchFigmaNodeSize 透传）
struct EngineNodeSizeDTO: Decodable, Sendable {
    var ok: Bool
    var message: String?
    var width: Double?
    var height: Double?
    var nodeName: String?
}

/// figma-design 出参（截图 PNG 与树 JSON 由 CLI 落盘到 outScreenshot/outRoot 指定路径）
struct EngineFigmaDesignDTO: Decodable, Sendable {
    var ok: Bool
    var message: String?
    var fileKey: String?
    var nodeId: String?
    var nodeName: String?
    var frameSize: EngineSize?
    var scale: Double?
    var skippedCount: Int?
}

// MARK: - 引擎调用错误

enum EngineBridgeError: LocalizedError {
    case cliNotFound
    case nodeNotFound
    case launchFailed(String)
    case commandFailed(String)

    var errorDescription: String? {
        switch self {
        case .cliNotFound:
            "未找到 engine-bridge CLI（swiftui/engine-bridge/dist/engine-bridge.cjs），请先构建引擎桥接产物"
        case .nodeNotFound:
            "未找到 Node.js 运行时（node），请安装 Node.js 后重试"
        case .launchFailed(let detail):
            "引擎调用失败：\(detail)"
        case .commandFailed(let message):
            message
        }
    }
}

// MARK: - 引擎桥接

enum EngineBridge {
    /// CLI 绝对路径解析：① UserDefaults engineBridgePath ② App 包 Resources 内 ③ 开发布局（从 .app 向上逐级找 swiftui/engine-bridge/dist）
    static func cliURL() -> URL? {
        if let custom = UserDefaults.standard.string(forKey: "engineBridgePath"), !custom.isEmpty {
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: custom, isDirectory: &isDir), !isDir.boolValue {
                return URL(fileURLWithPath: custom)
            }
        }
        let fm = FileManager.default
        if let resources = Bundle.main.resourceURL {
            let bundled = resources
                .appendingPathComponent("engine-bridge/dist/engine-bridge.cjs")
            if fm.fileExists(atPath: bundled.path) { return bundled }
        }
        // 开发布局：build/Debug/UITWalkthrough.app → 逐级向上最多 8 层找仓库内 swiftui/engine-bridge/dist
        var dir = Bundle.main.bundleURL
        for _ in 0..<8 {
            dir = dir.deletingLastPathComponent()
            let candidate = dir.appendingPathComponent("swiftui/engine-bridge/dist/engine-bridge.cjs")
            if fm.fileExists(atPath: candidate.path) { return candidate }
        }
        return nil
    }

    /// node 可执行文件解析：Homebrew 常见路径 → zsh 登录 shell 兜底（覆盖 nvm 安装）
    private static let nodePath: String? = {
        let fm = FileManager.default
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
            if fm.fileExists(atPath: candidate) { return candidate }
        }
        // zsh -lc "command -v node"：登录 shell 会加载 nvm/nodenv 等 profile
        let zsh = Process()
        zsh.executableURL = URL(fileURLWithPath: "/bin/zsh")
        zsh.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        zsh.standardOutput = pipe
        zsh.standardError = FileHandle.nullDevice
        do {
            try zsh.run()
            zsh.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let path = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return (!path.isEmpty && fm.fileExists(atPath: path)) ? path : nil
        } catch {
            return nil
        }
    }()

    /// 同步执行 CLI（在后台线程调用）：先写 stdin 并关闭写端再读 stdout，防管道死锁
    /// （引擎启动后立即 readFileSync(0) 读到 EOF 才会写 stdout，MB 级入参安全）
    private static func runSyncRaw(command: String, stdin: Data) throws -> Data {
        guard let node = nodePath else { throw EngineBridgeError.nodeNotFound }
        guard let cli = cliURL() else { throw EngineBridgeError.cliNotFound }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [cli.path, command]
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        // 不继承 GUI 应用的环境变量问题：node 需要 HOME 定位 nvm，保留默认环境即可
        try process.run()
        stdinPipe.fileHandleForWriting.write(stdin)
        try? stdinPipe.fileHandleForWriting.close()

        let stdout = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let stderr = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let detail = String(data: stderr, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            throw EngineBridgeError.launchFailed(detail.isEmpty ? "node 进程退出码 \(process.terminationStatus)" : detail)
        }
        return stdout
    }

    /// 异步调用子命令：payload 组装为 JSON 入参，ok=false 时抛 commandFailed(message)
    static func run<T: Decodable>(
        command: String,
        payload: [String: Any],
        as type: T.Type
    ) async throws -> T {
        let stdin = try JSONSerialization.data(withJSONObject: payload)
        let stdout = try await Task.detached(priority: .userInitiated) {
            try runSyncRaw(command: command, stdin: stdin)
        }.value

        guard let obj = try JSONSerialization.jsonObject(with: stdout) as? [String: Any] else {
            throw EngineBridgeError.commandFailed("引擎输出不是合法 JSON 对象")
        }
        guard obj["ok"] as? Bool == true else {
            throw EngineBridgeError.commandFailed(obj["message"] as? String ?? "引擎调用失败")
        }
        return try JSONDecoder().decode(T.self, from: stdout)
    }

    /// 异步调用子命令（不校验 ok 字段）：spec-sync 的 variableDenied 分支返回 ok=false 且携带降级结构，需要原样解码透传
    static func runRaw<T: Decodable>(
        command: String,
        payload: [String: Any],
        as type: T.Type
    ) async throws -> T {
        let stdin = try JSONSerialization.data(withJSONObject: payload)
        let stdout = try await Task.detached(priority: .userInitiated) {
            try runSyncRaw(command: command, stdin: stdin)
        }.value
        return try JSONDecoder().decode(T.self, from: stdout)
    }

    // MARK: - 子命令便捷封装

    /// 结构化样式比对（镜像 walkthrough:compare IPC；pairs 不回传）
    static func compare(
        designRootJSON: Data,
        domRootJSON: Data,
        tolerance: ToleranceConfig,
        viewport: CGSize,
        includeSizeSpacing: Bool
    ) async throws -> EngineCompareDTO {
        try await run(
            command: "compare",
            payload: [
                "designRoot": try JSONSerialization.jsonObject(with: designRootJSON),
                "domRoot": try JSONSerialization.jsonObject(with: domRootJSON),
                "tolerance": tolerancePayload(tolerance),
                "viewport": sizePayload(viewport),
                "includeSizeSpacing": includeSizeSpacing
            ],
            as: EngineCompareDTO.self
        )
    }

    /// 轻量读取 Figma Frame 尺寸（视口宽度自动匹配用）
    static func figmaNodeSize(pat: String, figmaUrl: String, proxy: String?) async throws -> EngineNodeSizeDTO {
        var payload: [String: Any] = ["pat": pat, "figmaUrl": figmaUrl]
        if let proxy { payload["proxy"] = proxy }
        return try await run(command: "figma-node-size", payload: payload, as: EngineNodeSizeDTO.self)
    }

    /// 拉取设计稿树 + Frame 截图（PNG / 树 JSON 分别写入指定文件路径）
    static func figmaDesign(
        pat: String,
        figmaUrl: String,
        scale: Double?,
        proxy: String?,
        outScreenshot: URL,
        outRoot: URL
    ) async throws -> EngineFigmaDesignDTO {
        var payload: [String: Any] = [
            "pat": pat,
            "figmaUrl": figmaUrl,
            "outScreenshot": outScreenshot.path,
            "outRoot": outRoot.path
        ]
        if let scale { payload["scale"] = scale }
        if let proxy { payload["proxy"] = proxy }
        return try await run(command: "figma-design", payload: payload, as: EngineFigmaDesignDTO.self)
    }

    /// 设计规范 Token 校验（tokens 元素形如 {kind, name, value}，value 为已解析的 Token 值对象）
    static func checkSpec(
        domRootJSON: Data,
        tokens: [[String: Any]],
        viewport: CGSize,
        tolerance: ToleranceConfig
    ) async throws -> EngineSpecDTO {
        try await run(
            command: "check-spec",
            payload: [
                "domRoot": try JSONSerialization.jsonObject(with: domRootJSON),
                "tokens": tokens,
                "viewport": sizePayload(viewport),
                "tolerance": tolerancePayload(tolerance)
            ],
            as: EngineSpecDTO.self
        )
    }

    /// 元素清单一致性校验（图片加载失败 / 元素缺失 / 文案不一致）
    static func checkElements(
        designRootJSON: Data,
        domRootJSON: Data,
        frameSize: CGSize,
        viewport: CGSize
    ) async throws -> EngineElementDTO {
        try await run(
            command: "check-elements",
            payload: [
                "designRoot": try JSONSerialization.jsonObject(with: designRootJSON),
                "domRoot": try JSONSerialization.jsonObject(with: domRootJSON),
                "frameSize": sizePayload(frameSize),
                "viewport": sizePayload(viewport)
            ],
            as: EngineElementDTO.self
        )
    }

    /// 无障碍检查
    static func checkA11y(domRootJSON: Data, viewport: CGSize) async throws -> EngineA11yDTO {
        try await run(
            command: "check-a11y",
            payload: [
                "domRoot": try JSONSerialization.jsonObject(with: domRootJSON),
                "viewport": sizePayload(viewport)
            ],
            as: EngineA11yDTO.self
        )
    }

    // MARK: - 载荷工具

    private static func sizePayload(_ size: CGSize) -> [String: Double] {
        ["width": Double(size.width), "height": Double(size.height)]
    }

    private static func tolerancePayload(_ t: ToleranceConfig) -> [String: Double] {
        [
            "size": t.size, "typography": t.typography, "spacing": t.spacing,
            "radius": t.radius, "color": t.color, "border": t.border
        ]
    }
}
