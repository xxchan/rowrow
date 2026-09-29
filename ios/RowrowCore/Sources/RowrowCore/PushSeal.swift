import CryptoKit
import Foundation
import Security

/// Notifications that only this device can read (docs/decisions.md, D-028). The app makes a
/// 256-bit key and gives it to the server when it registers for pushes; the server seals what
/// a notification says with it (AES-256-GCM) and Apple carries only "rowrow: an agent
/// finished"; the notification service extension opens it on the phone. The key lives in the
/// Keychain, in a group the app and its extension share, readable once the phone was unlocked
/// after starting (a push arrives while it's locked).
public enum PushSeal {
  private static let account = "notification-key"
  private static let service = "rowrow.push"

  /// What a sealed notification says.
  public struct Words: Codable, Sendable, Equatable {
    public let title: String
    public let subtitle: String?
    public let body: String
  }

  /// The key, made the first time (the app).
  public static func key(accessGroup: String?) -> SymmetricKey {
    if let existing = existingKey(accessGroup: accessGroup) { return existing }
    let key = SymmetricKey(size: .bits256)
    var query = baseQuery(accessGroup)
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    query[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
    let status = SecItemAdd(query as CFDictionary, nil)
    if status != errSecSuccess { logger.error("pushseal.store_failed \(status)") }
    return key
  }

  /// The key, if the app made one (the extension only reads it).
  public static func existingKey(accessGroup: String?) -> SymmetricKey? {
    var query = baseQuery(accessGroup)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data,
      data.count == 32
    else { return nil }
    return SymmetricKey(data: data)
  }

  /// The key as the server takes it (base64).
  public static func base64(_ key: SymmetricKey) -> String {
    key.withUnsafeBytes { Data($0) }.base64EncodedString()
  }

  /// Opens what the server sealed (nonce ‖ ciphertext ‖ tag, base64); nil when it can't.
  public static func open(_ sealed: String, key: SymmetricKey) -> Words? {
    guard let data = Data(base64Encoded: sealed),
      let box = try? AES.GCM.SealedBox(combined: data),
      let plain = try? AES.GCM.open(box, using: key)
    else { return nil }
    return try? JSONDecoder().decode(Words.self, from: plain)
  }

  private static func baseQuery(_ accessGroup: String?) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    if let accessGroup, !accessGroup.isEmpty { query[kSecAttrAccessGroup as String] = accessGroup }
    return query
  }
}
