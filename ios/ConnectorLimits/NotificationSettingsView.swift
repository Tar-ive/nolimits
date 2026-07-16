import SwiftUI
import UserNotifications

struct NotificationSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage("notifications.enabled") private var enabled = false
    @AppStorage("notifications.weeklyReset") private var weeklyReset = true
    @AppStorage("notifications.unexpectedReset") private var unexpectedReset = true
    @AppStorage("notifications.sessionReset") private var sessionReset = true
    @AppStorage("notifications.afterResetThreshold") private var afterResetThreshold = 10
    @AppStorage("notifications.weeklyWarnings") private var weeklyWarnings = true
    @AppStorage("notifications.warningDays") private var warningDays = 2
    @AppStorage("notifications.warningRemaining") private var warningRemaining = 20

    var body: some View {
        Form {
            Section {
                Toggle("Enable notifications", isOn: $enabled)
            } footer: {
                Text("Limits checks notification rules after fresh provider usage is available.")
            }

            Section("Tell me when limits are back") {
                Toggle("Weekly limits are back", isOn: $weeklyReset)
                Toggle("Unexpected weekly resets", isOn: $unexpectedReset)
                Toggle("Session limits are back", isOn: $sessionReset)
                Picker("Notify after reset", selection: $afterResetThreshold) {
                    Text("If under 5% left").tag(5)
                    Text("If under 10% left").tag(10)
                    Text("If under 20% left").tag(20)
                }
            }.disabled(!enabled)

            Section("Warn before weekly runs out") {
                Toggle("Enable weekly warnings", isOn: $weeklyWarnings)
                Picker("Weekly timing", selection: $warningDays) {
                    Text("1 day before").tag(1)
                    Text("2 days before").tag(2)
                    Text("3 days before").tag(3)
                }
                Picker("Weekly remaining", selection: $warningRemaining) {
                    Text("10% left").tag(10)
                    Text("20% left").tag(20)
                    Text("30% left").tag(30)
                }
            }.disabled(!enabled)
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: enabled) { _, isEnabled in
            Task {
                if isEnabled {
                    let granted = await NotificationCoordinator.requestAuthorization()
                    if !granted { enabled = false }
                }
                await model.refresh()
            }
        }
        .onChange(of: weeklyReset) { Task { await model.refresh() } }
        .onChange(of: unexpectedReset) { Task { await model.refresh() } }
        .onChange(of: sessionReset) { Task { await model.refresh() } }
        .onChange(of: afterResetThreshold) { Task { await model.refresh() } }
        .onChange(of: weeklyWarnings) { Task { await model.refresh() } }
        .onChange(of: warningDays) { Task { await model.refresh() } }
        .onChange(of: warningRemaining) { Task { await model.refresh() } }
    }
}

enum NotificationCoordinator {
    private static let prefix = "limits."
    private static let center = UNUserNotificationCenter.current()

    static func requestAuthorization() async -> Bool {
        registerDefaults()
        return (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    static func sync(snapshots: [ProviderID: UsageSnapshot]) async {
        registerDefaults()
        let defaults = UserDefaults.standard
        let pending = await center.pendingNotificationRequests()
        center.removePendingNotificationRequests(withIdentifiers: pending.map(\.identifier).filter { $0.hasPrefix(prefix) })
        guard defaults.bool(forKey: "notifications.enabled") else { return }

        for (provider, snapshot) in snapshots {
            for window in snapshot.windows {
                guard let reset = date(window.resetAt), reset > .now else { continue }
                let weekly = window.kind.lowercased().contains("weekly") || window.label.lowercased().contains("week") || window.label.contains("7 day")
                let remaining = max(0, 100 - window.usedPercent)
                let threshold = defaults.integer(forKey: "notifications.afterResetThreshold")
                let resetEnabled = weekly ? defaults.bool(forKey: "notifications.weeklyReset") : defaults.bool(forKey: "notifications.sessionReset")
                if resetEnabled && remaining <= Double(threshold) {
                    await add(id: "\(prefix)reset.\(provider.rawValue).\(window.id)", title: "\(provider.name) limits are back", body: "\(window.label) usage has reset.", at: reset)
                }

                if weekly && defaults.bool(forKey: "notifications.weeklyWarnings") {
                    let warningRemaining = defaults.integer(forKey: "notifications.warningRemaining")
                    let days = defaults.integer(forKey: "notifications.warningDays")
                    let warningDate = reset.addingTimeInterval(-Double(days) * 86_400)
                    if remaining <= Double(warningRemaining), warningDate > .now {
                        await add(id: "\(prefix)warning.\(provider.rawValue).\(window.id)", title: "\(provider.name) weekly limit is low", body: "\(Int(remaining.rounded()))% remains before the next reset.", at: warningDate)
                    }
                }

                if weekly { await detectUnexpectedReset(provider: provider, window: window, reset: reset) }
            }
        }
    }

    private static func detectUnexpectedReset(provider: ProviderID, window: UsageWindow, reset: Date) async {
        let defaults = UserDefaults.standard
        let key = "notifications.lastReset.\(provider.rawValue).\(window.id)"
        let previous = defaults.double(forKey: key)
        defaults.set(reset.timeIntervalSince1970, forKey: key)
        guard defaults.bool(forKey: "notifications.unexpectedReset"), previous > 0,
              reset.timeIntervalSince1970 < previous - 3_600 else { return }
        let content = UNMutableNotificationContent()
        content.title = "\(provider.name) reset changed"
        content.body = "The weekly limit reset earlier than scheduled."
        content.sound = .default
        try? await center.add(UNNotificationRequest(identifier: "\(prefix)unexpected.\(provider.rawValue).\(Int(reset.timeIntervalSince1970))", content: content, trigger: nil))
    }

    private static func add(id: String, title: String, body: String, at date: Date) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        try? await center.add(UNNotificationRequest(identifier: id, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: parts, repeats: false)))
    }

    private static func date(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return precise.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
    }

    private static func registerDefaults() {
        UserDefaults.standard.register(defaults: [
            "notifications.weeklyReset": true,
            "notifications.unexpectedReset": true,
            "notifications.sessionReset": true,
            "notifications.afterResetThreshold": 10,
            "notifications.weeklyWarnings": true,
            "notifications.warningDays": 2,
            "notifications.warningRemaining": 20,
        ])
    }
}
