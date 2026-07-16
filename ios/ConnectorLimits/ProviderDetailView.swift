import SwiftUI

struct ProviderDetailView: View {
    @EnvironmentObject private var model: AppModel
    let provider: ProviderID

    var body: some View {
        List {
            Section("Account") {
                LabeledContent("Status", value: model.connected[provider] == true ? "Connected" : "Disconnected")
                if let account = model.snapshots[provider]?.accountLabel { LabeledContent("Account", value: account) }
            }
            if let snapshot = model.snapshots[provider] {
                if provider == .codex, let status = snapshot.rateLimitStatus {
                    Section("Rate limit status") {
                        LabeledContent("Allowed", value: status.allowed ? "Yes" : "No")
                        LabeledContent("Limit reached", value: status.limitReached ? "Yes" : "No")
                    }
                }
                Section("Limits") { ForEach(snapshot.windows) { UsageRow(window: $0).padding(.vertical, 5) } }
                if provider == .codex, let count = snapshot.resetCredits?.availableCount {
                    Section {
                        ForEach(0..<count, id: \.self) { index in
                            LabeledContent("Reset \(index + 1)", value: "Available")
                        }
                        if count == 0 { Text("No reset credits available").foregroundStyle(.secondary) }
                    } header: { Text("Reset credits") } footer: {
                        Text("Free rate-limit resets on your account. Redeem one in Codex when you hit a limit.")
                    }
                }
                Section { LabeledContent("Updated", value: snapshot.lastUpdated) }
            }
        }
        .font(.body.weight(.medium))
        .navigationTitle(provider.name)
        .toolbar { ToolbarItem(placement: .principal) { HStack { ProviderLogo(provider: provider); Text(provider.name).font(.headline) } } }
    }
}
