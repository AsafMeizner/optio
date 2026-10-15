import XCTest

/// Run against the isolated mobile dev API. Exercises the redesigned navigation,
/// work filters and optional examples without creating or modifying work.
final class MobileDesignUITests: XCTestCase {
    func testWorkSearchIsVisibleAndFiltersRows() throws {
        let app = try launch(section: "work")
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        XCTAssertTrue(search.isHittable, "Search must be visible without pulling down the list")
        search.tap()
        search.typeText("no-work-matches-this-query")
        XCTAssertTrue(app.staticTexts["No matching work"].waitForExistence(timeout: 5))
        app.buttons["Clear filters"].tap()
        XCTAssertTrue(app.staticTexts["No matching work"].waitForNonExistence(timeout: 5))
        save(app, "ios-work-search")
    }

    func testOverviewHasOneActiveWorkList() throws {
        let app = try launch(section: "overview")
        XCTAssertTrue(app.staticTexts["Active now"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.staticTexts["Needs you"].exists, "The duplicate attention list is removed")
        save(app, "ios-overview-work")
    }

    func testCostSummaryIsNotDisabledAndCardsScrollVertically() throws {
        let app = try launch(section: "costs")
        let totalLabel = NSPredicate(format: "label BEGINSWITH %@", "Total:")
        let total = app.descendants(matching: .any).matching(totalLabel).firstMatch
        XCTAssertTrue(total.waitForExistence(timeout: 15))
        XCTAssertTrue(total.isEnabled)
        XCTAssertFalse(app.buttons.matching(totalLabel).firstMatch.exists, "Read-only metrics must not be disabled buttons")
        save(app, "ios-costs-summary")

        let marker = app.staticTexts["Cost by model"]
        XCTAssertTrue(marker.waitForExistence(timeout: 5))
        let before = marker.frame
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.76))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.4)))
        XCTAssertTrue(marker.waitForExistence(timeout: 5))
        XCTAssertLessThan(marker.frame.minY, before.minY - 40, "A diagonal drag should scroll down the cards")
        XCTAssertEqual(marker.frame.minX, before.minX, accuracy: 1, "Cards must stay aligned horizontally")
        save(app, "ios-costs-scrolled")
    }

    func testWorkFiltersAndCreation() throws {
        let app = try launch(section: "work")
        let needsYou = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Needs you:")).firstMatch
        XCTAssertTrue(needsYou.waitForExistence(timeout: 15))
        save(app, "ios-work")
        needsYou.tap()
        XCTAssertTrue(needsYou.isSelected)
        needsYou.tap()
        XCTAssertFalse(needsYou.isSelected)
        app.buttons["New work"].firstMatch.tap()
        let examples = app.buttons["Use an example"].firstMatch
        XCTAssertTrue(examples.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Open a PR"].exists)
        save(app, "ios-new-work")
        examples.tap()
        XCTAssertTrue(app.buttons["Open a PR"].waitForExistence(timeout: 3))
        app.buttons["Cancel"].firstMatch.tap()
        XCTAssertTrue(needsYou.waitForExistence(timeout: 5))
    }

    func testHubDestinationsRemainReachable() throws {
        let app = try launch(section: "work")
        XCTAssertTrue(app.buttons["New work"].firstMatch.waitForExistence(timeout: 15))
        for (tab, section) in [("Library", "Repos"), ("Insights", "Costs"), ("Work", "Reviews"), ("Work", "Inbox")] {
            app.tabBars.buttons[tab].tap()
            let button = app.buttons[section].firstMatch
            XCTAssertTrue(button.waitForExistence(timeout: 5))
            button.tap()
            XCTAssertTrue(button.isSelected)
            save(app, "ios-\(section.lowercased())")
        }
        app.tabBars.buttons["Overview"].tap()
        XCTAssertTrue(app.navigationBars["Overview"].waitForExistence(timeout: 5))
        save(app, "ios-overview")
        app.tabBars.buttons["More"].tap()
        XCTAssertTrue(app.staticTexts["Servers"].firstMatch.waitForExistence(timeout: 5))
        save(app, "ios-more")
    }

    private func launch(section: String) throws -> XCUIApplication {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["OPTIO_UITEST_SERVER_URL"], let token = env["OPTIO_UITEST_TOKEN"] else {
            throw XCTSkip("Requires the isolated mobile dev API: OPTIO_UITEST_SERVER_URL / OPTIO_UITEST_TOKEN")
        }
        let app = XCUIApplication()
        app.launchEnvironment["OPTIO_DEV_SERVER_URL"] = server
        app.launchEnvironment["OPTIO_DEV_TOKEN"] = token
        app.launchEnvironment["OPTIO_DEV_NO_PUSH_PROMPT"] = "1"
        app.launchEnvironment["OPTIO_DEV_SECTION"] = section
        app.launch()
        return app
    }

    private func save(_ app: XCUIApplication, _ name: String) {
        let shot = app.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = ProcessInfo.processInfo.environment["OPTIO_UITEST_SHOT_DIR"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }
}
