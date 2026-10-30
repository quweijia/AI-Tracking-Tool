import Foundation
import AppKit
import SwiftData

// MARK: - 自动走查状态模型（对齐 Electron AutoWalkPanel 的状态与流程编排）
//
// 流程：startWalk（读 Figma 画板尺寸 → 打开采集窗口）→ DevCaptureWindow 采集回传
// → handleCaptured（拉取 Figma 设计稿 → 保存双图 → 程序轨三校验落库 → AI 视觉走查轨落库）→ runStructured（高级调试结构化比对）。
// AI 视觉走查轨经 AIVisionService（URLSession 直连 OpenAI 兼容接口）完成，注册 AiTaskStore 后台任务跨页面运行。
// 低置信度匹配确认抽屉（MatchConfirmDrawer）后续里程碑实现，当前仅报条数。

/// 面板消息条（ok = 绿色成功 / 红色失败）
struct WalkMessage: Equatable {
    var ok: Bool
    var text: String
}

/// 结果层筛选（对齐 AutoWalkPanel 筛选 chips：来源维度）
enum WalkLayerFilter: CaseIterable, Identifiable {
    case all
    case structured
    case spec
    case visual
    case element
    case a11y
    case manual

    var id: Self { self }

    var label: String {
        switch self {
        case .all: "全部"
        case .structured: "结构化"
        case .spec: "规范"
        case .visual: "视觉"
        case .element: "元素"
        case .a11y: "无障碍"
        case .manual: "手动"
        }
    }

    func matches(_ issue: Issue) -> Bool {
        switch self {
        case .all: true
        case .structured: issue.source == .structured
        case .spec: issue.source == .spec
        case .visual: issue.source == .visual
        case .element: issue.source == .element
        case .a11y: issue.source == .a11y
        // 手动层：手动标注来源（旧数据缺省视为手动）
        case .manual: issue.source == .manual || issue.source == nil
        }
    }

    func count(in issues: [Issue]) -> Int {
        issues.lazy.filter(matches).count
    }
}

/// 最近一次走查的采集数据（结构化比对 / AI 视觉走查依赖；应用重启后失效）
struct WalkLastRun {
    var designRootJSON: Data
    var domRootJSON: Data
    var viewport: CGSize
    var frameSize: CGSize?
    /// 原始双图 PNG（AI 识别 base64 上传、测量标注换算 px、吸色双图取样用）
    var designPNG: Data
    var shotPNG: Data
}

@MainActor
@Observable
final class AutoWalkModel {
    /// 所属页面 id（面板切页时判断是否重建模型）
    let pageID: String

    // 表单输入
    var figUrlInput = ""
    var devUrlInput = ""

    // 运行态
    private(set) var running = false
    private(set) var waiting = false
    var msg: WalkMessage?

    // 检查项与容差（持久化在 config.json，对齐 walkCheckOptions / walkTolerance / walkAdvancedDebug）
    var checkOptions: WalkCheckOptions = .defaultValue
    var tolerance: ToleranceConfig = .defaultValue
    var advancedDebug = false

    /// Figma 画板尺寸（走查视口宽度来源）
    private(set) var figmaWidth: Double?
    private(set) var figmaHeight: Double?

    // 结果筛选
    var layerFilter: WalkLayerFilter = .all
    var catFilter: IssueCategory?

    /// 最近一次走查采集数据（结构化比对输入）
    private(set) var lastRun: WalkLastRun?
    /// 活跃采集窗口（等待回传期间持用）
    private(set) var captureController: DevCaptureWindowController?

    // handleCaptured 所需上下文（采集窗口回传时使用）
    private var pendingPage: WalkthroughPage?
    private var pendingContext: ModelContext?

    init(page: WalkthroughPage) {
        pageID = page.id
        figUrlInput = page.figmaUrl ?? ""
        devUrlInput = page.devUrl ?? ""
        loadConfig()
    }

    /// 读取应用配置（容差 / 检查项 / 高级调试）
    func loadConfig() {
        let cfg = AppConfigStore.load()
        tolerance = ToleranceConfig.normalize(cfg.walkTolerance)
        checkOptions = WalkCheckOptions.normalize(cfg.walkCheckOptions)
        advancedDebug = cfg.walkAdvancedDebug == true
    }

    /// 当前检查项写回配置（对齐 Electron 面板即改即存）
    func persistConfig() {
        var cfg = AppConfigStore.load()
        cfg.walkTolerance = tolerance
        cfg.walkCheckOptions = checkOptions
        cfg.walkAdvancedDebug = advancedDebug
        AppConfigStore.save(cfg)
    }

