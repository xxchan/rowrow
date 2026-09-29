import CoreImage.CIFilterBuiltins
import RowrowCore
import SwiftUI
import UserNotifications

/// Settings: the server this app shows, notifications on this device, quick replies (on every
/// device), your other devices, and the agents installed on the computer.
struct SettingsView: View {
  let session: Session
  @Environment(AppModel.self) private var model
  @State private var confirmingSignOut = false
  @State private var testResult: String?
  @State private var failure = Failure()

  var body: some View {
    let state = session.state
    Form {
      Section("Server") {
        LabeledContent("Computer", value: state?.host.name ?? session.account.name)
        LabeledContent("Address") {
          Text(session.account.baseURL.absoluteString).font(.caption.monospaced()).textSelection(.enabled)
        }
        LabeledContent("Status") {
          let (text, icon, color): (String, String, Color) =
            switch session.status {
            case .online: ("Connected", "checkmark.circle.fill", .green)
            case .connecting: ("Connecting…", "antenna.radiowaves.left.and.right", .secondary)
            case .offline: ("Offline", "wifi.slash", .orange)
            case .signedOut: ("Signed out", "person.crop.circle.badge.xmark", .red)
            }
          ValueWithIcon(text: text, icon: icon, color: color)
        }
        if let version = state?.host.version { LabeledContent("rowrow", value: version) }
        if let update = state?.host.update {
          UpdateNote(update: update, host: state?.host.name ?? "your computer")
        }
        NavigationLink(value: Route.servers) {
          LabeledContent("Servers", value: "\(model.accounts.list.count)")
        }
      }

      Section {
        notificationRows(state: state)
      } header: {
        Text("Notifications")
      } footer: {
        Text("You're told when an agent finishes or needs you, unless you're looking at it. Reply or mark it seen right from the notification.")
      }

      Section("On every device") {
        NavigationLink(value: Route.quickReplies) {
          LabeledContent("Quick replies", value: "\(state?.settings.quickReplies.count ?? 0)")
        }
      }

      Section {
        NavigationLink(value: Route.devices) {
          Label("Devices", systemImage: "laptopcomputer.and.iphone")
        }
      }

      if let state {
        Section("Agents on \(state.host.name)") {
          ForEach(state.runtimes.values.sorted { $0.name < $1.name }) { runtime in
            HStack {
              RuntimeMark(runtime: runtime.id, size: 20)
              Text(runtime.name)
              Spacer()
              Text(runtime.installed ? (runtime.version ?? "installed") : (runtime.reason ?? "not installed"))
                .font(.caption)
                .foregroundStyle(runtime.installed ? Color.secondary : Color.orange)
                .lineLimit(1)
            }
          }
        }
      }

      Section {
        Button("Sign Out of \(session.account.name)", role: .destructive) { confirmingSignOut = true }
      } footer: {
        Text("rowrow \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") for iOS")
      }
    }
    .navigationTitle("Settings")
    .confirmationDialog("Sign out of \(session.account.name)?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
      Button("Sign Out", role: .destructive) { Task { await model.signOut() } }
    } message: {
      Text("This device's credential stops working. Pair again to come back.")
    }
    .failureAlert(failure)
    .onAppear {
      session.show(route: "/settings", agent: nil)
      model.push.refresh()
    }
  }

