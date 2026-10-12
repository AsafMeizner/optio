import XCTest
@testable import Optio

@MainActor
final class LogHistoryTests: XCTestCase {
    private func row(_ number: Int, id: String? = nil, content: String? = nil) -> LogHistory.Row {
        LogHistory.Row(id: id ?? String(number), entry: AgentLogEntry(
            taskId: "task", timestamp: RunLogRow.iso.string(from: Date(timeIntervalSince1970: Double(number))),
            type: .text, content: content ?? "line \(number)"))
    }

    func testReconnectRecoversMultiplePagesWithoutSkippingConcurrentLiveRows() async {
        let history = LogHistory(pageSize: 50)
        var stored = (0..<200).map { row($0) }
        var offsets: [Int] = []
        await history.start { offset, limit in
            offsets.append(offset)
            return Array(stored.dropFirst(offset).prefix(limit))
        }.value
        XCTAssertFalse(history.connectionOpened())
        offsets = []
        stored = (0..<380).map { row($0) }
        // New live rows cannot move the REST cursor past rows 200...299.
        for n in 300..<380 { history.append(row(n)) }
        XCTAssertTrue(history.connectionOpened())
        await history.refresh().value
        XCTAssertEqual(offsets.first, 100)
        XCTAssertEqual(history.entries.map(\.content), stored.map(\.entry.content))
        XCTAssertNil(history.error)
        // A late live delivery of a row fetched by recovery stays deduplicated.
        history.append(row(250))
        XCTAssertEqual(history.entries.count, 380)
    }

    func testLiveRowsArrivingBeforeInitialHistoryAreMergedInOrder() async {
        let history = LogHistory()
        let ready = expectation(description: "history request started")
        var reply: CheckedContinuation<[LogHistory.Row], Error>?
        let load = history.start { _, _ in
            try await withCheckedThrowingContinuation { reply = $0; ready.fulfill() }
        }
        await fulfillment(of: [ready], timeout: 2)
        history.append(row(2))
        history.append(row(3))
        reply?.resume(returning: [row(1), row(2)])
        await load.value
        XCTAssertEqual(history.entries.map(\.content), ["line 1", "line 2", "line 3"])
    }

    func testFirstHandshakeRecoversRowsWrittenAfterInitialHistory() async {
        let history = LogHistory()
        var stored = [row(1)]
        let recovered = expectation(description: "history refreshed after handshake")
        var calls = 0
        await history.start { _, _ in
            calls += 1
            if calls == 2 { recovered.fulfill() }
            return stored
        }.value
        stored.append(row(2))
        XCTAssertFalse(history.connectionOpened())
        await fulfillment(of: [recovered], timeout: 2)
        XCTAssertEqual(history.entries.map(\.content), ["line 1", "line 2"])
    }

    func testFailureKeepsHistoryAndLiveRowsAndCanRecover() async {
        let history = LogHistory(pageSize: 2)
        var fail = false
        var stored = [row(1)]
        await history.start { offset, limit in
            if fail { throw URLError(.notConnectedToInternet) }
            return Array(stored.dropFirst(offset).prefix(limit))
        }.value
        fail = true
        history.append(row(3))
        await history.refresh().value
        XCTAssertEqual(history.entries.map(\.content), ["line 1", "line 3"])
        XCTAssertNotNil(history.error)
        fail = false
        stored = [row(1), row(2), row(3)]
        await history.refresh().value
        XCTAssertEqual(history.entries.map(\.content), ["line 1", "line 2", "line 3"])
        XCTAssertNil(history.error)
    }

    func testInitialFailureDoesNotPreventLaterRecovery() async {
        let history = LogHistory()
        var fail = true
        await history.start { _, _ in
            if fail { throw URLError(.timedOut) }
            return [self.row(1), self.row(2)]
        }.value
        history.append(row(2))
        fail = false
        await history.refresh().value
        XCTAssertEqual(history.entries.map(\.content), ["line 1", "line 2"])
    }

