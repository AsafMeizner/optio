import Foundation
import Observation

/// A native view of the saved assistant harness session. The server owns history;
/// drafts stay local and reconnecting never replays an uncertain action.
@Observable @MainActor
final class OptioAssistantModel {
    struct Proposal {
        let id: String
        let items: [String]
        let work: [[String: Any]]
        var decision: String?
    }
    struct Row: Identifiable {
        let id = UUID()
        var role = "assistant"
        var text: String
        var isError = false
        var proposal: Proposal?
        var requestId: String?
    }
    enum Status: String { case disconnected, connecting, ready, thinking, executing, waitingForApproval }
    var rows: [Row] = []
    var draft = ""
    var status: Status = .disconnected
    private(set) var sessionId: String?
    private(set) var sessionHref: String?
    private var isClearing = false
    private var socket: WebSocketClient?
    private var pump: Task<Void, Never>?
    private var streamId: UUID?
    private var generation = UUID()

    var canSend: Bool { status == .ready && !isClearing && !rows.contains { $0.proposal?.decision == nil && $0.proposal != nil } }
    var canReset: Bool { canSend }

    func start(api: APIClient) {
        guard socket == nil else { return }
        status = .connecting
        let token = api.token
        // Use the selected server and workspace to attach to the saved session.
        let client = WebSocketClient(url: api.wsURL("/ws/optio/chat"), tokenProvider: { token }, autoReconnect: false, headers: api.workspaceId.map { ["x-workspace-id": $0] } ?? [:])
        socket = client
        let current = generation
        pump = Task { [weak self] in
            for await frame in client.frames {
                guard let self, !Task.isCancelled, self.generation == current else { return }
                self.handle(frame)
            }
        }
        client.connect()
    }

    func stop() {
        reportUncertainResult()
        generation = UUID()
        pump?.cancel()
        pump = nil
        socket?.disconnect()
        socket = nil
        status = .disconnected
        isClearing = false
        streamId = nil
        expireProposals()
    }

    func reconnect(api: APIClient) {
        stop()
        rows.append(Row(text: "Reconnecting. Previous actions won’t be retried. Check Work before repeating a request whose result is uncertain."))
        start(api: api)
    }

    private func reportUncertainResult() {
        if status == .thinking || status == .executing {
            rows.append(Row(text: "The conversation disconnected before the operation finished. Check Work before repeating a request; its result may be uncertain.", isError: true))
        }
    }

    private func expireProposals() {
        for index in rows.indices where rows[index].proposal != nil && rows[index].proposal?.decision == nil {
            rows[index].proposal?.decision = "Expired — request a fresh proposal"
        }
    }

