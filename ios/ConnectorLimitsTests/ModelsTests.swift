import XCTest
@testable import NoLimits

final class ModelsTests: XCTestCase {
    func testUsageSnapshotDecodesConnectorContract() throws {
        let json = #"{"providerId":"codex","windows":[{"label":"Session","usedPercent":42,"resetAt":null,"windowSeconds":18000,"kind":"session"}],"lastUpdated":"2026-07-16T00:00:00Z","accountLabel":"acct","credits":[],"experimental":true}"#
        let value = try JSONDecoder().decode(UsageSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(value.providerId, .codex)
        XCTAssertEqual(value.windows.first?.usedPercent, 42)
    }

    func testProviderInventoryIsStable() {
        XCTAssertEqual(ProviderID.allCases, [.anthropic, .codex, .cursor, .antigravity, .opencode])
    }
}