    // MARK: - 开始走查（对齐 startWalk）

    /// 解析并校验开发页面 URL：补 http:// 前缀，空串报错
    /// （Electron 还拦截应用自身地址防内置浏览器嵌套假死；原生壳无自身 web 端口，无需拦截）
    static func resolveDevURL(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.lowercased().hasPrefix("http://") || trimmed.lowercased().hasPrefix("https://") {
            return trimmed
        }
        return "http://\(trimmed)"
    }

    /// 开始走查入口（重新走查确认由视图层 confirmationDialog 处理后调用）
    func startWalk(context: ModelContext, page: WalkthroughPage) async {
        guard !running, !waiting else { return }
        running = true
        defer { running = false }

        // 1. 开发 URL 必填
        guard let devUrl = Self.resolveDevURL(devUrlInput) else {
            msg = WalkMessage(ok: false, text: "请先填写开发环境页面 URL")
            return
        }
        // 2. Figma 链接必填
        let figUrl = figUrlInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !figUrl.isEmpty else {
            msg = WalkMessage(ok: false, text: "请先填写 Figma 设计稿连接（选中 Frame → 右键 Copy link）")
            return
        }
        // 3. Figma PAT
        let cfg = AppConfigStore.load()
        guard let pat = cfg.figmaPAT else {
            msg = WalkMessage(ok: false, text: "未配置 Figma PAT：请到「设置 → MCP 管理」添加带令牌的 MCP 条目")
            return
        }
        msg = WalkMessage(ok: true, text: "正在读取 Figma 画板尺寸...")

        // 4. 读取画板尺寸（视口宽度自动匹配）
        do {
            let size = try await EngineBridge.figmaNodeSize(pat: pat, figmaUrl: figUrl, proxy: cfg.figmaProxy)
            guard size.ok, let width = size.width, width > 0 else {
                msg = WalkMessage(ok: false, text: size.message ?? "读取 Figma 画板尺寸失败")
                return
            }
            figmaWidth = width
            if let h = size.height { figmaHeight = h }
            let vpHeight = min(21600.0, max(240.0, size.height ?? 900))
            // 5. 保存连接与 URL，打开采集窗口（视口精确下发）
            page.figmaUrl = figUrl
            page.devUrl = devUrl
            page.updatedAt = nowMs()
            try? context.save()

            guard let url = URL(string: devUrl) else {
                msg = WalkMessage(ok: false, text: "开发页面 URL 无法解析：\(devUrl)")
                return
            }
            let controller = DevCaptureWindowController(
                url: url,
                viewport: CGSize(width: width, height: vpHeight),
                delegate: self
            )
            captureController = controller
            pendingPage = page
            pendingContext = context
            controller.showWindow()
            waiting = true
            msg = WalkMessage(
                ok: true,
                text: "已打开开发浏览器窗口（视口 \(Int(width)) × \(Int(vpHeight))，宽度自动匹配 Figma 画板「\(size.nodeName ?? "Frame")」）。请等待页面加载完成（内网页面请先登录），然后点击窗口底部的「生成问题标注」。"
            )
        } catch {
            msg = WalkMessage(ok: false, text: error.localizedDescription)
        }
    }

    /// 取消等待：关采集窗口（windowWillClose 会回传 windowClosed，这里同步复位提示）
    func cancelWait() {
        captureController?.closeWindow()
    }

    // MARK: - 采集回传（对齐 handleCaptured 的程序轨部分）

