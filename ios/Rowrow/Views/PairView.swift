import AVFoundation
import RowrowCore
import SwiftUI
import Vision
import VisionKit

/// Pairing (docs/ios.md, "Pairing"): rowrow runs on your computer; this app is a window into
/// it. On the computer, `rowrow pair` or Settings → Pair a device shows a one-time link as a QR
/// code; scan it here (or paste the link, which Universal Clipboard carries over from a Mac).
struct PairView: View {
  @Environment(AppModel.self) private var model
  @State private var scanning = false
  @State private var link = ""
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 28) {
          VStack(alignment: .leading, spacing: 12) {
            Image("AppMark")
              .resizable()
              .frame(width: 64, height: 64)
              .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            Text("Your agents, in your pocket")
              .font(.largeTitle.bold())
            Text(
              "rowrow runs Claude Code, Codex and friends on your computer. Pair this \(UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone") with it to see who needs you, answer, review what changed and start new work from anywhere."
            )
            .foregroundStyle(.secondary)
          }

          VStack(alignment: .leading, spacing: 10) {
            Step(number: 1, text: "On your computer, run **rowrow pair** in a terminal, or open rowrow and go to **Settings → Pair a device**.")
            Step(number: 2, text: "Scan the code it shows, or copy the link and paste it here.")
            Step(number: 3, text: "Away from home? Serve rowrow over **Tailscale** (tailscale serve) so this device can reach it.")
          }

          VStack(spacing: 12) {
            Button {
              scanning = true
            } label: {
              Label("Scan the pairing code", systemImage: "qrcode.viewfinder")
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
            .disabled(busy)

            PasteButton(payloadType: String.self) { strings in
              guard let first = strings.first else { return }
              link = first
              Task { await pair(first) }
            }
            .buttonBorderShape(.capsule)
            .disabled(busy)

            HStack {
              TextField("…or type the link", text: $link)
                .textContentType(.URL)
                .keyboardType(.URL)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.go)
                .onSubmit { Task { await pair(link) } }
              if !link.isEmpty {
                Button("Pair") { Task { await pair(link) } }
                  .disabled(busy)
              }
            }
            .padding(12)
            .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 12))
          }

          if busy {
            ProgressView("Pairing…")
          }
          if let error {
            Label(error, systemImage: "exclamationmark.triangle")
              .foregroundStyle(.red)
              .font(.subheadline)
          }
        }
        .padding(24)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity)
      }
      .sheet(isPresented: $scanning) {
        ScannerSheet { code in
          scanning = false
          link = code
          Task { await pair(code) }
        }
      }
    }
  }

  private func pair(_ text: String) async {
    busy = true
    error = nil
    defer { busy = false }
    do {
      try await model.pair(link: text)
      await model.push.request()
    } catch {
      self.error = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
    }
  }
}

private struct Step: View {
  let number: Int
  let text: LocalizedStringKey

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text("\(number)")
        .font(.footnote.bold())
        .frame(width: 22, height: 22)
        .background(.tint.opacity(0.15), in: Circle())
      Text(text).font(.subheadline)
    }
  }
}

/// A link that arrived from outside (`rowrow://pair?link=…`): pairing sends your messages to
/// that server, so it needs a yes.
struct ConfirmPairingView: View {
  let link: String
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 16) {
        let host = (try? APIClient.parseLink(link))?.baseURL.absoluteString
        Text("Pair with this rowrow?").font(.title2.bold())
        Text(host ?? link)
          .font(.body.monospaced())
          .padding(12)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 12))
        Text("Only pair with a computer you trust: what you send goes to its agents, which can run anything there.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
        if let error {
          Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).font(.subheadline)
        }
        Spacer()
        Button {
          Task {
            busy = true
            defer { busy = false }
            do {
              try await model.pair(link: link)
              await model.push.request()
              dismiss()
            } catch {
              self.error = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
            }
          }
        } label: {
          Text(busy ? "Pairing…" : "Pair").frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .controlSize(.large)
        .disabled(busy || host == nil)
      }
      .padding(24)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
      }
    }
    .presentationDetents([.medium])
  }
}

/// The camera, looking for a QR code with a rowrow sign-in link.
struct ScannerSheet: View {
  let found: (String) -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
          QRScanner(found: found)
            .ignoresSafeArea()
            .overlay(alignment: .bottom) {
              Text("Point at the code rowrow shows on your computer")
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .glassEffect()
                .padding(.bottom, 40)
            }
        } else {
          ContentUnavailableView(
            "No camera here",
            systemImage: "camera.metering.unknown",
            description: Text(
              AVCaptureDevice.authorizationStatus(for: .video) == .denied
                ? "Allow camera access for rowrow in Settings, or paste the link instead."
                : "Paste the link instead: `rowrow pair` prints it."))
        }
      }
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
      }
    }
  }
}

private struct QRScanner: UIViewControllerRepresentable {
  let found: (String) -> Void

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let scanner = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true)
    scanner.delegate = context.coordinator
    try? scanner.startScanning()
    return scanner
  }

  func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(found: found) }

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    let found: (String) -> Void
    private var done = false

    init(found: @escaping (String) -> Void) { self.found = found }

    func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
      for item in items {
        guard !done, case .barcode(let barcode) = item, let payload = barcode.payloadStringValue,
          (try? APIClient.parseLink(payload)) != nil
        else { continue }
        done = true
        scanner.stopScanning()
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        found(payload)
      }
    }
  }
}
