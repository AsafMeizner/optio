import Foundation
import Observation

/// Historical + live logs for Jobs and PR reviews. Reconnects recover REST
/// history and refresh state, including a final transition missed while offline.
@Observable @MainActor
final class RunLogStream {
    var entries: [AgentLogEntry] { historyModel.entries }
    var error: Error? { historyModel.error }
    var connected = false
    var onStateChanged: (@MainActor () -> Void)?

    private let logEventType: String
    private let stateEventTypes: Set<String>
    private let historyModel = LogHistory()
    private var ws: WebSocketClient?
    private var pump: Task<Void, Never>?
    private var paginated = true

    init(logEventType: String, stateEventTypes: Set<String>) {
        self.logEventType = logEventType
        self.stateEventTypes = stateEventTypes
    }

    private struct Frame: Decodable {
        let id: String?
        let type: String
        let content: String?
        let logType: String?
        let metadata: [String: AnyCodable]?
        let timestamp: Date?
        let catchUp: Bool?
    }

    typealias History = @MainActor (_ offset: Int, _ limit: Int) async throws -> [RunLogRow]

    func start(api: APIClient, wsPath: String?, paginated: Bool = true, history: @escaping History) {
        stop()
        self.paginated = paginated
        loadHistory(history)
        guard let wsPath else { return }
        let client = WebSocketClient(api: api, path: wsPath)
        ws = client
        client.connect()
        pump = Task { [weak self] in
            for await frame in client.frames {
                guard let self, !Task.isCancelled else { return }
                switch frame {
                case .opened:
                    connected = true
                    if historyModel.connectionOpened() { onStateChanged?() }
                case .closed: connected = false
                case .json(let obj): handle(obj, api: api)
                default: break
                }
            }
        }
    }

    /// A new review run replaces both its history and the reconnect fetcher.
    func reloadHistory(_ history: @escaping History) {
        guard ws != nil else { return }
        loadHistory(history)
        historyModel.connectionOpened()
    }

    private func loadHistory(_ history: @escaping History) {
        historyModel.start(paginated: paginated) { offset, limit in
            try await history(offset, limit).map { LogHistory.Row(id: $0.id, entry: $0.asEntry) }
        }
    }

    private func handle(_ obj: [String: Any], api: APIClient) {
        guard let type = obj["type"] as? String else { return }
        if stateEventTypes.contains(type) {
            onStateChanged?()
            return
        }
        guard type == logEventType,
              let data = try? JSONSerialization.data(withJSONObject: obj),
              let frame = try? api.decoder.decode(Frame.self, from: data),
              frame.catchUp != true, let content = frame.content else { return }
        let entry = AgentLogEntry(
            taskId: "",
            timestamp: frame.timestamp.map { RunLogRow.iso.string(from: $0) } ?? "",
            type: AgentLogEntry.TypeValue(rawValue: frame.logType ?? "text") ?? .unknown,
            content: content,
            metadata: frame.metadata
        )
        historyModel.append(LogHistory.Row(id: frame.id, entry: entry))
    }

    func stop() {
        historyModel.stop()
        pump?.cancel()
        pump = nil
        ws?.disconnect()
        ws = nil
        connected = false
    }
}