    private func handleCaptured(_ payload: DevCapturePayload, page: WalkthroughPage, context: ModelContext) async {
        running = true
        defer { running = false }
        msg = WalkMessage(ok: true, text: "已接收页面采集结果，正在读取 Figma 设计稿...")

        do {
            let cfg = AppConfigStore.load()
            guard let pat = cfg.figmaPAT else {
                throw EngineBridgeError.commandFailed("未配置 Figma PAT：请到「设置 → MCP 管理」添加带令牌的 MCP 条目")
            }
            let figUrl = figUrlInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? (page.figmaUrl ?? "")
                : figUrlInput.trimmingCharacters(in: .whitespacesAndNewlines)

            // 1. 拉取 Figma 设计稿（截图与树由 CLI 落盘临时文件）
            let tmpDir = FileManager.default.temporaryDirectory
            let shotTmp = tmpDir.appendingPathComponent("figma-shot-\(UUID().uuidString).png")
            let rootTmp = tmpDir.appendingPathComponent("figma-root-\(UUID().uuidString).json")
            defer {
                try? FileManager.default.removeItem(at: shotTmp)
                try? FileManager.default.removeItem(at: rootTmp)
            }
            let fig = try await EngineBridge.figmaDesign(
                pat: pat,
                figmaUrl: figUrl,
                scale: nil,
                proxy: cfg.figmaProxy,
                outScreenshot: shotTmp,
                outRoot: rootTmp
            )
            guard fig.ok else {
                throw EngineBridgeError.commandFailed(fig.message ?? "读取 Figma 设计稿失败")
            }
            let designPNG = try Data(contentsOf: shotTmp)
            let designRootJSON = try Data(contentsOf: rootTmp)

            // 2. 保存走查独立双图（清理旧的走查图，不动手动上传的双图）
            let designRel = try ImageStore.save(designPNG, ext: "png")
            let shotRel = try ImageStore.save(payload.screenshotPNG, ext: "png")
            for old in [page.walkDesignPath, page.walkShotPath].compactMap({ $0 }) {
                ImageStore.delete(old)
            }
            page.walkDesignPath = designRel
            page.walkShotPath = shotRel
            page.updatedAt = nowMs()

            let frameSize = fig.frameSize.map { CGSize(width: $0.width, height: $0.height) }
            lastRun = WalkLastRun(
                designRootJSON: designRootJSON,
                domRootJSON: payload.domRootJSON,
                viewport: payload.viewport,
                frameSize: frameSize,
                designPNG: designPNG,
                shotPNG: payload.screenshotPNG
            )

            // 3. 程序轨三校验（各自独立，失败不阻断主流程；有新结果时覆盖上一轮同 source 行）
            let walkIssues = fetchWalkIssues(context: context, pageId: page.id)

            var specRows: [Issue] = []
            let specToks = loadSpecTokens(context: context, projectId: page.projectId, platform: page.platform)
            do {
                if !specToks.isEmpty {
                    let dto = try await EngineBridge.checkSpec(
                        domRootJSON: payload.domRootJSON,
                        tokens: EngineJSONBox(values: specToks),
                        viewport: payload.viewport,
                        tolerance: tolerance
                    )
                    if let violations = dto.violations, !violations.isEmpty {
                        let rows = violations.enumerated().map { violationToIssue($0.element, index: $0.offset, pageId: page.id) }
                        replaceRows(
                            walkIssues.filter { $0.source == .spec },
                            with: rows,
                            context: context
                        )
                        specRows = rows
                    }
                }
            } catch {
                // 规范校验失败不阻断走查主流程
            }

            var elementRows: [Issue] = []
            do {
                let dto = try await EngineBridge.checkElements(
                    designRootJSON: designRootJSON,
                    domRootJSON: payload.domRootJSON,
                    frameSize: frameSize ?? payload.viewport,
                    viewport: payload.viewport
                )
                if let findings = dto.findings, !findings.isEmpty {
                    let rows = findings.enumerated().map { elementFindingToIssue($0.element, index: $0.offset, pageId: page.id) }
                    replaceRows(
                        walkIssues.filter { $0.source == .element },
                        with: rows,
                        context: context
                    )
                    elementRows = rows
                }
            } catch {
                // 元素清单校验失败不阻断走查主流程
            }

            var a11yRows: [Issue] = []
            if checkOptions.a11y {
                do {
                    let dto = try await EngineBridge.checkA11y(
                        domRootJSON: payload.domRootJSON,
                        viewport: payload.viewport
                    )
                    if let findings = dto.findings, !findings.isEmpty {
                        let rows = findings.enumerated().map { a11yFindingToIssue($0.element, index: $0.offset, pageId: page.id) }
                        replaceRows(
                            walkIssues.filter { $0.source == .a11y },
                            with: rows,
                            context: context
                        )
                        a11yRows = rows
                    }
                } catch {
                    // a11y 检查失败不阻断走查主流程
                }
            }

            try? context.save()

            // 4. AI 视觉走查（后台任务跨页面运行；无默认模型则跳过，仅保留程序轨结果）
            let cfgNow = AppConfigStore.load()
            let modelId = cfgNow.aiDefaultModelId ?? cfgNow.aiModels?.first?.id ?? ""
            let progCount = specRows.count + elementRows.count + a11yRows.count
            guard !modelId.isEmpty else {
                var text = "未配置默认 AI 模型，已跳过 AI 视觉走查"
                if progCount > 0 { text += " 已先行落库 \(progCount) 条程序校验问题" }
                msg = WalkMessage(ok: false, text: text)
                return
            }
            let taskId = AiTaskStore.shared.start(pageId: page.id, pageName: page.pageName)
            msg = WalkMessage(ok: true, text: "AI 视觉走查识别中...")
            let walkOptions = WalkOptionsInput(
                dimensionLabels: WalkCatalog.dimensions.filter { checkOptions.dimensions.contains($0.key) }.map(\.label),
                depth: checkOptions.depth,
                analysisLabels: WalkCatalog.analyses.filter { checkOptions.analysis.contains($0.key) }.map(\.label),
                style: checkOptions.style,
                specSummary: specToks.isEmpty ? nil : Self.formatSpecSummary(specToks)
            )
            let pageNameForTask = page.pageName
            let res = await AIVisionService.aiAnnotate(
                modelId: modelId,
                pageName: page.pageName,
                platformLabel: "",
                designPNG: designPNG,
                shotPNG: payload.screenshotPNG,
                walkOptions: walkOptions,
                onProgress: { chars, elapsedMs in
                    let sec = Int((elapsedMs / 1000).rounded())
                    let note = "\(sec)s · 已接收 \(String(format: "%.1f", Double(chars) / 1000))k 字"
                    AiTaskStore.shared.progressPage(pageName: pageNameForTask, note: note)
                }
            )
            // 任务被用户中断：丢弃结果，不落库
            if AiTaskStore.shared.tasks.first(where: { $0.id == taskId })?.status == .interrupted {
                AiTaskStore.shared.clear(taskId)
                return
            }
            if !res.ok {
                AiTaskStore.shared.finish(taskId, ok: false, message: res.message)
                msg = WalkMessage(ok: false, text: res.message)
                // 高级调试开启时，AI 失败也补跑一次结构化 diff（有精确还原调试需求的开发用）
                if advancedDebug { await runStructured(context: context, page: page, force: true) }
                return
            }
            // 覆盖未审核的旧视觉候选后落库
            let walkIssuesNow = fetchWalkIssues(context: context, pageId: page.id)
            for old in walkIssuesNow where old.source == .visual && old.isAISuggested == true && old.aiConfirmed != true {
                context.delete(old)
            }
            // AI 结果转 Issue：测量标注换算 px、吸色标注双图取样，再吸附与去重落库
            let visualRows = aiAnnotationsToIssues(
                pageId: page.id,
                annotations: res.issues,
                designPNG: designPNG,
                shotPNG: payload.screenshotPNG
            )
            // AI 视觉框吸附到 DOM/Figma 真实元素矩形，消除模型坐标估算偏移
            AiRectRefine.refine(visualRows, input: AiRectRefine.Input(
                domRootJSON: payload.domRootJSON,
                viewport: payload.viewport,
                designRootJSON: designRootJSON,
                frameSize: frameSize
            ))
            let visualCount = saveVisualIssues(
                visualRows,
                dedupBase: specRows + elementRows + a11yRows,
                context: context,
                page: page
            )
            let total = res.issues.count
            var doneText = total > 0
                ? "AI 视觉走查完成：新增 \(visualCount) 条问题候选（\(total - visualCount) 条重合已去重）"
                : "AI 视觉走查完成：未发现明显差异"
            if !specRows.isEmpty { doneText += " 规范校验发现 \(specRows.count) 处不符" }
            if !elementRows.isEmpty { doneText += " 元素清单发现 \(elementRows.count) 处" }
            if !a11yRows.isEmpty { doneText += " 无障碍检查发现 \(a11yRows.count) 处" }
            AiTaskStore.shared.finish(taskId, ok: true, message: doneText)
            msg = WalkMessage(ok: true, text: doneText)
            // 高级调试开启时，AI 完成后自动补跑一次结构化 diff
            if advancedDebug { await runStructured(context: context, page: page, force: true) }
        } catch {
            msg = WalkMessage(ok: false, text: error.localizedDescription)
        }
    }

