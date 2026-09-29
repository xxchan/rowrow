import RowrowCore
import SwiftUI

/// One file's diff, readable on a phone: lines wrap by default (turn it off to see the layout),
/// numbered on both sides, colored by what happened to them. Tap a line to comment on it; the
/// comments become one review message (ReviewBar).
struct DiffScreen: View {
  let target: DiffTarget
  let session: Session
  @Environment(AppModel.self) private var model
  @State private var diff: FileDiff?
  @State private var lines: [DiffLine] = []
  @State private var error: String?
  @State private var wrap = true
  @State private var commenting: DiffLine?

  var body: some View {
    let comments = model.reviews.comments(on: target.path, in: target.workspaceId)
    Group {
      if let error {
        ContentUnavailableView("Couldn't show the diff", systemImage: "exclamationmark.triangle", description: Text(error))
      } else if diff == nil {
        ProgressView()
      } else if lines.isEmpty {
        ContentUnavailableView(
          "Nothing to show", systemImage: "doc",
          description: Text(diff?.patch.contains("Binary files") == true ? "A binary file changed." : "No text changes in this file."))
      } else {
        ScrollView(wrap ? .vertical : [.vertical, .horizontal]) {
          LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(lines) { line in
              DiffLineView(line: line, wrap: wrap)
                .contentShape(Rectangle())
                .onTapGesture {
                  if line.kind != .hunk, target.scope != nil { commenting = line }
                }
              ForEach(comments.filter { $0.source.line == line.number && $0.source.side == line.side }) { comment in
                CommentBubble(comment: comment) { model.reviews.remove(comment.id) }
              }
            }
            if diff?.truncated == true {
              Text("The diff is cut here: it's too long to show whole.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding()
            }
          }
          .padding(.bottom, 80)
        }
      }
    }
    .navigationTitle((target.path as NSString).lastPathComponent)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          wrap.toggle()
        } label: {
          Label(wrap ? "Don't Wrap Lines" : "Wrap Lines", systemImage: wrap ? "arrow.left.and.right.text.vertical" : "text.alignleft")
        }
      }
    }
    .safeAreaInset(edge: .bottom) {
      if target.scope != nil {
        ReviewBar(workspaceId: target.workspaceId, agentId: target.agentId, session: session)
      }
    }
    .sheet(item: $commenting) { line in
      CommentSheet(line: line) { text in
        guard let scope = target.scope else { return }
        model.reviews.add(
          ReviewComment(
            workspaceId: target.workspaceId,
            source: .diff(path: target.path, scope: scope, side: line.side, line: line.number, text: line.text),
            comment: text))
      }
    }
    .task { await load() }
  }

  private func load() async {
    do {
      let loaded =
        if let sha = target.sha {
          try await session.api.commitDiff(workspaceId: target.workspaceId, sha: sha, path: target.path)
        } else {
          try await session.api.diff(
            workspaceId: target.workspaceId, scope: target.scope ?? .working, path: target.path, agentId: target.agentId)
        }
      diff = loaded
      lines = DiffLine.parse(loaded.patch)
    } catch {
      self.error = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
    }
  }
}

/// A line of a unified diff, with its numbers before and after.
struct DiffLine: Identifiable, Equatable {
  enum Kind { case hunk, context, added, removed, note }
  let id: Int
  let kind: Kind
  let text: String
  let old: Int?
  let new: Int?

  /// The side a comment on it refers to, and its line there.
  var side: String { kind == .removed ? "old" : "new" }
  var number: Int { (kind == .removed ? old : new) ?? old ?? 0 }

