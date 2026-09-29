import Foundation
import Observation
import Security

/// A rowrow server this device is paired with: where it is, and who this device is there.
/// The credential itself lives in the Keychain, never in this record.
public struct Account: Codable, Sendable, Identifiable, Equatable, Hashable {
  public let id: UUID
  public var baseURL: URL
  /// The machine's name (HostInfo.name), for telling servers apart.
  public var name: String
  /// This device's id on that server: pushes name it, so a notification finds its account.
  public var deviceId: String
  public var deviceName: String
  public let pairedAt: Date

  public init(id: UUID = UUID(), baseURL: URL, name: String, deviceId: String, deviceName: String, pairedAt: Date = Date()) {
    self.id = id
    self.baseURL = baseURL
    self.name = name
    self.deviceId = deviceId
    self.deviceName = deviceName
    self.pairedAt = pairedAt
  }
}

/// Device credentials in the Keychain, readable after the first unlock so a reply typed into
/// a notification can be sent while the phone is locked.
public enum Keychain {
  private static let service = "rowrow.device-token"

  public static func set(_ token: String, for account: UUID) {
    delete(account)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account.uuidString,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      kSecValueData as String: Data(token.utf8),
    ]
    let status = SecItemAdd(query as CFDictionary, nil)
    if status != errSecSuccess { logger.error("keychain.add_failed \(status)") }
  }

  public static func get(_ account: UUID) -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account.uuidString,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else {
      return nil
    }
    return String(data: data, encoding: .utf8)
  }

  public static func delete(_ account: UUID) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account.uuidString,
    ]
    SecItemDelete(query as CFDictionary)
  }
}

/// The servers this device is paired with, and which one the app shows.
@MainActor
@Observable
public final class Accounts {
  public private(set) var list: [Account]
  public var activeId: UUID? {
    didSet { defaults.set(activeId?.uuidString, forKey: Keys.active) }
  }

  @ObservationIgnored private let defaults: UserDefaults

  private enum Keys {
    static let list = "rowrow.accounts"
    static let active = "rowrow.activeAccount"
  }

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    let stored = defaults.data(forKey: Keys.list).flatMap { try? JSONDecoder().decode([Account].self, from: $0) } ?? []
    // An account whose credential is gone (a restored backup: ThisDeviceOnly items don't travel) can't be used.
    list = stored.filter { Keychain.get($0.id) != nil }
    activeId = defaults.string(forKey: Keys.active).flatMap(UUID.init(uuidString:)).flatMap { id in
      stored.contains { $0.id == id } ? id : nil
    } ?? list.first?.id
  }

  public var active: Account? { list.first { $0.id == activeId } ?? list.first }

  public func token(for account: Account) -> String? { Keychain.get(account.id) }

  public func account(deviceId: String) -> Account? { list.first { $0.deviceId == deviceId } }

  /// Keep a new pairing (replacing an older pairing with the same server) and show it.
  @discardableResult
  public func add(_ pairing: Pairing, serverName: String) -> Account {
    if let old = list.first(where: { $0.baseURL == pairing.baseURL }) { remove(old.id) }
    let account = Account(
      baseURL: pairing.baseURL, name: serverName, deviceId: pairing.deviceId, deviceName: pairing.deviceName)
    Keychain.set(pairing.token, for: account.id)
    list.append(account)
    persist()
    activeId = account.id
    return account
  }

  /// Rename a server as its host reports itself.
  public func update(_ id: UUID, name: String) {
    guard let index = list.firstIndex(where: { $0.id == id }), list[index].name != name else { return }
    list[index].name = name
    persist()
  }

  public func remove(_ id: UUID) {
    Keychain.delete(id)
    list.removeAll { $0.id == id }
    persist()
    if activeId == id { activeId = list.first?.id }
  }

  private func persist() {
    defaults.set(try? JSONEncoder().encode(list), forKey: Keys.list)
  }
}
