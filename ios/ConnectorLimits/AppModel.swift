import Foundation
import WidgetKit

@MainActor
final class AppModel: ObservableObject {
    static var defaultURL: String {
        ProcessInfo.processInfo.environment["CONNECTOR_BASE_URL"]
            ?? "https://cursor-claude-connector-production-1515.up.railway.app"
    }
    @Published var connected: [ProviderID: Bool] = [:]
    @Published var snapshots: [ProviderID: UsageSnapshot] = [:]
    @Published var isRefreshing = false
    @Published var errorMessage: String?
    @Published var displayRemaining = UserDefaults.standard.bool(forKey: "displayRemaining")

    var baseURL: String {
        get {
            let shared = KeychainStore.read("baseURL")
            return shared.isEmpty ? UserDefaults.standard.string(forKey: "baseURL") ?? Self.defaultURL : shared
        }
        set {
            objectWillChange.send()
            UserDefaults.standard.set(newValue, forKey: "baseURL")
            KeychainStore.write(newValue, key: "baseURL")
        }
    }
    var apiKey: String { get { KeychainStore.read("apiKey") } set { KeychainStore.write(newValue, key: "apiKey") } }

    var client: APIClient {
        APIClient(baseURL: URL(string: baseURL.trimmingCharacters(in: .whitespacesAndNewlines)) ?? URL(string: Self.defaultURL)!, apiKey: apiKey)
    }

    func refresh() async {
        isRefreshing = true
        defer { isRefreshing = false }
        for provider in ProviderID.allCases {
            do {
                let active = try await client.status(provider)
                connected[provider] = active
                if active { snapshots[provider] = try? await client.usage(provider) }
            } catch { connected[provider] = false }
        }
        await NotificationCoordinator.sync(snapshots: snapshots)
        WidgetCenter.shared.reloadAllTimelines()
    }

    func saveSettings(url: String, key: String, remaining: Bool) async {
        baseURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
        apiKey = key
        displayRemaining = remaining
        UserDefaults.standard.set(remaining, forKey: "displayRemaining")
        await refresh()
    }

}
