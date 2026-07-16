import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    @State private var url = ""
    @State private var key = ""
    @State private var remaining = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("https://connector.example", text: $url).textInputAutocapitalization(.never).keyboardType(.URL).autocorrectionDisabled()
                    SecureField("Optional proxy API key", text: $key)
                    Text("The phone reads usage from Railway. Provider sign-in and token sync happen only on your Mac.").font(.footnote).foregroundStyle(.secondary)
                }
                Section("Display") { Toggle("Show remaining instead of used", isOn: $remaining) }
                Section {
                    NavigationLink { NotificationSettingsView() } label: {
                        Label("Notifications", systemImage: "bell.badge")
                    }
                }
                Section("Security") { Text("Claude, Codex, Cursor, and ASC credentials are never stored in or bundled with this app.").font(.footnote) }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await model.saveSettings(url: url, key: key, remaining: remaining); dismiss() } } }
            }
            .onAppear { url = model.baseURL; key = model.apiKey; remaining = model.displayRemaining }
        }
    }
}