    /// 删除旧行并插入新行（程序轨覆盖规则：仅在产生新结果时重置上一轮）
    private func replaceRows(_ old: [Issue], with rows: [Issue], context: ModelContext) {
        for issue in old { context.delete(issue) }
        for row in rows { context.insert(row) }
    }

    private func fetchWalkIssues(context: ModelContext, pageId: String) -> [Issue] {
        let descriptor = FetchDescriptor<Issue>(predicate: #Predicate { $0.pageId == pageId })
        let all = (try? context.fetch(descriptor)) ?? []
        return all.filter { $0.displayImgSet == .walk }
    }

    // MARK: - 程序轨行转换（文案对齐 AutoWalkPanel violationToIssue / elementFindingToIssue / a11yFindingToIssue）

    /// propKey i18n key → 中文属性名
    private func propLabel(_ propKey: String, property: String) -> String {
        let key = propKey.hasPrefix("specProp_") ? String(propKey.dropFirst("specProp_".count)) : propKey
        switch key {
        case "bgColor": return "背景色"
        case "textColor": return "文字颜色"
        case "gap": return "元素间距"
        case "padding": return "内边距"
        case "fontSize": return "字号"
        case "lineHeight": return "行高"
        case "radius": return "圆角"
        case "shadow": return "阴影"
        case "border": return "边框"
        default: return property
        }
    }

    private func violationToIssue(_ v: EngineSpecViolationDTO, index: Int, pageId: String) -> Issue {
        let delta: String
        switch v.deltaKind {
        case "deltaE":
            delta = "色差 ΔE \(String(format: "%.1f", v.deltaValue ?? 0))"
        case "px":
            delta = "偏差 \(Int((v.deltaValue ?? 0).rounded(.up)))px"
        default:
            delta = "样式不匹配"
        }
        let desc = "\(propLabel(v.propKey, property: v.property))实测 \(v.actualText)，与规范 \(v.tokenName) = \(v.expectedText) 不符（\(delta)）"
        return Issue(
            pageId: pageId,
            targetImage: .screenshot,
            x: v.rect.x,
            y: v.rect.y,
            width: v.rect.width,
            height: v.rect.height,
            issueDescription: desc,
            severity: v.severity,
            category: v.category,
            status: .pending,
            shape: .rect,
            imgSet: .walk,
            source: .spec,
            createdAt: nowMs() + Double(index)
        )
    }

    private func elementFindingToIssue(_ f: EngineElementFindingDTO, index: Int, pageId: String) -> Issue {
        let designText = f.designText ?? ""
        let domText = f.domText ?? ""
        let desc: String
        switch f.kind {
        case "img-broken":
            desc = "图片加载失败或占位图异常"
        case "element-missing":
            desc = "设计稿中的「\(designText)」元素未在页面上找到"
        case "text-mismatch":
            desc = "文案不一致：设计稿「\(designText)」、页面「\(domText)」"
        default:
            desc = "元素清单校验发现差异（\(f.kind)）"
        }
        return Issue(
            pageId: pageId,
            targetImage: f.targetImage,
            x: f.rect.x,
            y: f.rect.y,
            width: f.rect.width,
            height: f.rect.height,
            issueDescription: desc,
            severity: f.severity,
            category: f.category,
            status: .pending,
            shape: .rect,
            imgSet: .walk,
            source: .element,
            createdAt: nowMs() + Double(index)
        )
    }

    private func a11yFindingToIssue(_ f: EngineA11yFindingDTO, index: Int, pageId: String) -> Issue {
        let actual = f.actualText ?? ""
        let expected = f.expectedText ?? ""
        let desc: String
        switch f.kind {
        case "img-alt-missing":
            desc = "图片缺少 alt 描述，读屏软件无法朗读"
        case "contrast-low":
            desc = "文字对比度过低（\(actual)），建议 ≥ \(expected)"
        case "font-too-small":
            desc = "字号过小（\(actual)px），建议 ≥ \(expected)px"
        case "tap-target-small":
            desc = "点击区域过小（\(actual)），建议 ≥ \(expected)"
        case "input-no-label":
            desc = "表单控件缺少关联标签（当前无可读名称）"
        default:
            desc = "无障碍检查发现差异（\(f.kind)）"
        }
        return Issue(
            pageId: pageId,
            targetImage: .screenshot,
            x: f.rect.x,
            y: f.rect.y,
            width: f.rect.width,
            height: f.rect.height,
            issueDescription: desc,
            severity: f.severity,
            category: f.category,
            status: .pending,
            shape: .rect,
            imgSet: .walk,
            source: .a11y,
            createdAt: nowMs() + Double(index)
        )
    }

    // MARK: - 规范 Token 组装（对齐 specCheck.ts loadProjectSpecTokens）

    /// 项目绑定规范 × 页面端类型 → 最新版本 Token 列表（{kind, name, value}，排除 heuristic）
    private func loadSpecTokens(context: ModelContext, projectId: String, platform: Platform) -> [[String: Any]] {
        let bindings = (try? context.fetch(FetchDescriptor<ProjectSpecBinding>(
            predicate: #Predicate { $0.projectId == projectId }
        ))) ?? []
        guard !bindings.isEmpty else { return [] }
        let boundSpecIds = Set(bindings.map(\.specId))

        let categories = (try? context.fetch(FetchDescriptor<SpecCategory>())) ?? []
        let categoryByPlatform = Set(categories.filter { $0.platformKey == platform }.map(\.id))
        let specs = (try? context.fetch(FetchDescriptor<DesignSpec>())) ?? []
        let specIds = Set(specs.filter { boundSpecIds.contains($0.id) && categoryByPlatform.contains($0.categoryId) }.map(\.id))
        guard !specIds.isEmpty else { return [] }

        // 每套规范取最新版本（no 最大）
        let versions = (try? context.fetch(FetchDescriptor<SpecVersion>())) ?? []
        var latestBySpec: [String: String] = [:]
        for version in versions where specIds.contains(version.specId) {
            if let currentId = latestBySpec[version.specId],
               let current = versions.first(where: { $0.id == currentId }), current.no >= version.no {
                continue
            }
            latestBySpec[version.specId] = version.id
        }
        guard !latestBySpec.isEmpty else { return [] }

        let tokens = (try? context.fetch(FetchDescriptor<SpecToken>())) ?? []
        var rows: [[String: Any]] = []
        for token in tokens {
            guard specIds.contains(token.specId),
                  latestBySpec[token.specId] == token.versionId,
                  token.source != .heuristic,
                  let valueData = token.value.data(using: .utf8),
                  let valueObj = try? JSONSerialization.jsonObject(with: valueData) else { continue }
            rows.append([
                "kind": token.kind.rawValue,
                "name": token.name,
                "value": valueObj
            ])
        }
        return rows
    }

    // MARK: - AI 视觉轨辅助（对齐 formatSpecSummary / aiAnnotationsToIssues / saveIssues 去重）

    /// 每类 Token 在 AI prompt 摘要中的最大条数（防 prompt 超限，对齐 SPEC_SUMMARY_LIMIT）
    private static let specSummaryLimit = 30

    /// 单条 Token 的值文本（颜色 hex / 数值 px / 阴影描边结构文本，对齐 tokenValueLabel）
    private static func tokenValueLabel(_ value: [String: Any]) -> String {
        let kind = value["kind"] as? String ?? ""
        let num = { (key: String) -> Double in
            switch value[key] {
            case let d as Double: return d.isFinite ? d : 0
            case let i as Int: return Double(i)
            case let n as NSNumber: return n.doubleValue
            default: return 0
            }
        }
        let text = { (key: String) -> String in value[key] as? String ?? "" }
        let trimNum = { (v: Double) -> String in v == v.rounded() ? "\(Int(v))" : "\(v)" }
        switch kind {
        case "color":
            return text("hex")
        case "shadow":
            let layers = value["layers"] as? [[String: Any]] ?? []
            return layers.map { l -> String in
                let inset = (l["inset"] as? Bool) == true ? "inset " : ""
                let spread: Double = switch l["spread"] {
                case let d as Double: d.isFinite ? d : 0
                case let i as Int: Double(i)
                default: 0
                }
                return "\(inset)\(trimNum(l["x"] as? Double ?? 0))px \(trimNum(l["y"] as? Double ?? 0))px \(trimNum(l["blur"] as? Double ?? 0))px \(trimNum(spread))px \(l["color"] as? String ?? "")"
            }.joined(separator: ", ")
        case "border":
            return "\(trimNum(num("width")))px \(text("style")) \(text("color"))"
        case "spacing", "fontSize", "lineHeight", "radius":
            return "\(trimNum(num("value")))px"
        default:
            return ""
        }
    }

    /// AI 轨 prompt 注入用 Token 摘要：7 类固定顺序分组，每类只列前 30 条，超限在组尾注明总数
    private static func formatSpecSummary(_ tokens: [[String: Any]]) -> String {
        let groups: [(kind: String, label: String)] = [
            ("color", "颜色"), ("spacing", "间距"), ("fontSize", "字号"), ("lineHeight", "行高"),
            ("radius", "圆角"), ("shadow", "阴影"), ("border", "边框")
        ]
        var lines: [String] = []
        for g in groups {
            let items = tokens.filter { ($0["kind"] as? String) == g.kind }
            if items.isEmpty { continue }
            let texts = items.prefix(specSummaryLimit).map { t -> String in
                let value = t["value"] as? [String: Any] ?? [:]
                return "\(t["name"] as? String ?? "") \(tokenValueLabel(value))"
            }
            let note = items.count > specSummaryLimit ? "（共 \(items.count) 项，仅列前 \(specSummaryLimit)）" : ""
            lines.append("【\(g.label)】\(texts.joined(separator: "、"))\(note)")
        }
        return lines.joined(separator: "\n")
    }

    /// 读取离屏图像归一化坐标处的像素色（hex 大写），失败返回 nil（对齐 sampleAiHex）
    private static func sampleHex(_ rep: NSBitmapImageRep?, nx: Double, ny: Double) -> String? {
        guard let rep, rep.pixelsWide > 0, rep.pixelsHigh > 0 else { return nil }
        let px = min(rep.pixelsWide - 1, max(0, Int((nx * Double(rep.pixelsWide)).rounded())))
        let py = min(rep.pixelsHigh - 1, max(0, Int((ny * Double(rep.pixelsHigh)).rounded())))
        guard let c = rep.colorAt(x: px, y: py) else { return nil }
        return String(
            format: "#%02X%02X%02X",
            Int((c.redComponent * 255).rounded()),
            Int((c.greenComponent * 255).rounded()),
            Int((c.blueComponent * 255).rounded())
        )
    }

    /// AI 标注候选 → Issue 行：
    /// measure 按所在图片原始尺寸换算 px 写入 measureValue；
    /// picker 在设计稿与开发截图同一坐标分别取样，写入 sampleA/sampleB 双色对比（对齐 aiAnnotationsToIssues）
    private func aiAnnotationsToIssues(
        pageId: String,
        annotations: [AIAnnotation],
        designPNG: Data,
        shotPNG: Data
    ) -> [Issue] {
        let designRep = NSBitmapImageRep(data: designPNG)
        let shotRep = NSBitmapImageRep(data: shotPNG)
        let startAt = nowMs()
        return annotations.enumerated().map { idx, a in
            let own = a.targetImage == .design ? designRep : shotRep
            let row = Issue(
                pageId: pageId,
                targetImage: a.targetImage,
                x: a.x,
                y: a.y,
                width: a.shape == .picker ? 0 : a.width,
                height: a.shape == .picker ? 0 : a.height,
                issueDescription: a.description,
                severity: a.severity,
                category: a.category,
                status: .pending,
                shape: a.shape,
                imgSet: .walk,
                source: .visual,
                createdAt: startAt + Double(idx)
            )
            row.isAISuggested = true
            row.aiConfirmed = false
            row.aiSuggestion = a.suggestion
            if a.shape == .measure, let own {
                let w = a.width * Double(own.pixelsWide)
                let h = a.height * Double(own.pixelsHigh)
                row.measureValue = "\(Int(hypot(w, h).rounded()))px"
            }
            if a.shape == .picker {
                row.sampleA = Self.sampleHex(designRep, nx: a.x, ny: a.y)
                row.sampleB = Self.sampleHex(shotRep, nx: a.x, ny: a.y)
            }
            return row
        }
    }

    /// 归一化矩形重叠度 IoU（对齐 AutoWalkPanel rectIoU）
    private static func rectIoU(_ a: Issue, _ b: Issue) -> Double {
        let x1 = max(a.x, b.x)
        let y1 = max(a.y, b.y)
        let x2 = min(a.x + a.width, b.x + b.width)
        let y2 = min(a.y + a.height, b.y + b.height)
        let inter = max(0, x2 - x1) * max(0, y2 - y1)
        if inter <= 0 { return 0 }
        let union = a.width * a.height + b.width * b.height - inter
        return union > 0 ? inter / union : 0
    }

    /// 视觉候选落库：与程序校验行（同类别 + 区域重叠 IoU>0.2）去重后插入（对齐 saveIssues 的视觉分支）
    @discardableResult
    private func saveVisualIssues(
        _ candidates: [Issue],
        dedupBase: [Issue],
        context: ModelContext,
        page: WalkthroughPage
    ) -> Int {
        var inserted = 0
        for v in candidates {
            let covered = dedupBase.contains { $0.category == v.category && Self.rectIoU($0, v) > 0.2 }
            if covered { continue }
            context.insert(v)
            inserted += 1
        }
        if inserted > 0 {
            page.updatedAt = nowMs()
            try? context.save()
        }
        return inserted
    }

    // MARK: - 高级调试：结构化比对（对齐 runStructured）

    func runStructured(context: ModelContext, page: WalkthroughPage, force: Bool = false) async {
        if !force && (running || waiting) { return }
        guard let run = lastRun else {
            msg = WalkMessage(ok: false, text: "结构化分析依赖最近一次走查的采集数据（应用重启后失效），请重新走查后再试")
            return
        }
        running = true
        msg = WalkMessage(ok: true, text: "正在匹配元素并比对样式...")
        defer { running = false }

        do {
            // 检查深度映射：容差倍率（宽松 ×2 / 标准 ×1 / 严格 ×0.5）；宽高与内边距/间距仅严格模式比对
            let factor: Double = switch checkOptions.depth {
            case .loose: 2
            case .strict: 0.5
            case .standard: 1
            }
            let scaled = ToleranceConfig(
                size: tolerance.size * factor,
                typography: tolerance.typography * factor,
                spacing: tolerance.spacing * factor,
                radius: tolerance.radius * factor,
                color: tolerance.color * factor,
                border: tolerance.border * factor
            )
            let cmp = try await EngineBridge.compare(
                designRootJSON: run.designRootJSON,
                domRootJSON: run.domRootJSON,
                tolerance: scaled,
                viewport: run.viewport,
                includeSizeSpacing: checkOptions.depth == .strict
            )
            let diffs = cmp.diffs ?? []
            // 高置信度（≥0.6）自动落库；低置信度本里程碑仅报条数（确认抽屉后续版本接入）
            let autoDiffs = diffs.filter { $0.matchConfidence >= 0.6 }
            let pendingCount = diffs.count - autoDiffs.count

            // 去重：与已落库 walk 结构化问题按（图层节点 + DOM 路径 + 分类 + 描述）比对
            let walkIssues = fetchWalkIssues(context: context, pageId: page.id)
            var seen = Set(walkIssues.filter { $0.source == .structured }.map {
                "\( $0.figmaNodeId ?? "")|\($0.domPath ?? "")|\($0.category.rawValue)|\($0.issueDescription)"
            })
            var fresh: [EngineDiffDTO] = []
            for d in autoDiffs {
                let key = "\(d.figmaNodeId ?? "")|\(d.domPath ?? "")|\(d.category.rawValue)|\(d.diffDescription)"
                if seen.insert(key).inserted { fresh.append(d) }
            }

            let now = nowMs()
            for (i, d) in fresh.enumerated() {
                context.insert(Issue(
                    pageId: page.id,
                    targetImage: .screenshot,
                    x: d.rect.x,
                    y: d.rect.y,
                    width: d.rect.width,
                    height: d.rect.height,
                    issueDescription: d.diffDescription,
                    severity: d.severity,
                    category: d.category,
                    status: .pending,
                    shape: d.colorHex != nil ? .picker : .rect,
                    color: d.colorHex,
                    imgSet: .walk,
                    source: .structured,
                    createdAt: now + Double(i)
                ))
            }
            if let page2 = fetchPage(context: context, pageId: page.id) {
                page2.updatedAt = nowMs()
            }
            try? context.save()

            // 消息组装（对齐 Electron：追加/跳过 + 低置信度 + 未匹配计数）
            var parts: [String] = []
            if !fresh.isEmpty {
                parts.append(
                    fresh.count < autoDiffs.count
                        ? "结构化分析完成：追加 \(fresh.count) 条结构化差异（\(autoDiffs.count - fresh.count) 条已存在跳过）"
                        : "结构化分析完成：追加 \(fresh.count) 条结构化差异"
                )
            } else if autoDiffs.isEmpty {
                parts.append("结构化分析完成：未发现新的样式差异")
            } else {
                parts.append("结构化分析完成：本次差异均已加入过问题清单，未重复添加")
            }
            if pendingCount > 0 {
                parts.append("\(pendingCount) 条低置信度差异待人工确认（确认抽屉将在后续版本接入）")
            }
            parts.append("未匹配设计稿图层 \(cmp.unmatchedDesignCount ?? 0) 个 / 未匹配页面元素 \(cmp.unmatchedDomCount ?? 0) 个")
            msg = WalkMessage(ok: true, text: parts.joined(separator: "；"))
        } catch {
            msg = WalkMessage(ok: false, text: error.localizedDescription)
        }
    }

    private func fetchPage(context: ModelContext, pageId: String) -> WalkthroughPage? {
        let descriptor = FetchDescriptor<WalkthroughPage>(predicate: #Predicate { $0.id == pageId })
        return (try? context.fetch(descriptor))?.first
    }
}

// MARK: - 采集窗口委托（AutoWalkModel 实现）

extension AutoWalkModel: DevCaptureDelegate {
    func captureWindow(_ controller: DevCaptureWindowController, didCapture result: Result<DevCapturePayload, Error>) async {
        guard controller === captureController else { return }
        captureController = nil
        switch result {
        case .success(let payload):
            waiting = false
            guard let page = pendingPage, let context = pendingContext else { return }
            pendingPage = nil
            pendingContext = nil
            await handleCaptured(payload, page: page, context: context)
        case .failure(let error):
            waiting = false
            if let captureError = error as? DevCaptureError, case .windowClosed = captureError {
                msg = WalkMessage(ok: true, text: "已取消走查采集")
            } else {
                msg = WalkMessage(ok: false, text: error.localizedDescription)
            }
        }
    }
}