  @ViewBuilder
  private func notificationRows(state: AppState?) -> some View {
    let push = model.push
    switch push.authorization {
    case .notDetermined:
      Button("Allow Notifications") { Task { await push.request() } }
    case .denied:
      Label("Notifications are off for rowrow", systemImage: "bell.slash")
      Button("Open iOS Settings") {
        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
      }
    default:
      if state?.host.apns == false {
        VStack(alignment: .leading, spacing: 6) {
          Label("\(state?.host.name ?? "The computer") can't push to this app yet", systemImage: "exclamationmark.bubble")
            .font(.subheadline.weight(.medium))
          Text("Apple only takes pushes for an app from its developer. Give rowrow your APNs key once, on the computer:")
            .font(.footnote)
            .foregroundStyle(.secondary)
          Text("rowrow push apns AuthKey_ID.p8 --key-id ID --team-id TEAM")
            .font(.caption.monospaced())
            .textSelection(.enabled)
          Text("Pushes go through Apple, which sees only that an agent finished or needs you: what they say is encrypted for this device. Until then you get a banner while the app is open.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
      } else {
        LabeledContent("This device") {
          if push.registered {
            ValueWithIcon(text: "On", icon: "checkmark.circle.fill", color: .green)
          } else if let problem = push.problem {
            Text(problem).font(.caption).foregroundStyle(.orange)
          } else {
            Text("Registering…")
          }
        }
        Button("Send a Test") {
          Task {
            await failure.run("Send a test") {
              let sent = try await session.api.testPush()
              testResult = sent > 0 ? "Sent: it should arrive in a moment." : "Nothing was sent: this device isn't registered yet."
            }
          }
        }
        if let testResult { Text(testResult).font(.footnote).foregroundStyle(.secondary) }
      }
    }
  }
}

/// Replies you send often: one tap puts one in the composer, ready to edit or send. Kept on the
/// server, so every device has the same ones.
struct QuickRepliesView: View {
  let session: Session
  @State private var replies: [String] = []
  @State private var adding = ""
  @State private var failure = Failure()
  @State private var loaded = false

  var body: some View {
    List {
      Section {
        ForEach(replies, id: \.self) { reply in Text(reply) }
          .onDelete { replies.remove(atOffsets: $0); save() }
          .onMove { replies.move(fromOffsets: $0, toOffset: $1); save() }
      } footer: {
        Text("A tap on one fills the composer; it's never sent by itself.")
      }
      Section {
        HStack {
          TextField("A new quick reply", text: $adding, axis: .vertical)
          Button("Add") {
            let reply = adding.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !reply.isEmpty, !replies.contains(reply) else { return }
            replies.append(reply)
            adding = ""
            save()
          }
          .disabled(adding.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || replies.count >= 24)
        }
      }
    }
    .navigationTitle("Quick Replies")
    .toolbar { EditButton() }
    .onAppear {
      guard !loaded else { return }
      loaded = true
      replies = session.state?.settings.quickReplies ?? []
    }
    .failureAlert(failure)
  }

  private func save() {
    let replies = replies
    Task { await failure.run("Save") { _ = try await session.api.updateSettings(quickReplies: replies) } }
  }
}

/// Everything signed in to this server, and pairing another.
struct DevicesView: View {
  let session: Session
  @State private var devices: [Device] = []
  @State private var link: LoginLink?
  @State private var failure = Failure()

  var body: some View {
    List {
      Section {
        ForEach(devices) { device in
          HStack(spacing: 12) {
            Image(systemName: device.kind == .app ? "iphone" : device.kind == .cli ? "terminal" : "safari")
              .frame(width: 24)
              .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
              Text(device.name + (device.current ? " (this one)" : ""))
              Text(device.lastSeenAt.map { "Seen \(Date(millis: $0).formatted(.relative(presentation: .named)))" } ?? "Never used")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            if device.push { Image(systemName: "bell.fill").font(.caption).foregroundStyle(.secondary) }
          }
          .swipeActions {
            if !device.current {
              Button("Sign Out", role: .destructive) {
                Task {
                  await failure.run("Sign out \(device.name)") {
                    try await session.api.revoke(deviceId: device.id)
                    await load()
                  }
                }
              }
            }
          }
        }
      } footer: {
        Text("Swipe to sign a device out: its credential stops working at once.")
      }
      Section {
        Button {
          Task { await failure.run("Pair a device") { link = try await session.api.pair(name: nil) } }
        } label: {
          Label("Pair a Device", systemImage: "qrcode")
        }
      } footer: {
        Text("Shows a one-time sign-in link as a QR code, for another phone, a tablet or a browser. Anyone who signs in can run commands on the computer through its agents.")
      }
    }
    .navigationTitle("Devices")
    .task { await load() }
    .refreshable { await load() }
    .sheet(item: Binding(get: { link.map { IdentifiedLink(link: $0) } }, set: { link = $0?.link })) { item in
      PairingCodeSheet(link: item.link)
    }
    .failureAlert(failure)
  }

  private struct IdentifiedLink: Identifiable {
    let link: LoginLink
    var id: String { link.url }
  }

  private func load() async {
    await failure.run("Load the devices") { devices = try await session.api.devices() }
  }
}

/// A sign-in link as a QR code, to scan with another device.
private struct PairingCodeSheet: View {
  let link: LoginLink
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      VStack(spacing: 20) {
        if let image = qr(link.url) {
          Image(uiImage: image)
            .interpolation(.none)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: 280)
            .padding(16)
            .background(.white, in: RoundedRectangle(cornerRadius: 16))
        }
        Text("Scan with the other device's camera (a browser signs in) or with the rowrow app. It works once, until \(Date(millis: link.expiresAt).formatted(date: .omitted, time: .shortened)).")
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
        ShareLink(item: link.url) { Label("Share the Link", systemImage: "square.and.arrow.up") }
      }
      .padding(24)
      .navigationTitle("Pair a Device")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
  }

  private func qr(_ text: String) -> UIImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
      let cg = CIContext().createCGImage(output, from: output.extent)
    else { return nil }
    return UIImage(cgImage: cg)
  }
}

/// The rowrow servers this device is paired with: switch, add, forget.
struct ServersView: View {
  @Environment(AppModel.self) private var model
  @State private var adding = false

  var body: some View {
    List {
      Section {
        ForEach(model.accounts.list) { account in
          Button {
            model.activate(account)
          } label: {
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text(account.name).foregroundStyle(.primary)
                Text(account.baseURL.absoluteString).font(.caption.monospaced()).foregroundStyle(.secondary)
              }
              Spacer()
              if account.id == model.session?.account.id { Image(systemName: "checkmark").foregroundStyle(.tint) }
            }
          }
        }
      } footer: {
        Text("The app shows one computer at a time; notifications come from all of them.")
      }
      Section {
        Button {
          adding = true
        } label: {
          Label("Pair Another Computer", systemImage: "plus")
        }
      }
    }
    .navigationTitle("Servers")
    .sheet(isPresented: $adding) { PairView() }
  }
}

/// A value with an icon, for the right side of a row (a Label there upsets the row's layout).
private struct ValueWithIcon: View {
  let text: String
  let icon: String
  let color: Color

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: icon)
      Text(text)
    }
    .foregroundStyle(color)
  }
}
