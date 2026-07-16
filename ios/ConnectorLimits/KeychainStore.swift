import Foundation
import Security

enum KeychainStore {
    private static let service = "com.tarive.nolimits"
    private static let accessGroup = "KJH66PARX6.com.tarive.nolimits.shared"

    static func read(_ key: String) -> String {
        if let value = read(base(key, accessGroup: accessGroup)) {
            return String(data: value, encoding: .utf8) ?? ""
        }
        guard Bundle.main.bundleIdentifier == service,
              let legacy = read(base(key, accessGroup: nil)) else { return "" }
        write(String(data: legacy, encoding: .utf8) ?? "", key: key)
        return String(data: legacy, encoding: .utf8) ?? ""
    }

    private static func read(_ base: [String: Any]) -> Data? {
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return data
    }

    static func write(_ value: String, key: String) {
        let item = base(key, accessGroup: accessGroup)
        SecItemDelete(item as CFDictionary)
        guard !value.isEmpty else { return }
        var query = item
        query[kSecValueData as String] = Data(value.utf8)
        SecItemAdd(query as CFDictionary, nil)
    }

    private static func base(_ key: String, accessGroup: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
}
