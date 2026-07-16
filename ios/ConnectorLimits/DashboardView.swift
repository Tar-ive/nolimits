import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 16) {
                    ForEach(ProviderID.allCases) { provider in
                        ProviderCard(provider: provider)
                    }
                    experimentalNote
                }.padding(.horizontal, 16).padding(.vertical, 12)
            }
            .background {
                LinearGradient(colors: [Color(hex: "F4F2FA"), Color(hex: "E9F0F7"), Color(.systemBackground)], startPoint: .topLeading, endPoint: .bottomTrailing)
                    .ignoresSafeArea()
            }
            .navigationTitle("NoLimits")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { status }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise").fontWeight(.semibold) }.disabled(model.isRefreshing)
                    Button { showSettings = true } label: { Image(systemName: "gearshape").fontWeight(.semibold) }
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .alert("NoLimits", isPresented: .init(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
                Button("OK") { model.errorMessage = nil }
            } message: { Text(model.errorMessage ?? "") }
        }
    }

    private var status: some View {
        HStack(spacing: 5) {
            Circle().fill(model.connected.values.contains(true) ? .green : .secondary).frame(width: 8, height: 8)
            Text(model.isRefreshing ? "Updating" : "Live").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
        }
    }

    private var experimentalNote: some View {
        Label("Usage APIs are experimental and may change without notice.", systemImage: "exclamationmark.triangle")
            .font(.callout.weight(.medium)).foregroundStyle(.secondary).padding(.vertical, 8)
    }
}

private struct ProviderCard: View {
    @EnvironmentObject private var model: AppModel
    let provider: ProviderID

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                ProviderLogo(provider: provider, size: 24)
                Text(provider.name).font(.title3.weight(.semibold))
                Spacer()
                if model.connected[provider] == true {
                    Label("Connected", systemImage: "checkmark.circle.fill").font(.subheadline.weight(.medium)).foregroundStyle(.green)
                    NavigationLink { ProviderDetailView(provider: provider) } label: { Image(systemName: "chevron.right") }
                } else {
                    Label("Sync on Mac", systemImage: "laptopcomputer").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                }
            }
            if let snapshot = model.snapshots[provider], !snapshot.windows.isEmpty {
                ForEach(snapshot.windows.prefix(3)) { window in UsageRow(window: window) }
            } else if model.connected[provider] == true {
                Text(provider == .cursor ? "Authentication ready" : "No usage data returned").font(.body.weight(.medium)).foregroundStyle(.secondary)
            } else {
                Text("Run npm run auth:sync-mac, then refresh.").font(.body.weight(.medium)).foregroundStyle(.secondary)
            }
        }.padding(20).limitsGlass().shadow(color: .black.opacity(0.08), radius: 16, y: 7)
    }
}

struct UsageRow: View {
    @EnvironmentObject private var model: AppModel
    let window: UsageWindow
    var value: Double { model.displayRemaining ? 100 - window.usedPercent : window.usedPercent }
    var isNearLimit: Bool { model.displayRemaining ? value < 15 : value > 85 }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack { Text(window.label).font(.body.weight(.medium)); Spacer(); Text("\(Int(value.rounded()))% \(model.displayRemaining ? "left" : "used")").font(.subheadline.weight(.semibold).monospacedDigit()).contentTransition(.numericText()).foregroundStyle(isNearLimit ? .red : .primary) }
            ProgressView(value: value, total: 100).tint(isNearLimit ? .red : .blue).scaleEffect(x: 1, y: 1.35)
            if let raw = window.resetAt, let date = ISO8601DateFormatter().date(from: raw) {
                Label("Resets \(RelativeDateTimeFormatter().localizedString(for: date, relativeTo: .now))", systemImage: "arrow.clockwise")
                    .font(.caption.weight(.medium)).foregroundStyle(.secondary)
            }
        }
    }
}

private extension View {
    @ViewBuilder func limitsGlass(cornerRadius: CGFloat = 24) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
        } else {
            self.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).stroke(.white.opacity(0.55), lineWidth: 1) }
        }
    }
}
