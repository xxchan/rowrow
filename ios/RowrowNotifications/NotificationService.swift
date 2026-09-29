import RowrowCore
import UserNotifications

/// Shows what a notification says, on the phone only (docs/decisions.md, D-028): the server
/// sends Apple a generic alert and the words sealed with this device's key, and this opens
/// them. When it can't (no key yet, a key from an older install), the generic alert shows.
final class NotificationService: UNNotificationServiceExtension {
  override func didReceive(
    _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
    let group = Bundle.main.object(forInfoDictionaryKey: "RowrowKeychainGroup") as? String
    if let sealed = request.content.userInfo["e"] as? String,
      let key = PushSeal.existingKey(accessGroup: group),
      let words = PushSeal.open(sealed, key: key)
    {
      content.title = words.title
      content.subtitle = words.subtitle ?? ""
      content.body = words.body
    }
    contentHandler(content)
  }
}
