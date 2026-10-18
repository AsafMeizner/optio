import XCTest
@testable import Optio

@MainActor
final class OptioAssistantModelTests: XCTestCase {
    func testHandshakeDoesNotEnableSendingBeforeReady() {
        let model = OptioAssistantModel()
        model.handle(.opened)
        XCTAssertFalse(model.canSend)
        model.handle(.json(["type": "status", "status": "ready"]))
        XCTAssertTrue(model.canSend)
    }

    func testStreamingTextAndActionReceiptsRemainSeparate() {
        let model = OptioAssistantModel()
        model.handle(.json(["type": "text", "content": "Hello "]))
        model.handle(.json(["type": "text", "content": "there"]))
        XCTAssertEqual(model.rows.count, 1)
        XCTAssertEqual(model.rows[0].text, "Hello there")
        model.handle(.json(["type": "action_result", "summary": "Work created. [Open work](/work/123)", "success": true]))
        model.handle(.json(["type": "text", "content": "All done"]))
        XCTAssertEqual(model.rows.count, 3)
        XCTAssertFalse(model.rows[1].isError)
        XCTAssertEqual(model.rows[2].text, "All done")
    }

    func testStructuredProposalBlocksSendingAndPreservesAllSettings() {
        let model = OptioAssistantModel()
        let work: [String: Any] = ["name": "Fix login", "where": ["localDir": "/repo"], "settings": ["controllerAccess": "manage"]]
        model.handle(.json(["type": "action_proposal", "actionId": "a1", "description": "Review", "work": [work], "items": []]))
        model.handle(.json(["type": "status", "status": "waiting_for_approval"]))
        XCTAssertFalse(model.canSend)
        XCTAssertFalse(model.canReset)
        model.handle(.json(["type": "status", "status": "ready"]))
        XCTAssertFalse(model.canReset, "A pending proposal blocks clear even before waiting status arrives")
        let proposal = try! XCTUnwrap(model.rows.first?.proposal)
        XCTAssertEqual(proposal.id, "a1")
        XCTAssertTrue(OptioAssistantModel.json(proposal.work).contains("controllerAccess"))
        XCTAssertTrue(OptioAssistantModel.json(proposal.work).contains("manage"))
    }

    func testDisconnectExpiresActionsAndPreservesDraft() {
        let model = OptioAssistantModel()
        model.draft = "My dictated message"
        model.handle(.json(["type": "action_proposal", "actionId": "a1", "description": "Review", "items": ["create_task(...)"], "work": []]))
        model.handle(.closed(code: 1006, reason: "Connection lost"))
        XCTAssertEqual(model.status, .disconnected)
        XCTAssertNotNil(model.rows[0].proposal?.decision)
        XCTAssertEqual(model.draft, "My dictated message")
        XCTAssertTrue(model.rows.last!.isError)
        XCTAssertFalse(model.canSend)
    }

    func testClosingDuringExecutionExplainsUncertainResult() {
        let model = OptioAssistantModel()
        model.handle(.json(["type": "status", "status": "executing"]))
        model.stop()
        XCTAssertTrue(model.rows.last!.text.contains("Check Work"))
        XCTAssertTrue(model.rows.last!.text.contains("uncertain"))
        XCTAssertEqual(model.status, .disconnected)
    }

    func testErrorIsVisibleAndEndsStreamingBubble() {
        let model = OptioAssistantModel()
        model.handle(.json(["type": "text", "content": "Starting"]))
        model.handle(.json(["type": "error", "message": "Please refresh your credentials"]))
        model.handle(.json(["type": "status", "status": "ready"]))
        model.handle(.json(["type": "text", "content": "Next response"]))
        XCTAssertEqual(model.rows.count, 3)
        XCTAssertTrue(model.rows[1].isError)
        XCTAssertEqual(model.rows[1].text, "Please refresh your credentials")
        XCTAssertTrue(model.canSend)
    }

