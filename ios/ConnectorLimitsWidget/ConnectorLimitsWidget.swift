import AppIntents
import SwiftUI
import WidgetKit

enum WidgetProviderChoice: String, AppEnum {
    case anthropic, codex, cursor, antigravity, opencode

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Provider")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .anthropic: "Claude",
        .codex: "Codex",
        .cursor: "Cursor",
        .antigravity: "Antigravity",
        .opencode: "OpenCode Go",
    ]

    var id: ProviderID { ProviderID(rawValue: rawValue)! }
}

struct ProviderWidgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Provider Limits"
    static var description = IntentDescription("Choose the provider shown in the widget.")

    @Parameter(title: "Provider", default: .cursor)
    var provider: WidgetProviderChoice
}

struct LimitsEntry: TimelineEntry {
    let date: Date
    let snapshots: [ProviderID: UsageSnapshot]
    var selectedProvider: ProviderID? = nil
}

private enum WidgetData {
    static let defaultURL = "https://cursor-claude-connector-production-1515.up.railway.app"

    static var client: APIClient {
        let saved = KeychainStore.read("baseURL")
        let url = URL(string: saved.isEmpty ? defaultURL : saved)!
        return APIClient(baseURL: url, apiKey: KeychainStore.read("apiKey"))
    }

    static func load(_ providers: [ProviderID]) async -> [ProviderID: UsageSnapshot] {
        var snapshots: [ProviderID: UsageSnapshot] = [:]
        for provider in providers { snapshots[provider] = try? await client.usage(provider) }
        return snapshots
    }

    static func sample(_ provider: ProviderID) -> UsageSnapshot {
        let windows: [UsageWindow] = switch provider {
        case .anthropic: [.init(label: "Session", usedPercent: 76, resetAt: nil, windowSeconds: nil, kind: "session"),
                          .init(label: "Weekly", usedPercent: 44, resetAt: nil, windowSeconds: nil, kind: "weekly")]
        case .codex: [.init(label: "Session", usedPercent: 58, resetAt: nil, windowSeconds: nil, kind: "session"),
                      .init(label: "Weekly", usedPercent: 31, resetAt: nil, windowSeconds: nil, kind: "weekly")]
        case .cursor: [.init(label: "Auto model", usedPercent: 21, resetAt: nil, windowSeconds: nil, kind: "monthly"),
                       .init(label: "Included total", usedPercent: 67, resetAt: nil, windowSeconds: nil, kind: "monthly")]
        case .antigravity: [.init(label: "Gemini 3.1 Pro", usedPercent: 22, resetAt: nil, windowSeconds: nil, kind: "weeklyScoped"),
                            .init(label: "Gemini 3 Flash", usedPercent: 8, resetAt: nil, windowSeconds: nil, kind: "weeklyScoped")]
        case .opencode: [.init(label: "5 hour", usedPercent: 15, resetAt: nil, windowSeconds: nil, kind: "session"),
                         .init(label: "Weekly", usedPercent: 41, resetAt: nil, windowSeconds: nil, kind: "weekly")]
        }
        return .init(providerId: provider, windows: windows, lastUpdated: "", accountLabel: nil, credits: nil, experimental: true)
    }
}

struct ProviderTimeline: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> LimitsEntry {
        .init(date: .now, snapshots: [.cursor: WidgetData.sample(.cursor)], selectedProvider: .cursor)
    }

    func snapshot(for configuration: ProviderWidgetIntent, in context: Context) async -> LimitsEntry {
        let provider = configuration.provider.id
        return .init(date: .now, snapshots: [provider: WidgetData.sample(provider)], selectedProvider: provider)
    }

    func timeline(for configuration: ProviderWidgetIntent, in context: Context) async -> Timeline<LimitsEntry> {
        let provider = configuration.provider.id
        let entry = LimitsEntry(date: .now, snapshots: await WidgetData.load([provider]), selectedProvider: provider)
        return Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60)))
    }
}

struct OverviewTimeline: TimelineProvider {
    func placeholder(in context: Context) -> LimitsEntry { sample() }
    func getSnapshot(in context: Context, completion: @escaping (LimitsEntry) -> Void) { completion(sample()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<LimitsEntry>) -> Void) {
        Task {
            let entry = LimitsEntry(date: .now, snapshots: await WidgetData.load(ProviderID.allCases))
            completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60))))
        }
    }

    private func sample() -> LimitsEntry {
        .init(date: .now, snapshots: Dictionary(uniqueKeysWithValues: ProviderID.allCases.map { ($0, WidgetData.sample($0)) }))
    }
}

private struct WidgetBackground: View {
    var body: some View {
        LinearGradient(colors: [Color(red: 0.16, green: 0.16, blue: 0.17), .black], startPoint: .top, endPoint: .bottom)
    }
}