    /// Internal so tests can drive actual server frames without a model or microphone.
    func handle(_ frame: WebSocketClient.Frame) {
        switch frame {
        case .opened: break // Only the server's status frame authorizes input.
        case .closed(_, let reason):
            reportUncertainResult()
            status = .disconnected
            isClearing = false
            expireProposals()
            streamId = nil
            if let reason, !reason.isEmpty { rows.append(Row(text: reason, isError: true)) }
        case .json(let obj):
            switch obj["type"] as? String {
            case "history":
                guard let frames = obj["frames"] as? [[String: Any]] else { return }
                rows = []
                streamId = nil
                isClearing = false
                sessionId = (obj["sessionId"] as? String).flatMap { UUID(uuidString: $0) == nil ? nil : $0 }
                sessionHref = sessionId.flatMap { id in
                    let href = obj["href"] as? String
                    return href == "/sessions/\(id)" ? href : nil
                }
                for frame in frames {
                    switch frame["type"] as? String {
                    case "user_message":
                        if let content = frame["content"] as? String {
                            appendUserMessage(content, requestId: frame["requestId"] as? String)
                        }
                    case "text", "error", "action_result":
                        guard let content = frame["content"] as? String ?? frame["message"] as? String ?? frame["summary"] as? String else { continue }
                        let isError = frame["type"] as? String == "error" || frame["success"] as? Bool == false
                        rows.append(Row(text: content, isError: isError))
                    default: break
                    }
                }
            case "user_message":
                guard let content = obj["content"] as? String else { return }
                streamId = nil
                appendUserMessage(content, requestId: obj["requestId"] as? String)
            case "status":
                let value = obj["status"] as? String
                status = value == "waiting_for_approval" ? .waitingForApproval : Status(rawValue: value ?? "") ?? .connecting
                if status == .ready { streamId = nil }
            case "text":
                guard let text = obj["content"] as? String else { return }
                if let index = rows.firstIndex(where: { $0.id == streamId }) { rows[index].text += text }
                else {
                    let row = Row(text: text)
                    streamId = row.id
                    rows.append(row)
                }
            case "action_proposal":
                guard let id = obj["actionId"] as? String else { return }
                guard !rows.contains(where: { $0.proposal?.id == id }) else { return }
                streamId = nil
                rows.append(Row(text: obj["description"] as? String ?? "Review action", proposal: Proposal(
                    id: id, items: obj["items"] as? [String] ?? [], work: obj["work"] as? [[String: Any]] ?? []
                )))
            case "action_decision":
                guard let id = obj["actionId"] as? String, let approved = obj["approved"] as? Bool else { return }
                settleProposal(id, decision: approved ? "Approved" : "Declined")
            case "action_expired":
                guard let id = obj["actionId"] as? String else { return }
                settleProposal(id, decision: "Expired — request a fresh proposal")
            case "action_result", "error":
                if obj["type"] as? String == "action_result", let id = obj["actionId"] as? String {
                    settleProposal(id, decision: "Approved")
                }
                if obj["type"] as? String == "error" { isClearing = false }
                streamId = nil
                let isError = obj["type"] as? String == "error" || obj["success"] as? Bool == false
                rows.append(Row(text: obj["summary"] as? String ?? obj["message"] as? String ?? "Optio couldn’t process the request.", isError: isError))
            default: break
            }
        default: break
        }
    }

    /// Both optimistic sends and server echoes use the same request identity.
    func appendUserMessage(_ content: String, requestId: String?) {
        if let requestId, rows.contains(where: { $0.requestId == requestId }) { return }
        rows.append(Row(role: "user", text: content, requestId: requestId))
    }

    private func settleProposal(_ id: String, decision: String) {
        for index in rows.indices where rows[index].proposal?.id == id {
            rows[index].proposal?.decision = decision
        }
        streamId = nil
    }

    static func json(_ value: Any) -> String {
        if let text = value as? String { return text }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]) else { return String(describing: value) }
        return String(decoding: data, as: UTF8.self)
    }

    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, !text.isEmpty, let socket else { return }
        let requestId = UUID().uuidString
        status = .thinking
        streamId = nil
        // Insert before sending so even an immediate server echo cannot duplicate it.
        appendUserMessage(text, requestId: requestId)
        do {
            try await socket.send(json: ["type": "message", "content": text, "requestId": requestId])
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
        } catch {
            stop()
            rows.append(Row(text: "Couldn’t send. Your draft is preserved. Reconnect before trying again.", isError: true))
        }
    }

    func decide(id: String, approve: Bool) async {
        guard status == .waitingForApproval, let socket,
              let index = rows.firstIndex(where: { $0.proposal?.id == id && $0.proposal?.decision == nil }) else { return }
        // Disable immediately: a second tap must never execute an action twice.
        rows[index].proposal?.decision = approve ? "Approved" : "Declined"
        status = .executing
        streamId = nil
        do { try await socket.send(json: ["type": approve ? "approve" : "deny", "actionId": id]) }
        catch {
            stop()
            rows.append(Row(text: "Connection lost. Check Work before repeating this action; its result may be uncertain.", isError: true))
        }
    }

    func reset() async {
        guard canReset, let socket else { return }
        isClearing = true
        do {
            // Only the history acknowledgement clears rows; a rejected clear keeps them.
            try await socket.send(json: ["type": "interrupt"])
        } catch { stop() }
    }
}
