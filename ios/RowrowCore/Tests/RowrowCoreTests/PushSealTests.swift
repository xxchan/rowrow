import CryptoKit
import Foundation
import Testing

@testable import RowrowCore

@Suite struct PushSeals {
  /// Sealed by the server's sealFor (src/server/notify/apns.ts) with a key of 32 bytes of 7.
  let key = SymmetricKey(data: Data(repeating: 7, count: 32))
  let sealed =
    "EHNkKh3x4CiAtJFFcp9UZVt2BUYX4WOTwPV0FP5Ye7D1TMrQchPQIhai0wups8gXyKvWzxSU/wk7LwZs7zj/PBY3EIASy7j32uqIeL6RDIxvKXb/1HXpSjs17X0zSVi38yoilhJLGr2thTZiu7tP8XkF"

  @Test func opensWhatTheServerSealed() {
    #expect(PushSeal.base64(key) == "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=")
    #expect(
      PushSeal.open(sealed, key: key)
        == PushSeal.Words(title: "Fix rounding finished", subtitle: "acme-shop", body: "Wrote `src/cart.ts`."))
  }

  @Test func refusesAnotherKeyOrATamperedSeal() {
    #expect(PushSeal.open(sealed, key: SymmetricKey(size: .bits256)) == nil)
    var bytes = Data(base64Encoded: sealed)!
    bytes[20] ^= 1
    #expect(PushSeal.open(bytes.base64EncodedString(), key: key) == nil)
    #expect(PushSeal.open("not base64", key: key) == nil)
  }
}
