import AppKit
import WebKit

// MARK: - 开发页面采集窗口（对齐 Electron DevBrowser + BrowserPopupPage 的自动走查采集流程）
//
// 独立 NSWindow 内嵌 WKWebView（视口精确等于下发尺寸，宽度自动匹配 Figma 画板），
// 页面加载完成后点「生成问题标注」采集 DOM 树 + 截图回传走查面板。
// 采集流程对齐 DevBrowser.runCapture：等加载 → 回顶部 → 整页拉高 webview → 注入采集脚本 → 截图 → 还原高度。

/// 采集结果载荷：DOM 树 JSON（StyleNode 结构）+ 整页 PNG 截图 + 视口与统计
struct DevCapturePayload {
    var domRootJSON: Data
    var screenshotPNG: Data
    var viewport: CGSize
    var collected: Int
    var skipped: Int
}

/// 采集窗口错误
enum DevCaptureError: LocalizedError {
    case windowClosed
    case collectScriptFailed(String)
    case snapshotFailed(String)
    case pngEncodeFailed

    var errorDescription: String? {
        switch self {
        case .windowClosed: "采集窗口已关闭"
        case .collectScriptFailed(let msg): "页面采集失败：\(msg)"
        case .snapshotFailed(let msg): "截图失败：\(msg)"
        case .pngEncodeFailed: "截图编码 PNG 失败"
        }
    }
}

/// 采集结果回传协议（AutoWalkModel 实现；@MainActor 收口，避免跨 actor 传递 ModelContext）
@MainActor
protocol DevCaptureDelegate: AnyObject {
    func captureWindow(_ controller: DevCaptureWindowController, didCapture result: Result<DevCapturePayload, Error>) async
}

/// 翻转坐标系容器（documentView 顶部对齐滚动）
private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

@MainActor
final class DevCaptureWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate {
    /// 活跃采集窗口注册表：跨页面后台走查时强持有，windowWillClose 时移除
    nonisolated private static var liveControllers: [ObjectIdentifier: DevCaptureWindowController] = [:]
    static func retainLive(_ controller: DevCaptureWindowController) {
        liveControllers[ObjectIdentifier(controller)] = controller
    }

    weak var delegate: DevCaptureDelegate?

    let viewport: CGSize
    private var initialURL: URL
    private var window: NSWindow?
    private var webView: WKWebView?
    private var urlField: NSTextField?
    private var fullPageButton: NSButton?
    private var captureButton: NSButton?
    private var viewportLabel: NSTextField?
    private var msgLabel: NSTextField?
    /// 页面加载完成标志（采集前置条件；20s 轮询兜底）
    private var pageLoaded = false
    private var capturing = false
    /// 是否已回传结果（关窗时用于区分「正常完成」与「中途取消」）
    private var resultSent = false

    init(url: URL, viewport: CGSize, delegate: DevCaptureDelegate?) {
        self.initialURL = url
        self.viewport = viewport
        self.delegate = delegate
        super.init()
    }

    // MARK: - 窗口构建（纯 AppKit）

