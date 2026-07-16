import XCTest

final class LockScreenSetupTests: XCTestCase {
    func testOpenLockScreenEditor() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        sleep(1)
        springboard.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.55)).press(forDuration: 2)
        sleep(12)
    }
}