    func testHistoryReplacesLocalRowsAndPreservesDraftAndSessionIdentity() {
        let model = OptioAssistantModel()
        model.draft = "Unsent dictation"
        model.handle(.json(["type": "text", "content": "Old local response"]))
        let id = UUID().uuidString
        let href = "/sessions/\(id)"
        model.handle(.json(["type": "history", "sessionId": id, "href": href, "frames": [
            ["type": "user_message", "content": "Saved prompt", "requestId": "request-1"],
            ["type": "text", "content": "Saved answer"],
            ["type": "action_result", "summary": "Creation failed", "success": false],
            ["type": "error", "message": "Saved error"],
            ["type": "unknown", "content": "Ignore me"],
        ]]))
        XCTAssertEqual(model.rows.map(\.text), ["Saved prompt", "Saved answer", "Creation failed", "Saved error"])
        XCTAssertEqual(model.rows.first?.role, "user")
        XCTAssertTrue(model.rows[2].isError)
        XCTAssertTrue(model.rows[3].isError)
        XCTAssertEqual(model.draft, "Unsent dictation")
        XCTAssertEqual(model.sessionId, id)
        XCTAssertEqual(model.sessionHref, href)
    }

    func testUserEchoDeduplicatesOptimisticAndHistoryMessagesByRequestId() {
        let model = OptioAssistantModel()
        let id = UUID().uuidString
        model.appendUserMessage("My prompt", requestId: id)
        model.handle(.json(["type": "user_message", "content": "My prompt", "requestId": id]))
        XCTAssertEqual(model.rows.count, 1)
        model.handle(.json(["type": "history", "frames": [["type": "user_message", "content": "My prompt", "requestId": id]]]))
        model.handle(.json(["type": "user_message", "content": "My prompt", "requestId": id]))
        XCTAssertEqual(model.rows.count, 1)
        model.handle(.json(["type": "user_message", "content": "My prompt", "requestId": UUID().uuidString]))
        XCTAssertEqual(model.rows.count, 2, "Identical messages from distinct requests must remain visible")
    }

    func testEmptyHistoryClearsTranscriptAndPendingProposalButKeepsDraft() {
        let model = OptioAssistantModel()
        model.draft = "Keep me"
        model.handle(.json(["type": "action_proposal", "actionId": "pending", "description": "Review", "items": [], "work": []]))
        model.handle(.json(["type": "history", "frames": []]))
        model.handle(.json(["type": "status", "status": "ready"]))
        XCTAssertTrue(model.rows.isEmpty)
        XCTAssertEqual(model.draft, "Keep me")
        XCTAssertTrue(model.canReset)
    }

    func testReconnectHistoryRestoresPendingProposalAndRejectsExternalSessionHref() {
        let model = OptioAssistantModel()
        model.handle(.json(["type": "action_proposal", "actionId": "pending", "description": "Review", "items": [], "work": []]))
        model.stop()
        XCTAssertNotNil(model.rows[0].proposal?.decision)
        model.handle(.json(["type": "history", "sessionId": UUID().uuidString, "href": "https://example.com", "frames": []]))
        model.handle(.json(["type": "action_proposal", "actionId": "pending", "description": "Review", "items": [], "work": []]))
        model.handle(.json(["type": "status", "status": "waiting_for_approval"]))
        XCTAssertEqual(model.rows.count, 1)
        XCTAssertNil(model.rows[0].proposal?.decision)
        XCTAssertNil(model.sessionHref)
        XCTAssertFalse(model.canReset)
    }

    func testOtherClientsDecisionAndExpirySettlePendingProposals() {
        for (type, expected) in [("action_decision", "Declined"), ("action_expired", "Expired — request a fresh proposal")] {
            let model = OptioAssistantModel()
            let proposal: [String: Any] = ["type": "action_proposal", "actionId": "pending", "description": "Review", "items": [], "work": []]
            model.handle(.json(proposal))
            model.handle(.json(proposal))
            XCTAssertEqual(model.rows.count, 1, "Snapshot and live proposal must not duplicate")
            model.handle(.json(["type": type, "actionId": "pending", "approved": false]))
            model.handle(.json(["type": "status", "status": "ready"]))
            XCTAssertEqual(model.rows[0].proposal?.decision, expected)
            XCTAssertTrue(model.canSend)
            XCTAssertTrue(model.canReset)
        }
    }

    func testActionReceiptRecoversAMissedApprovalDecision() {
        let model = OptioAssistantModel()
        model.handle(.json(["type": "action_proposal", "actionId": "pending", "description": "Review", "items": [], "work": []]))
        model.handle(.json(["type": "action_result", "actionId": "pending", "summary": "Creation failed", "success": false]))
        model.handle(.json(["type": "status", "status": "ready"]))
        XCTAssertEqual(model.rows[0].proposal?.decision, "Approved")
        XCTAssertTrue(model.rows[1].isError)
        XCTAssertTrue(model.canSend)
    }
}