    func showWindow() {
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: max(1080, viewport.width + 80), height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        win.title = "内置浏览器"
        win.center()
        win.delegate = self

        let content = FlippedView(frame: NSRect(x: 0, y: 0, width: win.contentView!.frame.width, height: 780))
        win.contentView = content
        content.translatesAutoresizingMaskIntoConstraints = false

        // 顶栏：标题 + 地址栏 + 刷新
        let titleLabel = NSTextField(labelWithString: "内置浏览器")
        titleLabel.font = .boldSystemFont(ofSize: 13)
        let urlField = NSTextField(string: initialURL.absoluteString)
        urlField.placeholderString = "输入页面 URL 后回车加载（内网页面请先登录）"
        urlField.font = .systemFont(ofSize: 12)
        urlField.target = self
        urlField.action = #selector(urlAction)
        let refreshButton = NSButton(title: "刷新", target: self, action: #selector(refreshAction))
        refreshButton.bezelStyle = .rounded

        // 中部：滚动区域 + 固定尺寸 webview（视口精确等于 viewport）
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = true
        scroll.backgroundColor = .white

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // 登录态持久化（对齐 Electron persist 分区）
        let web = WKWebView(frame: NSRect(origin: .zero, size: viewport), configuration: config)
        web.navigationDelegate = self

        let container = FlippedView(frame: NSRect(origin: .zero, size: viewport))
        container.addSubview(web)
        web.frame = NSRect(origin: .zero, size: viewport)
        container.frame = web.frame
        scroll.documentView = container

        // 底栏：视口 + 整页开关 + 生成标注 + 消息
        let viewportLabel = NSTextField(labelWithString: viewportText(fullPage: true))
        viewportLabel.font = .systemFont(ofSize: 12)
        viewportLabel.textColor = .secondaryLabelColor
        let fullPageButton = NSButton(checkboxWithTitle: "整页采集", target: self, action: #selector(fullPageAction))
        fullPageButton.state = .on
        let captureButton = NSButton(title: "生成问题标注", target: self, action: #selector(captureAction))
        captureButton.bezelStyle = .rounded
        captureButton.keyEquivalent = "\r"
        captureButton.isEnabled = false
        let msgLabel = NSTextField(wrappingLabelWithString: "")
        msgLabel.font = .systemFont(ofSize: 12)
        msgLabel.textColor = .secondaryLabelColor
        msgLabel.maximumNumberOfLines = 2
        msgLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)

        for sub in [titleLabel, urlField, refreshButton, scroll, viewportLabel, fullPageButton, captureButton, msgLabel] {
            sub.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(sub)
        }

        NSLayoutConstraint.activate([
            titleLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            titleLabel.centerYAnchor.constraint(equalTo: urlField.centerYAnchor),

            urlField.leadingAnchor.constraint(equalTo: titleLabel.trailingAnchor, constant: 10),
            urlField.topAnchor.constraint(equalTo: content.topAnchor, constant: 8),
            urlField.heightAnchor.constraint(equalToConstant: 24),

            refreshButton.leadingAnchor.constraint(equalTo: urlField.trailingAnchor, constant: 8),
            refreshButton.centerYAnchor.constraint(equalTo: urlField.centerYAnchor),

            scroll.topAnchor.constraint(equalTo: urlField.bottomAnchor, constant: 8),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor),

            viewportLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            viewportLabel.topAnchor.constraint(equalTo: scroll.bottomAnchor, constant: 8),

            fullPageButton.leadingAnchor.constraint(equalTo: viewportLabel.trailingAnchor, constant: 12),
            fullPageButton.centerYAnchor.constraint(equalTo: viewportLabel.centerYAnchor),

            captureButton.leadingAnchor.constraint(equalTo: fullPageButton.trailingAnchor, constant: 12),
            captureButton.centerYAnchor.constraint(equalTo: viewportLabel.centerYAnchor),

            msgLabel.leadingAnchor.constraint(equalTo: captureButton.trailingAnchor, constant: 12),
            msgLabel.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -12),
            msgLabel.centerYAnchor.constraint(equalTo: viewportLabel.centerYAnchor),

            content.bottomAnchor.constraint(equalTo: viewportLabel.bottomAnchor, constant: 10)
        ])

        self.window = win
        self.webView = web
        self.urlField = urlField
        self.viewportLabel = viewportLabel
        self.fullPageButton = fullPageButton
        self.captureButton = captureButton
        self.msgLabel = msgLabel

        Self.retainLive(self)
        web.load(URLRequest(url: initialURL))
        win.makeKeyAndOrderFront(nil)
    }

    private func viewportText(fullPage: Bool) -> String {
        "视口 \(Int(viewport.width)) × \(Int(viewport.height))" + (fullPage ? "（整页采集时高度自动扩展）" : "")
    }

    /// 主动关窗（「取消等待」用）：触发 windowWillClose → 委托收到 windowClosed 失败
    func closeWindow() {
        window?.close()
    }

    private func setMsg(_ text: String) {
        msgLabel?.stringValue = text
    }

    // MARK: - 顶栏动作

    /// 归一化 URL：无协议自动补 http://（对齐 BrowserPopupPage.resolveUrl；本应用无自身 web 端口，无需拦截自身地址）
    private func resolveURL(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.lowercased().hasPrefix("http://") || trimmed.lowercased().hasPrefix("https://") {
            return URL(string: trimmed)
        }
        return URL(string: "http://\(trimmed)")
    }

    @objc private func urlAction() {
        guard let field = urlField, let url = resolveURL(field.stringValue) else { return }
        field.stringValue = url.absoluteString
        initialURL = url
        pageLoaded = false
        captureButton?.isEnabled = false
        webView?.load(URLRequest(url: url))
    }

    @objc private func refreshAction() {
        guard let field = urlField, let url = resolveURL(field.stringValue) else { return }
        field.stringValue = url.absoluteString
        initialURL = url
        pageLoaded = false
        captureButton?.isEnabled = false
        // 地址未变则原地刷新，变了重新导航（对齐 BrowserPopupPage refresh）
        if webView?.url == url {
            webView?.reload()
        } else {
            webView?.load(URLRequest(url: url))
        }
    }

