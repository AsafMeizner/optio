import XCTest
import SwiftUI
@testable import Optio

final class ChatMarkdownTests: XCTestCase {
    func testTableBetweenParagraphsWithAlignmentAndFormatting() {
        XCTAssertEqual(ChatMarkdownBlocks.parse("Before\n\n| Name | Status | Count |\n| :--- | :---: | ---: |\n| **Agent** | `ready` | 12 |\n\nAfter"), [
            .prose("Before\n"),
            .table(.init(headers: ["Name", "Status", "Count"], alignments: [.left, .center, .right], rows: [["**Agent**", "`ready`", "12"]])),
            .prose("\nAfter"),
        ])
    }

    func testOptionalOuterPipesAndRaggedRows() {
        XCTAssertEqual(ChatMarkdownBlocks.parse("Name | Count\n--- | ---\nA | 1 | extra\nB |"), [
            .table(.init(headers: ["Name", "Count"], alignments: [.left, .left], rows: [["A", "1"], ["B", ""]])),
        ])
    }

    func testEscapedPipesDoNotCreateColumns() {
        XCTAssertEqual(ChatMarkdownBlocks.parse("| A | B |\n| --- | --- |\n" + #"| a\|b | `c\|d` |"#), [
            .table(.init(headers: ["A", "B"], alignments: [.left, .left], rows: [["a|b", "`c|d`"]])),
        ])
    }

    func testCodeAndIncompleteOrInvalidTablesRemainProse() {
        for source in [
            "```markdown\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```",
            "~~~~\nA | B\n--- | ---\n~~~~",
            "    A | B\n    --- | ---",
            "A | B\n--- | nope",
            "A | B\n--- | --- | ---",
            "A | B\n| --",
            "Just **bold** text and `code`.",
        ] {
            XCTAssertEqual(ChatMarkdownBlocks.parse(source), [.prose(source)], source)
        }
    }

    func testStreamingAndMultipleTables() {
        let header = "| A | B |\n| --- | --- |"
        XCTAssertEqual(ChatMarkdownBlocks.parse(header), [.table(.init(headers: ["A", "B"], alignments: [.left, .left], rows: []))])
        let blocks = ChatMarkdownBlocks.parse(header + "\n| partial |\n\n" + header + "\n| done | yes |")
        XCTAssertEqual(blocks.count, 3)
        XCTAssertEqual(blocks[0], .table(.init(headers: ["A", "B"], alignments: [.left, .left], rows: [["partial", ""]])))
        XCTAssertEqual(blocks[2], .table(.init(headers: ["A", "B"], alignments: [.left, .left], rows: [["done", "yes"]])))
    }

    @MainActor
    func testWideTableFitsPhoneWithHorizontalScrolling() {
        let host = UIHostingController(rootView: ChatMarkdown(text: "| Name | Status | Notes |\n| --- | --- | --- |\n| Agent | Ready | A longer description that wraps within its column. |"))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 700))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.frame = window.bounds
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        func scrolls(_ view: UIView) -> [UIScrollView] {
            (view as? UIScrollView).map { [$0] } ?? view.subviews.flatMap(scrolls)
        }
        let table = scrolls(host.view).first
        XCTAssertNotNil(table)
        if let table {
            XCTAssertLessThanOrEqual(table.bounds.width, 320)
            XCTAssertGreaterThan(table.contentSize.width, table.bounds.width)
            XCTAssertGreaterThan(table.bounds.height, 60)
        }
    }
}
