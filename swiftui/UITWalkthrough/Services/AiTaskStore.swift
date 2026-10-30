import AppKit
import Foundation

// MARK: - AI 后台识别任务（对齐 Electron stores/aiTasks.ts）
//
// 跨页面后台运行，支持同页/多页多任务并行：
// - 任务数组存储，同一点击即新建一个任务，按钮不被进行中的任务禁用
// - 完成/失败时 finish；被中断的任务 finish 不生效，结果直接丢弃
// - 切换页面不影响任务执行，返回页面时从任务数组恢复状态与结果提示

/// AI 识别任务状态
enum AiTaskStatus: String, Equatable, Sendable {
    case running
    case done
    case failed
    case interrupted
}

/// AI 识别任务
struct AiTask: Identifiable, Equatable, Sendable {
    let id: String
    let pageId: String
    let pageName: String
    var status: AiTaskStatus
    var message: String
    let startedAt: Double
}

/// 任务真实流转为「完成」时播放提示音（叮-咚双音；中断/重复 finish 静默；受 soundEnabled 开关控制）
enum TaskDoneSound {
    static func play() {
        guard AppConfigStore.load().soundEnabled != false else { return }
        // Electron 版用 Web Audio 合成 叮(E6)→咚(A6) 双音，此处以系统音近似
        NSSound(named: "Tink")?.play()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
            NSSound(named: "Glass")?.play()
        }
    }
}

@MainActor
@Observable
final class AiTaskStore {
    static let shared = AiTaskStore()
    private init() {}

    var tasks: [AiTask] = []

    /// 新建任务，返回任务 id
    @discardableResult
    func start(pageId: String, pageName: String) -> String {
        let id = "\(Int(nowMs()))-\(String(Int.random(in: 0..<4_669_761), radix: 36))"
        tasks.append(AiTask(
            id: id,
            pageId: pageId,
            pageName: pageName,
            status: .running,
            message: "AI 识别进行中...",
            startedAt: nowMs()
        ))
        return id
    }

    /// 用户选择「中断任务」：正在等待的识别结果将被丢弃
    func interrupt(_ taskId: String) {
        for i in tasks.indices where tasks[i].id == taskId && tasks[i].status == .running {
            tasks[i].status = .interrupted
            tasks[i].message = "AI 识别任务已中断"
        }
    }

    /// 更新某页面所有进行中任务的进度提示（流式接收字数/耗时；对齐 progressPage）
    func progressPage(pageName: String, note: String) {
        for i in tasks.indices where tasks[i].status == .running && (pageName.isEmpty || tasks[i].pageName == pageName) {
            tasks[i].message = "AI 识别中... \(note)"
        }
    }

    /// 结束任务（成功时播放提示音；已被中断的任务保持中断态，结果由调用方丢弃）
    func finish(_ taskId: String, ok: Bool, message: String) {
        if ok, tasks.contains(where: { $0.id == taskId && $0.status == .running }) {
            TaskDoneSound.play()
        }
        for i in tasks.indices where tasks[i].id == taskId && tasks[i].status == .running {
            tasks[i].status = ok ? .done : .failed
            tasks[i].message = message
        }
    }

    /// 移除任务
    func clear(_ taskId: String) {
        tasks.removeAll { $0.id == taskId }
    }

    /// 移除多个任务
    func clear(_ taskIds: [String]) {
        let ids = Set(taskIds)
        tasks.removeAll { ids.contains($0.id) }
    }

    /// 进行中的任务列表（切页提醒用）
    func runningList() -> [AiTask] {
        tasks.filter { $0.status == .running }
    }

    /// 某页面是否有进行中的任务
    func isRunning(pageId: String) -> Bool {
        tasks.contains { $0.pageId == pageId && $0.status == .running }
    }
}
