import XCTest

final class OptioAssistantUITests: XCTestCase {
    func testAssistantOpensFromWorkAndKeepsDraftAfterDismissal() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["OPTIO_UITEST_SERVER_URL"], let token = env["OPTIO_UITEST_TOKEN"] else {
            throw XCTSkip("Requires the isolated mobile dev API")
        }
        let app = XCUIApplication()
        app.launchEnvironment["OPTIO_DEV_SERVER_URL"] = server
        app.launchEnvironment["OPTIO_DEV_TOKEN"] = token
        app.launchEnvironment["OPTIO_DEV_NO_PUSH_PROMPT"] = "1"
        app.launchEnvironment["OPTIO_DEV_SECTION"] = "work"
        app.launch()
        let ask = app.buttons["Ask Optio"].firstMatch
        XCTAssertTrue(ask.waitForExistence(timeout: 20))
        ask.tap()
        XCTAssertTrue(app.staticTexts["Turn an idea into work"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Clear conversation"].exists)
        app.buttons["Help me start work on my machine"].tap()
        // SwiftUI reports a multiline field as TextField or TextView across iOS versions.
        let draft = app.descendants(matching: .any).matching(identifier: "Message to Optio").firstMatch
        XCTAssertTrue(draft.waitForExistence(timeout: 5))
        XCTAssertEqual(draft.value as? String, "Help me start work on my machine")
        draft.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(draft.frame.maxY, app.keyboards.firstMatch.frame.minY)
        XCTAssertTrue(app.buttons["Send message"].isHittable)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "ios-assistant-keyboard"
        shot.lifetime = .keepAlways
        add(shot)
        app.buttons["Close"].tap()
        XCTAssertTrue(ask.waitForExistence(timeout: 5))
        ask.tap()
        XCTAssertTrue(draft.waitForExistence(timeout: 5))
        XCTAssertEqual(draft.value as? String, "Help me start work on my machine")
    }
}
