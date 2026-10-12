import Foundation
import Observation

/// Historical logs via REST, then live frames over `/ws/logs/:taskId`.
/// Catch-up replay frames are ignored; the shared history recovers missed REST
/// pages on reconnect and deduplicates them against concurrent live frames.
@Observable @MainActor
final class TaskLogStream {
    let taskId: String
    var entries: [AgentLogEntry] { history.entries }
    private(set) var connected = false
    var onStateChanged: (() -> Void)?

    private var ws: WebSocketClient?
    private var pumpTask: Task<Void, Never>?
    private let history = LogHistory()

    init(taskId: String) { self.taskId = taskId }

    func start(api: APIClient) {
        guard ws == nil else { return }
        history.start { [taskId] offset, limit in
            try await api.taskLogs(taskId, limit: limit, offset: offset).map {
                LogHistory.Row(id: $0.id, entry: $0.asEntry(taskId: taskId))
            }
        }
        let client = WebSocketClient(api: api, path: "/ws/logs/\(taskId)")
        ws = client
        client.connect()
        pumpTask = Task { [weak self] in
            for await frame in client.frames {
                guard let self, !Task.isCancelled else { return }
                switch frame {
                case .opened:
                    self.connected = true
                    if history.connectionOpened() { onStateChanged?() }
                case .closed: self.connected = false
                case .json(let obj): self.handle(obj, api: api)
                default: break
                }
            }
        }
    }

    private func handle(_ obj: [String: Any], api: APIClient) {
        guard let type = obj["type"] as? String else { return }
        switch type {
        case "task:log":
            guard let data = try? JSONSerialization.data(withJSONObject: obj),
                  let frame = try? api.decoder.decode(TaskLogFrame.self, from: data),
                  frame.catchUp != true, let content = frame.content else { return }
            let entry = AgentLogEntry(
                taskId: taskId,
                timestamp: frame.timestamp ?? "",
                type: AgentLogEntry.TypeValue(rawValue: frame.logType ?? "text") ?? .text,
                content: content,
                metadata: frame.metadata
            )
            history.append(LogHistory.Row(id: frame.id, entry: entry))
        case "task:state_changed", "task:stalled", "task:recovered", "task:message_delivered", "task:message_acked":
            onStateChanged?()
        default:
            break
        }
    }

    func appendLocal(_ text: String, interrupt: Bool) {
        history.appendLocal(AgentLogEntry(taskId: taskId, timestamp: ISO8601DateFormatter().string(from: .now), type: .info, content: (interrupt ? "[interrupt] " : "[you] ") + text))
    }

    func stop() {
        history.stop()
        pumpTask?.cancel()
        pumpTask = nil
        ws?.disconnect()
        ws = nil
        connected = false
    }
}
