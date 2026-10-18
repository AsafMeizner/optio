import XCTest

final class OptioAssistantUITests: XCTestCase {
    func testDedicatedAgentTabKeepsDraftAndProvidesHarnessSettings() throws {
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
        let agentTab = app.tabBars.buttons["Optio Agent"]
        XCTAssertTrue(agentTab.waitForExistence(timeout: 20))
        for label in ["Overview", "Work", "Optio Agent", "Library", "More"] {
            XCTAssertTrue(app.tabBars.buttons[label].exists)
        }
        agentTab.tap()
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
        let hideKeyboard = app.buttons["Hide keyboard"]
        XCTAssertFalse(hideKeyboard.frame.intersects(app.buttons["Send message"].frame))
        hideKeyboard.tap()
        app.tabBars.buttons["Work"].tap()
        XCTAssertTrue(agentTab.waitForExistence(timeout: 5))
        agentTab.tap()
        XCTAssertTrue(draft.waitForExistence(timeout: 5))
        XCTAssertEqual(draft.value as? String, "Help me start work on my machine")
        app.buttons["Agent settings"].tap()
        let harness = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Harness")).firstMatch
        XCTAssertTrue(harness.waitForExistence(timeout: 10))
        harness.tap()
        for label in ["Claude Code", "OpenAI Codex", "GitHub Copilot", "Google Gemini", "OpenCode", "Cursor"] {
            XCTAssertTrue(app.buttons[label].firstMatch.waitForExistence(timeout: 3))
        }
        app.buttons["OpenAI Codex"].firstMatch.tap()
        app.swipeUp()
        let save = app.buttons["Save settings"]
        for _ in 0..<4 where !save.isHittable { app.swipeUp() }
        XCTAssertTrue(save.isHittable)
        save.tap()
        XCTAssertTrue(app.buttons["Saved"].waitForExistence(timeout: 8))
        app.buttons["Done"].firstMatch.tap()
        XCTAssertTrue(draft.waitForExistence(timeout: 5))
        XCTAssertEqual(draft.value as? String, "Help me start work on my machine")
    }
}
