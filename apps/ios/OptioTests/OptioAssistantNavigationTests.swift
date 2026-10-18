import XCTest
@testable import Optio

@MainActor
final class OptioAssistantNavigationTests: XCTestCase {
    func testAssistantHasItsOwnTabAndDeepLink() {
        let router = AppRouter()
        router.open(.assistant)
        XCTAssertEqual(router.selectedTab, .assistant)
        router.selectedTab = .work
        XCTAssertTrue(router.handle(url: URL(string: "optio://section/assistant")!))
        XCTAssertEqual(router.selectedTab, .assistant)
        XCTAssertEqual(AppRouter.section(named: "optio")?.0, .assistant)
    }

    func testInsightsRemainReachableThroughMore() {
        let router = AppRouter()
        for section in [AppRouter.Section.analytics, .costs, .activity, .cluster] {
            router.open(section)
            XCTAssertEqual(router.selectedTab, .more)
            XCTAssertEqual(router.pendingSection, section)
        }
    }

    func testAssistantSettingsDecodeRuntimeAndOptions() throws {
        let data = Data(#"{"agentRuntime":"codex","agentOptions":{"codexModel":"gpt-5.4","codexYolo":true},"model":"gpt-5.4"}"#.utf8)
        let settings = try JSONDecoder().decode(OptioSettingsRow.self, from: data)
        XCTAssertEqual(settings.agentRuntime, "codex")
        XCTAssertEqual(settings.agentOptions?["codexModel"]?.stringValue, "gpt-5.4")
        XCTAssertEqual(settings.agentOptions?["codexYolo"]?.boolValue, true)
    }
}
