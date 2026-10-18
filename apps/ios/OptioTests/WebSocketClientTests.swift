import CryptoKit
import Network
import XCTest
@testable import Optio

@MainActor
final class WebSocketClientTests: XCTestCase {
    func testOpenedWaitsForSuccessfulHandshake() async throws {
        let server = try HandshakeServer()
        defer { server.stop() }
        await fulfillment(of: [server.ready], timeout: 3)
        let client = WebSocketClient(url: try server.url(), tokenProvider: { nil }, autoReconnect: false)
        defer { client.disconnect() }
        let opened = expectation(description: "socket opened")
        var events: [String] = []
        let pump = Task {
            for await frame in client.frames {
                switch frame {
                case .opened: events.append("opened"); opened.fulfill()
                case .closed: events.append("closed")
                default: break
                }
            }
        }
        defer { pump.cancel() }
        client.connect()
        await fulfillment(of: [server.requestReceived], timeout: 3)
        // The server has received the request but has not accepted the upgrade.
        // Reporting opened at resume() would already have produced an event.
        XCTAssertEqual(events, [])
        try server.accept()
        await fulfillment(of: [opened], timeout: 3)
        XCTAssertEqual(events, ["opened"])
    }

    func testRejectedHandshakeNeverReportsOpened() async throws {
        let server = try HandshakeServer()
        defer { server.stop() }
        await fulfillment(of: [server.ready], timeout: 3)
        let client = WebSocketClient(url: try server.url(), tokenProvider: { nil }, autoReconnect: false)
        defer { client.disconnect() }
        let closed = expectation(description: "socket rejected")
        var events: [String] = []
        let pump = Task {
            for await frame in client.frames {
                switch frame {
                case .opened: events.append("opened")
                case .closed: events.append("closed"); closed.fulfill()
                default: break
                }
            }
        }
        defer { pump.cancel() }
        client.connect()
        await fulfillment(of: [server.requestReceived], timeout: 3)
        server.reject()
        await fulfillment(of: [closed], timeout: 3)
        XCTAssertEqual(events, ["closed"])
    }
    func testLargeSavedHistoryExceedsURLSessionDefaultLimit() async throws {
        let server = try HandshakeServer()
        defer { server.stop() }
        await fulfillment(of: [server.ready], timeout: 3)
        let client = WebSocketClient(url: try server.url(), tokenProvider: { nil }, autoReconnect: false, maximumMessageSize: 16 * 1024 * 1024)
        defer { client.disconnect() }
        let received = expectation(description: "large history restored")
        let content = String(repeating: "Saved conversation. ", count: 100_000)
        let pump = Task {
            for await frame in client.frames {
                if case .json(let object) = frame, object["type"] as? String == "history" {
                    let model = OptioAssistantModel()
                    model.handle(frame)
                    XCTAssertEqual(model.rows.first?.text, content)
                    XCTAssertTrue(model.hasLoadedHistory)
                    received.fulfill()
                }
            }
        }
        defer { pump.cancel() }
        client.connect()
        await fulfillment(of: [server.requestReceived], timeout: 3)
        try server.accept()
        try server.sendJSON(["type": "history", "frames": [["type": "text", "content": content]]])
        await fulfillment(of: [received], timeout: 8)
    }

}

/// Loopback HTTP endpoint with a manually controlled WebSocket upgrade. Tests
/// exercise URLSession's real handshake, without an external service or sleeps.
@MainActor
private final class HandshakeServer {
    let ready = XCTestExpectation(description: "loopback listener ready")
    let requestReceived = XCTestExpectation(description: "upgrade request received")
    private let listener: NWListener
    private let queue = DispatchQueue(label: "optio.tests.websocket")
    private var connection: NWConnection?
    private var request = Data()

    init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        listener.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                if case .ready = state { self?.ready.fulfill() }
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor in
                guard let self else { connection.cancel(); return }
                self.connection = connection
                connection.start(queue: self.queue)
                self.receiveRequest()
            }
        }
        listener.start(queue: queue)
    }

    func url() throws -> URL {
        let port = try XCTUnwrap(listener.port)
        return try XCTUnwrap(URL(string: "ws://127.0.0.1:\(port.rawValue)/logs"))
    }

    private func receiveRequest() {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            Task { @MainActor in
                guard let self else { return }
                if let data { self.request.append(data) }
                if String(decoding: self.request, as: UTF8.self).contains("\r\n\r\n") {
                    self.requestReceived.fulfill()
                } else if !complete && error == nil {
                    self.receiveRequest()
                }
            }
        }
    }

    func accept() throws {
        let header = String(decoding: request, as: UTF8.self).components(separatedBy: "\r\n")
            .first { $0.lowercased().hasPrefix("sec-websocket-key:") }
        let key = try XCTUnwrap(header?.split(separator: ":", maxSplits: 1).last)
            .trimmingCharacters(in: .whitespaces)
        let digest = Insecure.SHA1.hash(data: Data("\(key)258EAFA5-E914-47DA-95CA-C5AB0DC85B11".utf8))
        let accept = Data(digest).base64EncodedString()
        send("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\nSec-WebSocket-Protocol: optio-ws-v1\r\n\r\n")
    }

    func sendJSON(_ object: [String: Any]) throws {
        let body = try JSONSerialization.data(withJSONObject: object)
        var frame = Data([0x81, 127])
        var count = UInt64(body.count).bigEndian
        withUnsafeBytes(of: &count) { frame.append(contentsOf: $0) }
        frame.append(body)
        connection?.send(content: frame, completion: .contentProcessed { _ in })
    }

    func reject() {
        send("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    }

    private func send(_ response: String) {
        connection?.send(content: Data(response.utf8), completion: .contentProcessed { _ in })
    }

    func stop() {
        connection?.cancel()
        listener.cancel()
    }
}