    func testFailureOnLaterPageDoesNotAdvancePastMissingRows() async {
        let history = LogHistory(pageSize: 120)
        let stored = (0..<350).map { row($0) }
        var fail = true
        var offsets: [Int] = []
        await history.start { offset, limit in
            offsets.append(offset)
            if fail && offset == 120 { throw URLError(.timedOut) }
            return Array(stored.dropFirst(offset).prefix(limit))
        }.value
        XCTAssertEqual(history.entries.count, 120)
        fail = false
        offsets = []
        await history.refresh().value
        XCTAssertEqual(offsets.first, 20)
        XCTAssertEqual(history.entries.map(\.content), stored.map(\.entry.content))
    }

    func testDistinctPersistedIDsWithIdenticalTextAndTimeSurvive() async {
        let history = LogHistory()
        let first = row(1, id: "a", content: "same")
        let second = row(1, id: "b", content: "same")
        await history.start { _, _ in [first, second] }.value
        history.append(first)
        history.append(second)
        XCTAssertEqual(history.entries.map(\.content), ["same", "same"])
    }

    func testLegacyFramesDeduplicateAcrossTimestampFormats() async {
        let history = LogHistory()
        let stored = row(1)
        await history.start { _, _ in [stored] }.value
        let legacy = LogHistory.Row(entry: AgentLogEntry(taskId: "task", timestamp: "1970-01-01T00:00:01Z", type: .text, content: "line 1"))
        history.append(legacy)
        XCTAssertEqual(history.entries.count, 1)
        let another = LogHistory()
        await another.start { _, _ in [] }.value
        another.append(legacy)
        another.append(stored)
        another.append(stored)
        XCTAssertEqual(another.entries.count, 1)
    }

    func testReviewEndpointIsFetchedOnceWithoutFakePagination() async {
        let history = LogHistory(pageSize: 2)
        var calls = 0
        await history.start(paginated: false) { offset, _ in
            calls += 1
            XCTAssertEqual(offset, 0)
            return [self.row(1), self.row(2), self.row(3)]
        }.value
        XCTAssertEqual(calls, 1)
        await history.refresh().value
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(history.entries.count, 3)
    }

    func testStoppedFetchCannotWriteIntoAnotherRun() async {
        let history = LogHistory()
        let ready = expectation(description: "old run fetch")
        var reply: CheckedContinuation<[LogHistory.Row], Error>?
        let oldLoad = history.start { _, _ in
            try await withCheckedThrowingContinuation { reply = $0; ready.fulfill() }
        }
        await fulfillment(of: [ready], timeout: 2)
        await history.start { _, _ in [self.row(9)] }.value
        // Simulate a transport that returns despite cancellation.
        reply?.resume(returning: [row(1)])
        await oldLoad.value
        XCTAssertEqual(history.entries.map(\.content), ["line 9"])
        XCTAssertNil(history.error)
    }

    func testLeavingScreenDiscardsLateRecovery() async {
        let history = LogHistory()
        var hold = false
        let ready = expectation(description: "recovery fetch")
        var reply: CheckedContinuation<[LogHistory.Row], Error>?
        await history.start { _, _ in
            if hold { return try await withCheckedThrowingContinuation { reply = $0; ready.fulfill() } }
            return [self.row(1)]
        }.value
        hold = true
        let recovery = history.refresh()
        await fulfillment(of: [ready], timeout: 2)
        history.stop()
        reply?.resume(returning: [row(1), row(2)])
        await recovery.value
        XCTAssertEqual(history.entries.map(\.content), ["line 1"])
    }

    func testReconnectDuringFetchSchedulesAnotherPass() async {
        let history = LogHistory()
        let ready = expectation(description: "first fetch")
        var reply: CheckedContinuation<[LogHistory.Row], Error>?
        var calls = 0
        let first = history.start { _, _ in
            calls += 1
            if calls == 1 { return try await withCheckedThrowingContinuation { reply = $0; ready.fulfill() } }
            return [self.row(1), self.row(2)]
        }
        await fulfillment(of: [ready], timeout: 2)
        XCTAssertFalse(history.connectionOpened())
        XCTAssertTrue(history.connectionOpened())
        reply?.resume(returning: [row(1)])
        await first.value
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(history.entries.map(\.content), ["line 1", "line 2"])
    }
}
