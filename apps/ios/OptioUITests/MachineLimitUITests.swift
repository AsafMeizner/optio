import XCTest

/// Library › Machines: the agent limit stepper saves through the API.
/// Needs a dev server: OPTIO_UITEST_SERVER_URL, OPTIO_UITEST_TOKEN,
/// OPTIO_UITEST_HOST_NAME (a paired machine's name); screenshots in OPTIO_UITEST_SHOT_DIR.
final class MachineLimitUITests: XCTestCase {
    func testStepperChangesTheLimit() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["OPTIO_UITEST_SERVER_URL"], let token = env["OPTIO_UITEST_TOKEN"], let hostName = env["OPTIO_UITEST_HOST_NAME"] else {
            throw XCTSkip("set OPTIO_UITEST_SERVER_URL / _TOKEN / _HOST_NAME")
        }
        let app = XCUIApplication()
        app.launchEnvironment["OPTIO_DEV_SERVER_URL"] = server
        app.launchEnvironment["OPTIO_DEV_TOKEN"] = token
        app.launchEnvironment["OPTIO_DEV_SECTION"] = "machines"
        app.launch()
        XCTAssertTrue(app.staticTexts[hostName].waitForExistence(timeout: 15), "machine not listed")
        let stepper = app.steppers.matching(NSPredicate(format: "label BEGINSWITH 'Agents at once'")).firstMatch
        var swipes = 0
        while !stepper.exists, swipes < 12 {
            app.swipeUp()
            swipes += 1
        }
        XCTAssertTrue(stepper.waitForExistence(timeout: 5), "agent limit stepper not found")
        save(app.screenshot(), "machines-limit")
        let before = stepper.label
        stepper.buttons["Increment"].tap()
        XCTAssertTrue(stepper.label != before, "stepper did not change")
        sleep(2)
        save(app.screenshot(), "machines-limit-after")
        stepper.buttons["Decrement"].tap()
        sleep(2)
    }

    private func save(_ shot: XCUIScreenshot, _ name: String) {
        if let dir = ProcessInfo.processInfo.environment["OPTIO_UITEST_SHOT_DIR"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }
}
