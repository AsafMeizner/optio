import XCTest

/// Drives a real drag on a terminal screen and checks the view actually scrolls.
/// Needs a dev server and a terminal id:
///   OPTIO_UITEST_SERVER_URL, OPTIO_UITEST_TOKEN, OPTIO_UITEST_TERMINAL_ID
///   (optional OPTIO_UITEST_TERMINAL_TITLE to navigate via the Live tab when the deep link misses)
/// The screenshots land in the test attachments (and, when
/// OPTIO_UITEST_SHOT_DIR is set, as PNG files in that directory).
final class TerminalScrollUITests: XCTestCase {
    func testDragScrollsTerminal() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["OPTIO_UITEST_SERVER_URL"], let token = env["OPTIO_UITEST_TOKEN"], let terminal = env["OPTIO_UITEST_TERMINAL_ID"] else {
            throw XCTSkip("set OPTIO_UITEST_SERVER_URL / _TOKEN / _TERMINAL_ID")
        }
        let app = XCUIApplication()
        app.launchEnvironment["OPTIO_DEV_SERVER_URL"] = server
        app.launchEnvironment["OPTIO_DEV_TOKEN"] = token
        app.launchEnvironment["OPTIO_DEV_OPEN_URL"] = "optio://local/\(terminal)"
        app.launch()
        sleep(6)
        // A first launch asks for notification permission; the alert would eat the first drag.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 2) { allow.tap() }
        // The dev deep link is best-effort; if we did not land on the session, walk there
        // through Work › All (a Local session row shows its title).
        let title = env["OPTIO_UITEST_TERMINAL_TITLE"]
        if let title, !app.staticTexts[title].waitForExistence(timeout: 4) {
            app.tabBars.buttons["Work"].tap()
            let row = app.staticTexts[title].firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 8), "session row \(title) not found under Work")
            row.tap()
            XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 10), "session screen did not open")
        }
        // An agent session opens on its Chat face; the drag under test is on the Terminal face.
        let terminalFace = app.segmentedControls.buttons["Terminal"]
        if terminalFace.waitForExistence(timeout: 2) { terminalFace.tap() }
        sleep(3)
        save(app.screenshot(), "before")
        let mid = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
        let lower = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
        mid.press(forDuration: 0.05, thenDragTo: lower)
        sleep(1)
        save(app.screenshot(), "after-drag-down")
        lower.press(forDuration: 0.05, thenDragTo: mid)
        sleep(1)
        save(app.screenshot(), "after-drag-up")
    }

    private func save(_ shot: XCUIScreenshot, _ name: String) {
        let a = XCTAttachment(screenshot: shot)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["OPTIO_UITEST_SHOT_DIR"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }
}