    @objc private func fullPageAction() {
        viewportLabel?.stringValue = viewportText(fullPage: fullPageButton?.state == .on)
    }

    @objc private func captureAction() {
        guard !capturing else { return }
        capturing = true
        captureButton?.isEnabled = false
        Task {
            await performCapture()
        }
    }

    // MARK: - 采集流程（对齐 DevBrowser.runCapture）

    private func performCapture() async {
        setMsg("正在采集页面…")
        do {
            let payload = try await capture(fullPage: fullPageButton?.state == .on)
            resultSent = true
            await delegate?.captureWindow(self, didCapture: .success(payload))
            setMsg("采集完成，结果已回传走查面板")
            // 结果已回传：延迟关窗，主窗口接手后续流程（对齐 BrowserPopupPage）
            try? await Task.sleep(for: .milliseconds(400))
            window?.close()
        } catch {
            setMsg("采集失败：\(error.localizedDescription)")
        }
        capturing = false
        captureButton?.isEnabled = pageLoaded
    }

    /// 采集：等加载 → 回顶部 → 整页拉高 → 注入采集脚本 → 截图 → 还原高度
    func capture(fullPage: Bool) async throws -> DevCapturePayload {
        guard let web = webView else { throw DevCaptureError.snapshotFailed("窗口未就绪") }

        // 1. 等待加载（dom-ready 正常先到，20s 轮询兜底后继续）
        let deadline = Date().addingTimeInterval(20)
        while !pageLoaded && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(500))
        }

        // 2. 回到顶部并等待布局稳定
        _ = try? await web.evaluateJavaScript("window.scrollTo(0, 0); true")
        try? await Task.sleep(for: .milliseconds(300))

        // 3. 整页采集：把 webview 高度拉到文档高度（上限 20000px，与 Electron 一致）
        let originalFrame = web.frame
        if fullPage {
            let docHeight = ((try? await web.evaluateJavaScript(
                "Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0)"
            )) as? Double) ?? 0
            let target = min(max(docHeight, viewport.height), 20000)
            resizeWebView(to: CGSize(width: viewport.width, height: target))
            try? await Task.sleep(for: .milliseconds(800))
        }
        defer {
            if fullPage { resizeWebView(to: originalFrame.size) }
        }

        // 4. 注入 DOM 采集脚本（返回 JSON 字符串）
        guard let raw = try await web.evaluateJavaScript(Self.domCollectJS) as? String else {
            throw DevCaptureError.collectScriptFailed("采集脚本未返回结果")
        }
        guard let obj = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else {
            throw DevCaptureError.collectScriptFailed("采集脚本输出不是合法 JSON")
        }
        guard obj["ok"] as? Bool == true, let rootObj = obj["root"] else {
            throw DevCaptureError.collectScriptFailed(obj["message"] as? String ?? "未知错误")
        }

        // 5. 截图（webview 高度即文档高度，整张内容都在视口内）
        let config = WKSnapshotConfiguration()
        config.rect = CGRect(origin: .zero, size: web.frame.size)
        let image: NSImage = try await withCheckedThrowingContinuation { continuation in
            web.takeSnapshot(with: config) { img, err in
                if let img {
                    continuation.resume(returning: img)
                } else {
                    continuation.resume(throwing: DevCaptureError.snapshotFailed(err?.localizedDescription ?? "未知错误"))
                }
            }
        }
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            throw DevCaptureError.pngEncodeFailed
        }

        let rootData = try JSONSerialization.data(withJSONObject: rootObj)
        let vpObj = obj["viewport"] as? [String: Any]
        let vpW = (vpObj?["width"] as? Double) ?? Double(viewport.width)
        let vpH = (vpObj?["height"] as? Double) ?? Double(viewport.height)
        return DevCapturePayload(
            domRootJSON: rootData,
            screenshotPNG: png,
            viewport: CGSize(width: vpW, height: vpH),
            collected: obj["collected"] as? Int ?? 0,
            skipped: obj["skipped"] as? Int ?? 0
        )
    }

    /// 调整 webview 尺寸并同步 documentView 容器（整页采集拉高 / 还原共用）
    private func resizeWebView(to size: CGSize) {
        guard let web = webView, let container = web.superview else { return }
        web.frame = NSRect(origin: .zero, size: size)
        container.frame = web.frame
    }

    // MARK: - WKNavigationDelegate

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        MainActor.assumeIsolated {
            pageLoaded = true
            captureButton?.isEnabled = !capturing
            setMsg("页面已加载，确认内容无误后点击「生成问题标注」")
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated {
            setMsg("页面加载失败：\(error.localizedDescription)")
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated {
            pageLoaded = false
            captureButton?.isEnabled = false
            setMsg("页面加载失败：\(error.localizedDescription)")
        }
    }

    // MARK: - NSWindowDelegate

    nonisolated func windowWillClose(_ notification: Notification) {
        MainActor.assumeIsolated {
            Self.liveControllers.removeValue(forKey: ObjectIdentifier(self))
            // 未回传结果就关窗 → 通知委托「中途取消」，让面板退出等待态
            if !resultSent {
                resultSent = true
                Task { await delegate?.captureWindow(self, didCapture: .failure(DevCaptureError.windowClosed)) }
            }
        }
    }
}