private struct ProviderWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: LimitsEntry
    let provider: ProviderID

    private var snapshot: UsageSnapshot? { entry.snapshots[provider] }
    private var windows: [UsageWindow] {
        guard let snapshot else { return [] }
        if provider == .cursor {
            let order = ["Auto model", "Included total", "API models"]
            return order.compactMap { label in snapshot.windows.first { $0.label == label } }
        }
        return Array(snapshot.windows.prefix(family == .systemSmall ? 2 : 3))
    }

    private var firstWindow: UsageWindow? { windows.first }
    private var remaining: Double { max(0, 100 - (firstWindow?.usedPercent ?? 100)) }

    @ViewBuilder
    var body: some View {
        switch family {
        case .accessoryInline:
            Text("NoLimits · \(provider.name) \(Int(remaining.rounded()))% left")
                .containerBackground(for: .widget) { Color.clear }
        case .accessoryCircular:
            LockLimitCircular(provider: provider, window: firstWindow).widgetAccentable()
            .containerBackground(for: .widget) { Color.clear }
        case .accessoryRectangular:
            LockLimitRectangular(provider: provider, window: firstWindow).widgetAccentable()
            .containerBackground(for: .widget) { Color.clear }
        default:
            homeContent
        }
    }

    private var homeContent: some View {
        VStack(alignment: .leading, spacing: family == .systemSmall ? 8 : 10) {
            HStack(spacing: 6) { ProviderLogo(provider: provider, size: 14, tint: homeLogoTint); Text(provider.name) }
                .font(.caption.weight(.semibold)).foregroundStyle(.white)
            if windows.isEmpty {
                Spacer()
                Text("Open NoLimits to refresh").font(.caption2).foregroundStyle(.secondary)
                Spacer()
            } else if provider == .codex && family == .systemSmall {
                HStack(spacing: 12) { ForEach(windows) { Ring(window: $0) } }
            } else {
                ForEach(windows) { LimitBar(window: $0) }
            }
        }
        .containerBackground(for: .widget) { WidgetBackground() }
        .widgetURL(URL(string: "nolimits://limits"))
    }

    private var homeLogoTint: Color? {
        [.codex, .cursor].contains(provider) ? .white : nil
    }

}

private struct OverviewWidgetView: View {
    let entry: LimitsEntry

    var body: some View {
        HStack(spacing: 5) {
            ForEach(ProviderID.allCases) { provider in
                Ring(window: preferred(provider), provider: provider)
            }
        }
        .containerBackground(for: .widget) { WidgetBackground() }
        .widgetURL(URL(string: "nolimits://limits"))
    }

    private func preferred(_ provider: ProviderID) -> UsageWindow? {
        let windows = entry.snapshots[provider]?.windows ?? []
        if provider == .cursor { return windows.first { $0.label == "Auto model" } ?? windows.first }
        return windows.first
    }
}

private struct LimitBar: View {
    let window: UsageWindow
    private var remaining: Double { max(0, 100 - window.usedPercent) }

    var body: some View {
        VStack(spacing: 3) {
            HStack {
                Text(window.label).lineLimit(1)
                Spacer()
                Text("\(Int(remaining.rounded()))% left").monospacedDigit()
            }.font(.caption2).foregroundStyle(.white)
            ProgressView(value: remaining, total: 100).tint(remaining < 15 ? .red : .blue)
            if let resetText {
                Label("Resets \(resetText)", systemImage: "arrow.clockwise")
                    .font(.system(size: 8)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var resetText: String? {
        guard let raw = window.resetAt,
              let date = ISO8601DateFormatter().date(from: raw) else { return nil }
        return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: .now)
    }
}

private struct Ring: View {
    let window: UsageWindow?
    var provider: ProviderID?
    private var remaining: Double { max(0, 100 - (window?.usedPercent ?? 100)) }

    init(window: UsageWindow?, provider: ProviderID? = nil) {
        self.window = window
        self.provider = provider
    }

    var body: some View {
        VStack(spacing: 5) {
            ZStack {
                Circle().stroke(.white.opacity(0.15), lineWidth: 5)
                Circle().trim(from: 0, to: remaining / 100)
                    .stroke(remaining < 15 ? .red : .blue, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(Int(remaining.rounded()))").font(.headline.monospacedDigit()).foregroundStyle(.white)
            }.frame(width: 50, height: 50)
            if let provider {
                ProviderLogo(provider: provider, size: 14, tint: [.codex, .cursor].contains(provider) ? .white : nil)
            }
            Text(shortLabel).font(.caption2.weight(.medium)).foregroundStyle(.secondary).lineLimit(1)
        }.frame(maxWidth: .infinity)
    }

    private var shortLabel: String {
        guard let provider else { return window?.label ?? "Unavailable" }
        switch provider {
        case .anthropic: return "5-hour"
        case .codex: return window?.label.lowercased().contains("week") == true ? "Weekly" : "5-hour"
        case .cursor: return "Auto"
        case .antigravity: return "3.1 Pro"
        case .opencode: return "Go 5-hour"
        }
    }
}

struct ProviderLimitsWidget: Widget {
    let kind = "NoLimitsProviderWidget"
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: ProviderWidgetIntent.self, provider: ProviderTimeline()) { entry in
            ProviderWidgetView(entry: entry, provider: entry.selectedProvider ?? .cursor)
        }
        .configurationDisplayName("NoLimits Provider")
        .description("Your AI provider limits at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryInline, .accessoryCircular, .accessoryRectangular])
    }
}

struct LimitsOverviewWidget: Widget {
    let kind = "NoLimitsOverviewWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: OverviewTimeline()) { entry in OverviewWidgetView(entry: entry) }
            .configurationDisplayName("NoLimits Overview")
            .description("Remaining usage across all five providers.")
            .supportedFamilies([.systemMedium])
    }
}

@main
struct NoLimitsWidgetBundle: WidgetBundle {
    var body: some Widget { ProviderLimitsWidget(); LimitsOverviewWidget() }
}
