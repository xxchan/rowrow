import RowrowCore
import SwiftUI

/// The color of a state's tone (src/shared/describe.ts): the same everywhere a state shows.
extension Color {
  static func tone(_ tone: String) -> Color {
    switch tone {
    case "error": .red
    case "success": .green
    case "accent": .accentColor
    case "warning": .orange
    default: .secondary
    }
  }
}

/// "now", "5m", "2h", "3d": how long ago, as short as a list row needs.
func ago(_ millis: Millis, now: Date = Date()) -> String {
  let seconds = max(0, Int((now.millis - millis) / 1000))
  if seconds < 45 { return "now" }
  if seconds < 3600 { return "\(Int((Double(seconds) / 60).rounded()))m" }
  if seconds < 86_400 { return "\(Int((Double(seconds) / 3600).rounded()))h" }
  return "\(Int((Double(seconds) / 86_400).rounded()))d"
}

/// A runtime's mark (its brand icon), or a symbol for runtimes without one.
struct RuntimeMark: View {
  let runtime: String
  var size: CGFloat = 20

  var body: some View {
    Group {
      switch runtime {
      case "claude", "codex", "cursor", "grok", "kimi", "opencode", "pi", "antigravity":
        Image("runtime-\(runtime)").resizable().scaledToFit()
      case "scripted":
        Image(systemName: "flask").resizable().scaledToFit().foregroundStyle(.secondary)
      default:
        Image(systemName: "cpu").resizable().scaledToFit().foregroundStyle(.secondary)
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/// An agent at a glance: its runtime's mark on a tile, with its state as a dot on the corner.
struct AgentAvatar: View {
  let runtime: String
  let words: StateWords
  var size: CGFloat = 40

  var body: some View {
    RuntimeMark(runtime: runtime, size: size * 0.55)
      .frame(width: size, height: size)
      .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
      .overlay(alignment: .bottomTrailing) {
        StatusDot(words: words, size: size * 0.3)
          .offset(x: size * 0.08, y: size * 0.08)
      }
      .accessibilityElement()
      .accessibilityLabel(words.label)
  }
}

struct StatusDot: View {
  let words: StateWords
  var size: CGFloat = 10

  var body: some View {
    Circle()
      .fill(Color.tone(words.tone))
      .frame(width: size, height: size)
      .overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: size * 0.22))
      .phaseAnimator(words.pulsing ? [1.0, 0.45] : [1.0]) { dot, opacity in
        dot.opacity(opacity)
      } animation: { _ in .easeInOut(duration: 0.9) }
  }
}

/// A short capsule for a count or a state.
struct Pill: View {
  let text: String
  var color: Color = .secondary

  var body: some View {
    Text(text)
      .font(.caption.weight(.semibold))
      .monospacedDigit()
      .padding(.horizontal, 7)
      .padding(.vertical, 2)
      .foregroundStyle(color)
      .background(color.opacity(0.14), in: Capsule())
  }
}

/// Runs an action that talks to the server, and shows what went wrong if it did.
@MainActor
@Observable
final class Failure {
  var message: String?

  func run(_ what: String, _ action: () async throws -> Void) async {
    do {
      try await action()
    } catch is CancellationError {
    } catch {
      message = "\(what): \((error as? RowrowError)?.errorDescription ?? error.localizedDescription)"
    }
  }
}

extension View {
  /// An alert for a failed action.
  func failureAlert(_ failure: Failure) -> some View {
    alert(
      "Something went wrong",
      isPresented: Binding(get: { failure.message != nil }, set: { if !$0 { failure.message = nil } }),
      actions: { Button("OK", role: .cancel) {} },
      message: { Text(failure.message ?? "") })
  }
}