// MARK: - DOM 采集脚本（engine-bridge/dom-collect.js 全文内嵌，避免运行期路径解析依赖）

extension DevCaptureWindowController {
    static let domCollectJS = #"""
    (() => {
      const MAX_NODES = 1500;
      const SKIP_TAGS = new Set(['SCRIPT','STYLE','LINK','META','HEAD','TITLE','NOSCRIPT','TEMPLATE','BR','IFRAME','SVG','PATH','CIRCLE','RECT','G','DEFS','USE']);
      const COUNTER = { n: 0, skipped: 0 };

      const toHex = (r, g, b) =>
        '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();

      const colorOf = (raw) => {
        if (!raw || raw === 'none' || raw === 'transparent') return null;
        const m = raw.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        if (p.length < 3 || p.slice(0, 3).some(v => isNaN(v))) return null;
        const a = p[3] === undefined ? 1 : p[3];
        if (a < 0.05) return null;
        return toHex(p[0], p[1], p[2]);
      };

      const num = (v) => {
        const n = parseFloat(v);
        return isFinite(n) ? Math.round(n * 100) / 100 : undefined;
      };

      const weightOf = (v) => {
        if (!v) return undefined;
        if (v === 'bold' || v === 'bolder') return 700;
        if (v === 'normal' || v === 'lighter') return 400;
        const n = parseInt(v, 10);
        return isFinite(n) ? n : undefined;
      };

      const radiusOf = (cs) => {
        const corners = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]
          .map(v => parseFloat(v));
        if (corners.some(v => isNaN(v))) return undefined;
        if (corners.every(v => v === 0)) return undefined;
        return corners.map(v => Math.round(v * 100) / 100);
      };

      const domPath = (el) => {
        const parts = [];
        let cur = el;
        let depth = 0;
        while (cur && cur.nodeType === 1 && cur.tagName !== 'BODY' && depth < 6) {
          let seg = cur.tagName.toLowerCase();
          if (cur.id) { parts.unshift(seg + '#' + cur.id); break; }
          const parent = cur.parentElement;
          if (parent) {
            const same = Array.prototype.filter.call(parent.children, c => c.tagName === cur.tagName);
            if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
          }
          parts.unshift(seg);
          cur = parent;
          depth++;
        }
        return parts.join('>') || 'body';
      };

      const ownText = (el) => {
        let text = '';
        for (const node of el.childNodes) {
          if (node.nodeType === 3) {
            const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) text += (text ? ' ' : '') + t;
          }
          if (text.length > 200) break;
        }
        return text.slice(0, 200);
      };

      // 有效背景色：自身背景透明时向上取最近祖先的可见背景（a11y 对比度检查用）
      const effectiveBgOf = (el) => {
        let cur = el;
        let depth = 0;
        while (cur && cur.nodeType === 1 && depth < 8) {
          let bg;
          try { bg = getComputedStyle(cur).backgroundColor; } catch { return null; }
          const c = colorOf(bg);
          if (c) return c;
          cur = cur.parentElement;
          depth++;
        }
        return null;
      };

