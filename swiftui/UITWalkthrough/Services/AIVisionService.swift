import Foundation

// MARK: - AI 视觉走查服务（对齐 Electron src/main/ai.ts）
//
// OpenAI 兼容协议 chat/completions 调用：SSE 流式接收 + 空闲看门狗 + 直连失败走代理重试。
// Electron 走 ipcMain（proxyFetch 代理链），原生壳无 Node 主进程，改用 URLSession 原生实现；
// 语义（重试链路、超时文案、JSON 提取、标注归一化）与 Electron 版一一对应。

/// AI 模型配置（OpenAI 兼容协议；config.json `aiModels` 数组元素）
struct AIModelConfig: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var name: String
    var baseUrl: String
    var apiKey: String
    var model: String
    /// 是否支持图像输入（走查需多模态模型）
    var vision: Bool
    var createdAt: Double
}

/// AI 标注候选（归一化坐标；与 Electron AIAnnotation 结构一致）
struct AIAnnotation: Sendable {
    var targetImage: TargetImage
    var shape: AnnotationShape
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    var description: String
    var severity: Severity
    var category: IssueCategory
    var suggestion: AISuggestion
}

/// chat/completions 返回
struct AIChatResult: Sendable {
    var text: String
    var finishReason: String
}

/// 自动走查检查项注入（来自面板「自定义检查项」配置，对齐 WalkOptionsInput）
struct WalkOptionsInput: Sendable {
    var dimensionLabels: [String] = []
    var depth: WalkDepth = .standard
    var analysisLabels: [String] = []
    var style: WalkOutputStyle = .detailed
    /// 项目绑定规范的 Token 摘要（按类分组、截断），触发「规范合规」语义检查
    var specSummary: String?
}

/// ai:annotate 返回结构
struct AIAnnotateResult: Sendable {
    var ok: Bool
    var issues: [AIAnnotation]
    var message: String
}

/// ai:test 返回结构
struct AITestResult: Sendable {
    var ok: Bool
    var latencyMs: Double?
    var message: String
}

enum AIVisionError: LocalizedError {
    case message(String)
    var errorDescription: String? { self.errorLocalizedMessage }
    var errorLocalizedMessage: String {
        switch self {
        case .message(let m): m
        }
    }
}

enum AIVisionService {
    // MARK: - 模型配置

    static func chatURL(_ baseUrl: String) -> String {
        var trimmed = baseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        return trimmed.hasSuffix("/chat/completions") ? trimmed : "\(trimmed)/chat/completions"
    }

    /// 按 id 取模型配置（对齐 getModel：缺失/不完整时给出中文提示）
    static func getModel(_ modelId: String) throws -> AIModelConfig {
        let config = AppConfigStore.load()
        let models = config.aiModels ?? []
        guard let model = models.first(where: { $0.id == modelId }) else {
            throw AIVisionError.message("未找到该模型配置，请到「AI 模型管理」检查")
        }
        if model.baseUrl.trimmingCharacters(in: .whitespaces).isEmpty
            || model.apiKey.trimmingCharacters(in: .whitespaces).isEmpty
            || model.model.trimmingCharacters(in: .whitespaces).isEmpty {
            throw AIVisionError.message("模型配置不完整（Base URL / API Key / 模型名）")
        }
        return model
    }

    /// 默认模型 id：显式配置优先，否则取第一个（对齐面板 modelId 解析规则）
    static func defaultModelId() -> String {
        let config = AppConfigStore.load()
        return config.aiDefaultModelId ?? config.aiModels?.first?.id ?? ""
    }

    // MARK: - 请求构造

