import Foundation

enum APIError: LocalizedError {
    case invalidURL, transport(String), server(Int, String)
    var errorDescription: String? {
        switch self {
        case .invalidURL: "Invalid connector URL"
        case .transport(let message): message
        case .server(let code, let message): "\(message) (HTTP \(code))"
        }
    }
}

struct APIClient {
    var baseURL: URL
    var apiKey: String?
    var session: URLSession = .shared

    func status(_ provider: ProviderID) async throws -> Bool {
        let path = switch provider {
        case .anthropic: "/auth/status"
        case .codex: "/auth/codex/status"
        case .cursor: "/auth/cursor/status"
        case .antigravity: "/auth/antigravity/status"
        case .opencode: "/auth/opencode/status"
        }
        return try await request(path, as: AuthStatus.self).authenticated
    }

    func usage(_ provider: ProviderID) async throws -> UsageSnapshot {
        return try await request("/usage/\(provider.rawValue)", as: UsageSnapshot.self)
    }

    private func request<T: Decodable>(_ path: String, method: String = "GET", as: T.Type = T.self) async throws -> T {
        try await request(path, method: method, rawBody: nil)
    }

    private func request<T: Decodable, B: Encodable>(_ path: String, method: String, body: B) async throws -> T {
        try await request(path, method: method, rawBody: try JSONEncoder().encode(body))
    }

    private func request<T: Decodable>(_ path: String, method: String, rawBody: Data?) async throws -> T {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = rawBody
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let apiKey, !apiKey.isEmpty { request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization") }
        do {
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard 200..<300 ~= status else {
                let body = try? JSONDecoder().decode(APIErrorBody.self, from: data)
                throw APIError.server(status, body?.message ?? body?.error ?? "Connector request failed")
            }
            return try JSONDecoder().decode(T.self, from: data)
        } catch let error as APIError { throw error }
        catch { throw APIError.transport(error.localizedDescription) }
    }
}
