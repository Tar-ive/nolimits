import SwiftUI

enum ProviderID: String, CaseIterable, Codable, Identifiable {
    case anthropic, codex, cursor, antigravity, opencode
    var id: String { rawValue }
    var name: String { switch self { case .anthropic: "Claude"; case .codex: "Codex"; case .cursor: "Cursor"; case .antigravity: "Antigravity"; case .opencode: "OpenCode Go" } }
    var logoAsset: String { switch self { case .anthropic: "LogoClaude"; case .codex: "LogoOpenAI"; case .cursor: "LogoCursor"; case .antigravity: "LogoGemini"; case .opencode: "LogoOpenCode" } }
    var tint: String { switch self { case .anthropic: "D97757"; case .codex: "111111"; case .cursor: "5965F2"; case .antigravity: "8E75B2"; case .opencode: "57534E" } }
}

struct AuthStatus: Decodable { let authenticated: Bool }

struct UsageWindow: Codable, Identifiable, Equatable {
    let label: String
    let usedPercent: Double
    let resetAt: String?
    let windowSeconds: Int?
    let kind: String
    var id: String { "\(label)-\(kind)" }
}

struct ResetCredit: Codable, Identifiable, Equatable {
    let available: Double
    let expiresAt: String?
    var id: String { "\(available)-\(expiresAt ?? "")" }
}

struct RateLimitStatus: Codable, Equatable { let allowed: Bool; let limitReached: Bool }
struct ResetCreditSummary: Codable, Equatable { let availableCount: Int }

struct UsageSnapshot: Codable, Equatable {
    let providerId: ProviderID
    let windows: [UsageWindow]
    let lastUpdated: String
    let accountLabel: String?
    let credits: [ResetCredit]?
    let rateLimitStatus: RateLimitStatus?
    let resetCredits: ResetCreditSummary?
    let experimental: Bool

    init(providerId: ProviderID, windows: [UsageWindow], lastUpdated: String, accountLabel: String?, credits: [ResetCredit]?, rateLimitStatus: RateLimitStatus? = nil, resetCredits: ResetCreditSummary? = nil, experimental: Bool) {
        self.providerId = providerId
        self.windows = windows
        self.lastUpdated = lastUpdated
        self.accountLabel = accountLabel
        self.credits = credits
        self.rateLimitStatus = rateLimitStatus
        self.resetCredits = resetCredits
        self.experimental = experimental
    }
}

struct APIErrorBody: Decodable { let error: String?; let message: String? }

struct ProviderLogo: View {
    let provider: ProviderID
    var size: CGFloat = 22
    var tint: Color? = nil
    var body: some View {
        let image = Image(provider.logoAsset).resizable()
        if provider == .opencode {
            image.renderingMode(.original).scaledToFit().frame(width: size, height: size)
        } else {
            image.renderingMode(.template).scaledToFit().foregroundStyle(tint ?? Color(hex: provider.tint))
                .frame(width: size, height: size)
        }
    }
}

extension Color {
    init(hex: String) {
        self.init(red: Double(Int(hex.prefix(2), radix: 16) ?? 0) / 255,
                  green: Double(Int(hex.dropFirst(2).prefix(2), radix: 16) ?? 0) / 255,
                  blue: Double(Int(hex.dropFirst(4).prefix(2), radix: 16) ?? 0) / 255)
    }
}

struct LockLimitCircular: View {
    let provider: ProviderID
    let window: UsageWindow?
    private var remaining: Double { max(0, 100 - (window?.usedPercent ?? 100)) }

    var body: some View {
        ZStack {
            Circle().stroke(.primary.opacity(0.18), lineWidth: 5)
            Circle().trim(from: 0, to: remaining / 100)
                .stroke(.primary, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            VStack(spacing: 0) {
                ProviderLogo(provider: provider, size: 11, tint: .primary)
                Text("\(Int(remaining.rounded()))").font(.caption.weight(.bold).monospacedDigit())
            }
        }.frame(width: 54, height: 54)
    }
}

struct LockLimitRectangular: View {
    let provider: ProviderID
    let window: UsageWindow?
    private var remaining: Double { max(0, 100 - (window?.usedPercent ?? 100)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                ProviderLogo(provider: provider, size: 12, tint: .primary)
                Text(provider.name).font(.caption.weight(.semibold))
                Spacer()
                Text("\(Int(remaining.rounded()))% left").font(.caption.weight(.bold).monospacedDigit())
            }
            Text(window?.label ?? "Usage unavailable").font(.caption2).lineLimit(1)
            ProgressView(value: remaining, total: 100)
            if let raw = window?.resetAt, let date = ISO8601DateFormatter().date(from: raw) {
                Text("Resets \(RelativeDateTimeFormatter().localizedString(for: date, relativeTo: .now))")
                    .font(.system(size: 9, weight: .medium)).foregroundStyle(.secondary)
            }
        }
    }
}
