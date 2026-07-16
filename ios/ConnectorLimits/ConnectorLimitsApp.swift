import SwiftUI

@main
struct NoLimitsApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            DashboardView().environmentObject(model).task { await model.refresh() }
        }
    }
}