  static func parse(_ patch: String) -> [DiffLine] {
    var lines: [DiffLine] = []
    var old = 0
    var new = 0
    var inHunk = false
    for raw in patch.split(separator: "\n", omittingEmptySubsequences: false) {
      let line = String(raw)
      if line.hasPrefix("@@") {
        inHunk = true
        let numbers = line.split(separator: " ")
        if numbers.count >= 3 {
          old = Int(numbers[1].dropFirst().split(separator: ",").first ?? "") ?? 0
          new = Int(numbers[2].dropFirst().split(separator: ",").first ?? "") ?? 0
        }
        lines.append(DiffLine(id: lines.count, kind: .hunk, text: line, old: nil, new: nil))
        continue
      }
      guard inHunk else { continue }
      if line.hasPrefix("+") {
        lines.append(DiffLine(id: lines.count, kind: .added, text: String(line.dropFirst()), old: nil, new: new))
        new += 1
      } else if line.hasPrefix("-") {
        lines.append(DiffLine(id: lines.count, kind: .removed, text: String(line.dropFirst()), old: old, new: nil))
        old += 1
      } else if line.hasPrefix("\\") {
        lines.append(DiffLine(id: lines.count, kind: .note, text: line, old: nil, new: nil))
      } else if line.hasPrefix(" ") || line.isEmpty {
        if line.isEmpty && raw.endIndex == patch.endIndex { continue }
        lines.append(DiffLine(id: lines.count, kind: .context, text: String(line.dropFirst()), old: old, new: new))
        old += 1
        new += 1
      } else if line.hasPrefix("diff --git") {
        inHunk = false
      }
    }
    return lines
  }
}

private struct DiffLineView: View {
  let line: DiffLine
  let wrap: Bool

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      if line.kind != .hunk {
        Text(line.old.map(String.init) ?? "")
          .frame(width: 34, alignment: .trailing)
        Text(line.new.map(String.init) ?? "")
          .frame(width: 34, alignment: .trailing)
          .padding(.trailing, 6)
      }
      Text(marker)
        .frame(width: 12, alignment: .leading)
        .foregroundStyle(markerColor)
      Text(line.text.isEmpty ? " " : line.text)
        .fixedSize(horizontal: !wrap, vertical: true)
        .frame(maxWidth: wrap ? .infinity : nil, alignment: .leading)
    }
    .font(.system(size: 12, design: .monospaced))
    .foregroundStyle(line.kind == .hunk || line.kind == .note ? Color.secondary : .primary)
    .padding(.vertical, line.kind == .hunk ? 6 : 1)
    .padding(.horizontal, 6)
    .frame(maxWidth: wrap ? .infinity : nil, alignment: .leading)
    .background(background)
  }

  private var marker: String {
    switch line.kind {
    case .added: "+"
    case .removed: "−"
    default: ""
    }
  }

  private var markerColor: Color { line.kind == .added ? .green : .red }

  private var background: Color {
    switch line.kind {
    case .added: .green.opacity(0.13)
    case .removed: .red.opacity(0.12)
    case .hunk: .blue.opacity(0.08)
    default: .clear
    }
  }
}

private struct CommentBubble: View {
  let comment: ReviewComment
  let remove: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "text.bubble.fill").foregroundStyle(.tint)
      Text(comment.comment).font(.subheadline)
      Spacer(minLength: 0)
      Button(role: .destructive, action: remove) {
        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
      }
      .buttonStyle(.borderless)
      .accessibilityLabel("Remove the comment")
    }
    .padding(10)
    .background(.tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .padding(.horizontal, 12)
    .padding(.vertical, 4)
  }
}

private struct CommentSheet: View {
  let line: DiffLine
  let save: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var text = ""
  @FocusState private var focused: Bool

  var body: some View {
    NavigationStack {
      Form {
        Section("Line \(line.number)\(line.kind == .removed ? " (before the change)" : "")") {
          Text(line.text.isEmpty ? " " : line.text).font(.footnote.monospaced())
        }
        Section("Your comment") {
          TextField("What should change here?", text: $text, axis: .vertical)
            .lineLimit(3...10)
            .focused($focused)
        }
      }
      .navigationTitle("Comment")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Add") {
            save(text.trimmingCharacters(in: .whitespacesAndNewlines))
            dismiss()
          }
          .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
      .onAppear { focused = true }
    }
    .presentationDetents([.medium])
  }
}