      const collect = (el) => {
        if (COUNTER.n >= MAX_NODES) { COUNTER.skipped++; return null; }
        if (!el || el.nodeType !== 1) return null;
        const tag = el.tagName.toUpperCase();
        if (SKIP_TAGS.has(tag)) return null;
        let cs;
        try { cs = getComputedStyle(el); } catch { return null; }
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return null;

        const text = ownText(el);
        const fill = colorOf(cs.backgroundColor);
        const textColor = text ? colorOf(cs.color) : null;
        const display = cs.display;
        const isFlexGrid = display.includes('flex') || display.includes('grid');

        const node = {
          id: 'dom-' + COUNTER.n,
          name: tag.toLowerCase() + (typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
          type: text ? 'text' : (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'PICTURE' ? 'rect' : 'frame'),
          x: Math.round((rect.left + window.scrollX) * 100) / 100,
          y: Math.round((rect.top + window.scrollY) * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100
        };
        if (fill) node.fill = fill;
        if (text) node.text = text;
        if (textColor) node.textColor = textColor;
        const fs = num(cs.fontSize);
        if (fs !== undefined) node.fontSize = fs;
        const fw = weightOf(cs.fontWeight);
        if (fw !== undefined) node.fontWeight = fw;
        if (cs.fontFamily) node.fontFamily = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim().slice(0, 60);
        if (cs.lineHeight !== 'normal') node.lineHeight = num(cs.lineHeight);
        if (cs.letterSpacing !== 'normal') node.letterSpacing = num(cs.letterSpacing);
        if (cs.textAlign === 'center' || cs.textAlign === 'right') node.textAlign = cs.textAlign;
        const pts = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(num);
        if (pts.some(v => v !== undefined && v > 0)) {
          node.paddingTop = pts[0] || 0;
          node.paddingRight = pts[1] || 0;
          node.paddingBottom = pts[2] || 0;
          node.paddingLeft = pts[3] || 0;
        }
        if (isFlexGrid) {
          const rg = num(cs.rowGap) || 0;
          const cg = num(cs.columnGap) || 0;
          if (Math.max(rg, cg) > 0) node.gap = Math.max(rg, cg);
        }
        const radius = radiusOf(cs);
        if (radius) node.borderRadius = radius;
        const bw = num(cs.borderTopWidth) || 0;
        if (bw > 0 && cs.borderTopStyle !== 'none') {
          node.borderWidth = bw;
          const bc = colorOf(cs.borderTopColor);
          if (bc) node.borderColor = bc;
        }
        if (cs.boxShadow && cs.boxShadow !== 'none') node.boxShadow = cs.boxShadow.slice(0, 200);
        const op = parseFloat(cs.opacity);
        if (op < 1) node.opacity = Math.round(op * 100) / 100;
        node.dominantColor = fill || textColor || null;
        if (node.width > 0 && node.height > 0) node.aspectRatio = Math.round(node.width / node.height * 1000) / 1000;
        // 图片加载状态与替代文本（元素清单一致性 / a11y 检查用）
        if (tag === 'IMG') {
          node.imgBroken = el.complete === true && el.naturalWidth === 0;
          const alt = el.getAttribute('alt');
          if (alt !== null) node.alt = alt;
        }
        // 表单控件的无障碍标签来源（a11y 检查用：三处均缺失判「输入框无标签」）
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          const placeholder = el.getAttribute('placeholder');
          const ariaLabel = el.getAttribute('aria-label');
          const labelledby = el.getAttribute('aria-labelledby');
          if (placeholder !== null) node.placeholder = placeholder;
          if (ariaLabel) node.ariaLabel = ariaLabel;
          if (labelledby) node.ariaLabelledby = labelledby;
        }
        if (text && textColor) {
          const ebg = effectiveBgOf(el);
          if (ebg) node.effectiveBg = ebg;
        }
        const fid = el.getAttribute && el.getAttribute('data-figma-id');
        if (fid) node.dataFigmaId = fid;
        node.domPath = domPath(el);
        COUNTER.n++;
        return node;
      };

      const walk = (el, depth) => {
        const node = collect(el);
        if (!node) return null;
        if (depth < 14 && COUNTER.n < MAX_NODES) {
          const children = [];
          for (const child of el.children) {
            const c = walk(child, depth + 1);
            if (c) children.push(c);
          }
          if (children.length) node.children = children;
        }
        return node;
      };

      const body = document.body;
      if (!body) return JSON.stringify({ ok: false, message: '页面缺少 body 元素' });

      const rootFill = colorOf(getComputedStyle(body).backgroundColor) || colorOf(getComputedStyle(document.documentElement).backgroundColor);
      const root = {
        id: 'dom-root',
        name: 'body',
        type: 'frame',
        x: 0,
        y: 0,
        width: Math.round(Math.max(document.documentElement.scrollWidth, window.innerWidth) * 100) / 100,
        height: Math.round(Math.max(document.documentElement.scrollHeight, window.innerHeight) * 100) / 100,
        fill: rootFill || null,
        dominantColor: rootFill || null,
        domPath: 'body'
      };
      const children = [];
      for (const child of body.children) {
        const c = walk(child, 1);
        if (c) children.push(c);
      }
      if (children.length) root.children = children;

      return JSON.stringify({
        ok: true,
        root,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        collected: COUNTER.n,
        skipped: COUNTER.skipped
      });
    })()
    """#
}
