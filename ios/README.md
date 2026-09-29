# rowrow for iOS

The native app: see [docs/ios.md](../docs/ios.md) for what it does, how it's built and why.

- `Rowrow/`: the app (SwiftUI).
- `RowrowNotifications/`: the notification service extension (opens sealed pushes, D-028).
- `RowrowCore/`: everything that isn't a view, a Swift package: `pnpm ios:test` from the
  repository root runs its tests, including against a real server from this checkout.
- `Config/`: build settings, Info.plist keys, entitlements. Put your team and bundle id in
  `Config/Local.xcconfig` (copy `Local.xcconfig.example`) to run on your iPhone.

Icons (the app's, and each runtime's mark from oar) are generated: `node scripts/icons.ts`.