    private static func makeRequest(url: String, model: AIModelConfig, body: [String: Any]) throws -> URLRequest {
        guard let payload = try? JSONSerialization.data(withJSONObject: body) else {
            throw AIVisionError.message("请求体序列化失败")
        }
        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(model.apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = payload
        return request
    }

    private static func chatBody(
        model: AIModelConfig,
        messages: [[String: Any]],
        maxTokens: Int,
        stream: Bool,
        extraBody: [String: Any]?
    ) -> [String: Any] {
        var body: [String: Any] = [
            "model": model.model,
            "messages": messages,
            "max_tokens": maxTokens,
            "temperature": 0.2
        ]
        if stream { body["stream"] = true }
        if let extraBody { body.merge(extraBody) { _, new in new } }
        return body
    }

    /// 代理会话（http://host:port 形式；对齐 proxyFetch 的转发语义）
    private static func proxiedSession(_ proxy: String?) -> URLSession {
        guard let proxy, !proxy.isEmpty,
              let comps = URLComponents(string: proxy), let host = comps.host else {
            return URLSession.shared
        }
        let port = comps.port ?? (comps.scheme == "https" ? 443 : 80)
        let cfg = URLSessionConfiguration.ephemeral
        cfg.connectionProxyDictionary = [
            kCFNetworkProxiesHTTPEnable as String: true,
            kCFNetworkProxiesHTTPProxy as String: host,
            kCFNetworkProxiesHTTPPort as String: port,
            "httpProxy": "\(host):\(port)",
            "httpsProxy": "\(host):\(port)"
        ]
        return URLSession(configuration: cfg)
    }

    /// 网络层错误 → 统一提示（对齐 callChat 直连失败后的兜底文案）
    private static func networkFailureMessage(_ err: Error, timeoutMs: Double) -> AIVisionError {
        if let urlError = err as? URLError, urlError.code == .timedOut {
            return .message("请求超时（\(Int(timeoutMs / 1000)) 秒无响应）：请检查地址/端口是否可达，或 Base URL 是否需要以 /v1 结尾")
        }
        if err is CancellationError {
            return .message("请求超时（\(Int(timeoutMs / 1000))s），请检查模型服务是否可达")
        }
        return .message(
            "网络请求失败（\(err.localizedDescription)）：模型服务不可达。请确认 Base URL 正确且服务已启动；若模型服务在外网，可在「设置 → MCP 管理」配置代理地址后重试"
        )
    }

    /// 非 2xx 状态 → 错误（404 给出 /v1 提示，对齐 Electron）
    private static func statusError(_ status: Int, bodyText: String, baseUrl: String) -> AIVisionError {
        if status == 404 {
            return .message("接口返回 404：\(chatURL(baseUrl)) 不存在。请检查 Base URL 是否需要以 /v1 结尾（如 http://117.73.0.134:9875/v1）")
        }
        let snippet = String(bodyText.prefix(300))
        return .message("接口返回 \(status)\(snippet.isEmpty ? "" : "：\(snippet)")")
    }

    // MARK: - 非流式调用（ai:test）

    private static func sendOnce(
        _ request: URLRequest, proxy: String?, timeoutMs: Double, baseUrl: String
    ) async throws -> (data: Data, status: Int) {
        let session = proxiedSession(proxy)
        var request = request
        request.timeoutInterval = timeoutMs / 1000
        do {
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            return (data, status)
        } catch {
            throw networkFailureMessage(error, timeoutMs: timeoutMs)
        }
    }

    /// 调用 OpenAI 兼容 chat/completions（非流式；直连失败走代理重试一次）
    static func callChat(
        model: AIModelConfig,
        messages: [[String: Any]],
        maxTokens: Int,
        timeoutMs: Double = 60000,
        proxy: String? = nil,
        extraBody: [String: Any]? = nil
    ) async throws -> AIChatResult {
        let url = chatURL(model.baseUrl)
        let body = chatBody(model: model, messages: messages, maxTokens: maxTokens, stream: false, extraBody: extraBody)
        let request = try makeRequest(url: url, model: model, body: body)

        let result: (data: Data, status: Int)
        do {
            result = try await sendOnce(request, proxy: nil, timeoutMs: timeoutMs, baseUrl: model.baseUrl)
        } catch {
            // 内网 LLM 地址通常可直连：先直连，网络层失败再走代理链重试
            guard let proxy, !proxy.isEmpty else { throw error }
            result = try await sendOnce(request, proxy: proxy, timeoutMs: timeoutMs, baseUrl: model.baseUrl)
        }
        guard (200..<300).contains(result.status) else {
            throw statusError(result.status, bodyText: String(data: result.data, encoding: .utf8) ?? "", baseUrl: model.baseUrl)
        }
        guard
            let obj = try? JSONSerialization.jsonObject(with: result.data) as? [String: Any],
            let choices = obj["choices"] as? [[String: Any]],
            let choice = choices.first
        else {
            throw AIVisionError.message("接口返回内容不是有效 JSON，请确认地址为 OpenAI 兼容接口")
        }
        let finishReason = choice["finish_reason"] as? String ?? (choice["finish_reason"].map { "\($0)" } ?? "")
        let message = choice["message"] as? [String: Any]
        var content = message?["content"] as? String ?? ""
        if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // 思考型模型可能把 max_tokens 花在 reasoning_content 上，content 为空时回退用思考内容提取结果
            content = message?["reasoning_content"] as? String ?? ""
        }
        if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw AIVisionError.message("模型返回内容为空")
        }
        return AIChatResult(text: content, finishReason: finishReason)
    }

    // MARK: - SSE 流式调用

    /// 空闲计时器（看门狗共享状态，读流与看门狗两个子任务并发访问）
    private final class IdleClock: @unchecked Sendable {
        private let lock = NSLock()
        private var last = Date()
        func touch() { lock.lock(); last = Date(); lock.unlock() }
        func idleSeconds() -> TimeInterval { lock.lock(); defer { lock.unlock() }; return Date().timeIntervalSince(last) }
    }

    /// SSE 流式读取：data 行增量解析 content / reasoning_content，空闲与整体超时经任务组取消
    private static func callChatStream(
        model: AIModelConfig,
        messages: [[String: Any]],
        maxTokens: Int,
        timeoutMs: Double,
        idleMs: Double,
        proxy: String?,
        extraBody: [String: Any]?,
        onProgress: @escaping @MainActor (Int, Double) async -> Void
    ) async throws -> AIChatResult {
        let url = chatURL(model.baseUrl)
        let body = chatBody(model: model, messages: messages, maxTokens: maxTokens, stream: true, extraBody: extraBody)
        var request = try makeRequest(url: url, model: model, body: body)
        request.timeoutInterval = timeoutMs / 1000

        func openStream(_ useProxy: Bool) async throws -> (URLSession.AsyncBytes, Int) {
            let session = useProxy ? proxiedSession(proxy) : URLSession.shared
            do {
                let (bytes, response) = try await session.bytes(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                return (bytes, status)
            } catch {
                if useProxy { throw networkFailureMessage(error, timeoutMs: timeoutMs) }
                throw error
            }
        }

        // 直连失败（网络层）时走代理重试
        let stream: (URLSession.AsyncBytes, Int)
        do {
            stream = try await openStream(false)
        } catch let directError as AIVisionError {
            guard let proxy, !proxy.isEmpty else { throw directError }
            stream = try await openStream(true)
        }
        let (bytes, status) = stream
        guard (200..<300).contains(status) else {
            // 流式接口错误响应通常为普通 JSON 文本
            var text = ""
            for try await line in bytes.lines { text += line; if text.count > 2000 { break } }
            throw statusError(status, bodyText: text, baseUrl: model.baseUrl)
        }

        let clock = IdleClock()
        let startedAt = nowMs()

        return try await withThrowingTaskGroup(of: AIChatResult.self) { group in
            // 子任务 1：SSE 读取循环
            group.addTask {
                var content = ""
                var reasoning = ""
                var finishReason = ""
                for try await line in bytes.lines {
                    clock.touch()
                    let t = line.trimmingCharacters(in: .whitespaces)
                    guard t.hasPrefix("data:") else { continue }
                    let payload = t.dropFirst(5).trimmingCharacters(in: .whitespaces)
                    if payload == "[DONE]" { continue }
                    if let data = payload.data(using: .utf8),
                       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let choices = obj["choices"] as? [[String: Any]],
                       let choice = choices.first {
                        if let delta = choice["delta"] as? [String: Any] {
                            if let c = delta["content"] as? String { content += c }
                            if let r = delta["reasoning_content"] as? String { reasoning += r }
                        }
                        if let fr = choice["finish_reason"] as? String { finishReason = fr }
                        else if let fr = choice["finish_reason"], !(fr is NSNull) { finishReason = "\(fr)" }
                    }
                    await onProgress(content.count + reasoning.count, nowMs() - startedAt)
                }
                let text = content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? reasoning : content
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    throw AIVisionError.message("模型返回内容为空")
                }
                return AIChatResult(text: text, finishReason: finishReason)
            }
            // 子任务 2：空闲看门狗（无新数据超时判定服务卡死）
            group.addTask {
                while true {
                    try await Task.sleep(for: .seconds(3))
                    if clock.idleSeconds() > idleMs / 1000 {
                        throw AIVisionError.message("请求超时（\(Int(idleMs / 1000))s 无新数据）：模型服务响应中断，请重试")
                    }
                }
            }
            // 子任务 3：整体硬超时
            group.addTask {
                try await Task.sleep(for: .seconds(timeoutMs / 1000))
                throw AIVisionError.message("请求超时（\(Int(timeoutMs / 1000))s），请检查模型服务是否可达")
            }

            guard let first = try await group.next() else {
                throw AIVisionError.message("模型返回内容为空")
            }
            group.cancelAll()
            return first
        }
    }

    // MARK: - JSON 提取与标注归一化

    /// 从模型回复中提取 JSON（容忍 ```json 包裹与前后缀文字）
    static func extractJSONObject(_ text: String) throws -> [String: Any] {
        var raw = text
        if let regex = try? NSRegularExpression(pattern: "```(?:json)?\\s*([\\s\\S]*?)```", options: .caseInsensitive),
           let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
           match.numberOfRanges > 1, let range = Range(match.range(at: 1), in: text) {
            raw = String(text[range])
        }
        guard let start = raw.firstIndex(of: "{"), let end = raw.lastIndex(of: "}"), start < end else {
            let snippet = text.prefix(160).replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            throw AIVisionError.message("模型未返回有效的 JSON 结果（响应片段：\(snippet)）")
        }
        let slice = String(raw[start...end])
        guard let obj = (try? JSONSerialization.jsonObject(with: Data(slice.utf8))) as? [String: Any] else {
            let snippet = text.prefix(160).replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            throw AIVisionError.message("模型未返回有效的 JSON 结果（响应片段：\(snippet)）")
        }
        return obj
    }

    private static func clamp01(_ v: Any?) -> Double {
        let n: Double
        switch v {
        case let d as Double: n = d
        case let i as Int: n = Double(i)
        case let s as String: n = Double(s) ?? 0
        default: n = 0
        }
        return min(1, max(0, n.isFinite ? n : 0))
    }

    private static func str(_ v: Any?) -> String {
        switch v {
        case let s as String: return s
        case let n as NSNumber: return n.stringValue
        default: return ""
        }
    }

    /// 校验并归一化模型输出的标注候选（对齐 normalizeIssues）
    static func normalizeIssues(_ raw: Any?) -> [AIAnnotation] {
        guard let list = raw as? [Any] else { return [] }
        let severities = ["major", "minor", "suggestion"]
        let categories = ["spacing", "typography", "color", "style", "interaction", "compatibility"]
        let shapes = ["rect", "point", "text", "measure", "picker"]
        var out: [AIAnnotation] = []
        for item in list {
            guard let o = item as? [String: Any] else { continue }
            let description = str(o["description"]).trimmingCharacters(in: .whitespacesAndNewlines)
            if description.isEmpty { continue }
            let shapeRaw = str(o["shape"])
            let shape = shapes.contains(shapeRaw) ? AnnotationShape(rawValue: shapeRaw)! : .rect
            // 点位/文字/吸色只保留坐标点，宽高置 0；测量保留宽高矢量
            let zeroDims = shape == .point || shape == .text || shape == .picker
            let sug = o["suggestion"] as? [String: Any] ?? [:]
            let properties = String(str(sug["properties"]).prefix(120))
            out.append(AIAnnotation(
                targetImage: str(o["targetImage"]) == "design" ? .design : .screenshot,
                shape: shape,
                x: clamp01(o["x"]),
                y: clamp01(o["y"]),
                width: zeroDims ? 0 : clamp01(o["width"]),
                height: zeroDims ? 0 : clamp01(o["height"]),
                description: String(description.prefix(200)),
                severity: severities.contains(str(o["severity"])) ? Severity(rawValue: str(o["severity"]))! : .minor,
                category: categories.contains(str(o["category"])) ? IssueCategory(rawValue: str(o["category"]))! : .spacing,
                suggestion: AISuggestion(
                    current: String(str(sug["current"]).prefix(300)),
                    fix: String(str(sug["fix"]).prefix(300)),
                    properties: properties.isEmpty ? nil : properties
                )
            ))
        }
        return out
    }

    // MARK: - Prompt（全文对齐 SYSTEM_PROMPT / walkOptionsPrompt）

    static let systemPrompt = """
    你是资深 UI 设计师，正在对开发实现页面做上线前的肉眼验收走查。用户会提供两张图：第一张是 Figma 设计稿（验收基准），第二张是开发实现的页面截图。请像设计师验收一样，用眼睛对比两张图，找出「开发实现和设计稿看起来不一样、且真实需要修改」的视觉问题，输出 JSON。

    只报告肉眼可辨认、确实需要开发修改的问题。以下情况必须跳过、不要报告：
    - 两张图内容数据不同导致的差异（列表条数不同、图片内容不同、用户名/时间等动态文案不同）
    - 字体渲染抗锯齿、亚像素级模糊等截图天然差异
    - 你不确定是否真的是问题的地方（宁可漏报，不可误报）
    - 设计稿中未展示、但属于合理响应式布局差异的部分

    检查清单（逐项对比两张图）：
    1. 文字类：文字被截断、溢出容器、换行位置异常、字体不对、字号视觉上明显不一致、文案与设计稿不一样
    2. 对齐布局：元素之间不对齐、上下错位、元素意外重叠、间距视觉上明显过大或过小
    3. 图标图片：图标缺失、图标或图片变形拉伸、颜色不对、图片加载失败、出现异常占位图
    4. 组件状态：按钮/输入框的禁用、报错等状态样式缺失或异常，弹窗/浮层样式异常
    5. 色彩：颜色明显偏差（色相/深浅一眼能看出不一样）、文字与背景对比度过低看不清
    6. 排版：多行文本行高拥挤或过松、标题层级视觉错乱（该大的不大、该粗的不粗）

    严格只输出一个 JSON 对象，不要任何解释文字，格式：
    {"issues":[{"targetImage":"screenshot","shape":"rect","x":0.1,"y":0.2,"width":0.3,"height":0.05,"description":"主按钮文案被截断，末尾缺少省略号","severity":"major","category":"typography","suggestion":{"current":"按钮文字显示不全","fix":"检查按钮宽度或文字截断规则","properties":"text-overflow"}}]}
    字段要求：
    - targetImage：标注画在哪张图上。"screenshot"=开发截图（多数问题标在这里），"design"=设计稿（元素缺失、新增元素等，在设计稿上框选）。两张图尺寸可能不同，坐标相对各自图片独立计算
    - shape 按问题类型选择：
      * "rect"：框选问题元素（文字问题、图标图片、缺失/多余元素、组件状态、排版问题都用 rect）
      * "measure"：间距明显过大/过小时标注间距区间。x,y=起点，width,height=到终点的矢量（垂直间距 width=0，水平间距 height=0）
      * "picker"：颜色明显偏差。x,y=取色点，width/height=0
      * "point"：对齐错位等无明显边界的问题。x,y=问题位置中心点，width/height=0
    - x,y,width,height：归一化坐标（0~1），相对所在图片左上角。先定位问题元素的边界，再除以图片宽高换算；框必须紧贴问题元素
    - description：一句话中文问题描述，站在设计师视角说清「哪里、和设计稿相比怎么了」
    - severity：major=明显影响视觉/可用，必须改；minor=一般差异，应该改；suggestion=可优化的细节
    - category：typography=文字类与排版 / spacing=对齐布局与间距 / color=色彩 / style=图标图片与组件状态样式 / interaction=交互状态缺失（如 hover/禁用/报错态）/ compatibility=适配异常。按问题最贴切的一项选择
    - suggestion：current=开发现状描述，fix=建议改法，properties=涉及的 CSS 属性（可选，如 color、line-height、text-overflow）
    - 控制在 15 个问题以内，按影响从大到小排序；对比后确实无问题时输出 {"issues":[]}
"""

    /// 自动走查检查项注入 prompt（对齐 walkOptionsPrompt）
    static func walkOptionsPrompt(_ wo: WalkOptionsInput?) -> String {
        guard let wo else { return "" }
        var parts: [String] = []
        if !wo.dimensionLabels.isEmpty {
            parts.append("本次重点检查以下维度：\(wo.dimensionLabels.joined(separator: "、"))。")
        }
        switch wo.depth {
        case .strict:
            parts.append("检查深度为严格模式：轻微的字号差异、细微色差、轻微不对齐也要指出。")
        case .loose:
            parts.append("检查深度为宽松模式：仅报告一眼就能看出、影响较大的问题，忽略细微差异。")
        case .standard:
            parts.append("检查深度为标准模式：报告中等及以上影响的视觉问题。")
        }
        if wo.style == .concise {
            parts.append("输出风格为简洁模式：description 用一句话说清问题，不展开分析。")
        } else {
            parts.append("输出风格为详细模式：description 中说明问题定位（哪个元素/区域）、产生原因与影响。")
        }
        if !wo.analysisLabels.isEmpty {
            parts.append("suggestion 字段需覆盖以下分析项：\(wo.analysisLabels.joined(separator: "、"))（current 填写现状与风险，fix 填写修改建议与优化优先级）。")
        }
        let base = parts.isEmpty ? "" : "\n自定义检查项要求：\n\(parts.map { "- \($0)" }.joined(separator: "\n"))"
        // 规范 Token 摘要为多行文本，不进 `- ` 列表，单独成块拼接
        guard let specSummary = wo.specSummary, !specSummary.isEmpty else { return base }
        return """
        \(base)
        设计规范 Token（本项目绑定的设计规范，节选）：
        \(specSummary)
        规范合规检查要求：
        - 除常规差异比对外，额外检查截图元素是否符合上述 Token（颜色搭配、间距节奏、字号层级、圆角/阴影/描边一致性等语义性合规）
        - 命中规范问题时按属性选 category（color/spacing/typography/style），description 中注明应使用的规范 Token 名与值
        - 规范问题与设计稿差异问题为同一处时只输出一条，避免重复标注
        """
    }

    // MARK: - 对外入口

    /// 测试模型连通性（对齐 ai:test：2048 tokens、20s 超时）
    static func aiTest(_ modelId: String) async -> AITestResult {
        let start = nowMs()
        do {
            let model = try getModel(modelId)
            let proxy = AppConfigStore.load().figmaProxy
            _ = try await callChat(
                model: model,
                messages: [["role": "user", "content": "回复\"ok\"两个字母即可"]],
                maxTokens: 2048,
                timeoutMs: 20000,
                proxy: proxy
            )
            return AITestResult(ok: true, latencyMs: nowMs() - start, message: "连接成功")
        } catch {
            return AITestResult(ok: false, latencyMs: nil, message: error.localizedDescription)
        }
    }

    /// AI 识别走查问题：输入设计稿 + 开发截图（原始 PNG），输出候选标注（对齐 ai:annotate）
    /// - Parameter onProgress: 流式接收进度（参数 = 已接收字符数、耗时 ms）
    static func aiAnnotate(
        modelId: String,
        pageName: String,
        platformLabel: String,
        designPNG: Data,
        shotPNG: Data,
        skillGuides: [String] = [],
        walkOptions: WalkOptionsInput? = nil,
        onProgress: @escaping @MainActor (Int, Double) async -> Void
    ) async -> AIAnnotateResult {
        do {
            let model = try getModel(modelId)
            guard model.vision else {
                return AIAnnotateResult(ok: false, issues: [], message: "当前模型未开启「图像输入」，请到 AI 模型管理中更换或调整")
            }
            guard !designPNG.isEmpty, !shotPNG.isEmpty else {
                return AIAnnotateResult(ok: false, issues: [], message: "缺少设计稿或开发截图，无法识别")
            }
            let proxy = AppConfigStore.load().figmaProxy

            // SkillHub 技能指引：作为额外检查要点注入
            let guides = skillGuides.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            let guideText = guides.isEmpty
                ? ""
                : "\n请同时结合以下自定义走查技能/检查要点进行识别（逐条核对这些要点，并在描述中注明命中的要点）：\n"
                    + guides.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
            let systemPrompt = Self.systemPrompt + walkOptionsPrompt(walkOptions)
            let userText = "页面名称：\(pageName.isEmpty ? "未命名页面" : pageName)\n端类型：\(platformLabel.isEmpty ? "未知" : platformLabel)\n第一张图 = 设计稿，第二张图 = 开发实现截图。请按系统要求输出 JSON。\(guideText)"

            // 使用原始图片：AI 返回归一化坐标基于其接收到的图片，若图片被压缩/缩放，
            // 坐标会与实际渲染的原始图片产生系统性偏移，导致标注错位。
            // 每张图前插入文字标签，避免模型混淆两张图导致坐标画错位置
            let designDataUrl = "data:image/png;base64,\(designPNG.base64EncodedString())"
            let shotDataUrl = "data:image/png;base64,\(shotPNG.base64EncodedString())"
            let content: [[String: Any]] = [
                ["type": "text", "text": userText],
                ["type": "text", "text": "【第 1 张图：UI 设计稿】所有 design 标注的坐标相对这张图计算"],
                ["type": "image_url", "image_url": ["url": designDataUrl]],
                ["type": "text", "text": "【第 2 张图：开发实现截图】所有 screenshot 标注的坐标相对这张图计算"],
                ["type": "image_url", "image_url": ["url": shotDataUrl]]
            ]
            let messages: [[String: Any]] = [
                ["role": "system", "content": systemPrompt],
                ["role": "user", "content": content]
            ]

            // 进度节流 500ms（对齐 ai.ts onProgress 逻辑）
            final class Throttle: @unchecked Sendable {
                var lastEmit = 0.0
            }
            let throttle = Throttle()
            let progress: @MainActor (Int, Double) async -> Void = { chars, elapsedMs in
                let now = nowMs()
                guard now - throttle.lastEmit >= 500 else { return }
                throttle.lastEmit = now
                await onProgress(chars, elapsedMs)
            }

            // 模型 max_token 上限 200K，识别请求放宽到 16384，
            // 避免思考型模型把 token 耗在 reasoning 上导致 JSON 被截断
            let first = try await callChatStream(
                model: model,
                messages: messages,
                maxTokens: 16384,
                timeoutMs: 600000,
                idleMs: 60000,
                proxy: proxy,
                extraBody: nil,
                onProgress: progress
            )
            var issues: [AIAnnotation]
            do {
                issues = normalizeIssues(try extractJSONObject(first.text)["issues"])
            } catch {
                // 思考型模型可能把 max_tokens 全部耗在 reasoning 上导致响应截断（finish_reason=length），
                // 此时自动携带「关闭思考」参数重试一次（vLLM 标准参数，其他服务仅在截断时才会触发）
                guard first.finishReason == "length" else { throw error }
                let retry = try await callChatStream(
                    model: model,
                    messages: messages,
                    maxTokens: 16384,
                    timeoutMs: 600000,
                    idleMs: 60000,
                    proxy: proxy,
                    extraBody: ["chat_template_kwargs": ["enable_thinking": false]],
                    onProgress: progress
                )
                issues = normalizeIssues(try extractJSONObject(retry.text)["issues"])
            }
            return AIAnnotateResult(ok: true, issues: issues, message: "识别完成，共 \(issues.count) 条候选")
        } catch {
            return AIAnnotateResult(ok: false, issues: [], message: error.localizedDescription)
        }
    }
}
