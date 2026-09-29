import RowrowCore
import SwiftUI

/// The current branch's commits, newest first, a page at a time.
struct HistoryView: View {
  let workspaceId: String
  let session: Session
  @State private var commits: [CommitSummary] = []
  @State private var next: String?
  @State private var loading = false
  @State private var note: String?
  @State private var error: String?

  var body: some View {
    List {
      if let note { Text(note).font(.footnote).foregroundStyle(.secondary) }
      if let error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
      ForEach(commits) { commit in
        NavigationLink(value: Route.commit(workspaceId: workspaceId, sha: commit.sha)) {
          VStack(alignment: .leading, spacing: 3) {
            Text(commit.subject).font(.subheadline.weight(.medium)).lineLimit(2)
            HStack(spacing: 6) {
              Text(String(commit.sha.prefix(7))).font(.caption.monospaced())
              Text(commit.authorName)
              Text(Date(millis: commit.authorDate), format: .relative(presentation: .named))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
          }
        }
      }
      if next != nil {
        Button("More") { Task { await load(more: true) } }.disabled(loading)
      }
      if loading && commits.isEmpty { ProgressView().frame(maxWidth: .infinity) }
    }
    .navigationTitle("History")
    .task { await load(more: false) }
    .refreshable { await load(more: false) }
  }

  private func load(more: Bool) async {
    loading = true
    defer { loading = false }
    do {
      let page = try await session.api.log(workspaceId: workspaceId, cursor: more ? next : nil)
      commits = more ? commits + page.commits : page.commits
      next = page.nextCursor
      note = page.note
      error = nil
    } catch is CancellationError {
    } catch {
      self.error = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
    }
  }
}

/// One commit: its message, who and when, and the files it changed.
struct CommitView: View {
  let workspaceId: String
  let sha: String
  let session: Session
  @State private var commit: CommitChanges?
  @State private var error: String?

  var body: some View {
    List {
      if let commit {
        Section {
          Text(commit.commit.message).font(.subheadline).textSelection(.enabled)
          LabeledContent("Author", value: commit.commit.authorName)
          LabeledContent("Date", value: Date(millis: commit.commit.authorDate).formatted(date: .abbreviated, time: .shortened))
          LabeledContent("Commit") { Text(commit.commit.sha.prefix(12)).font(.caption.monospaced()).textSelection(.enabled) }
        }
        Section {
          ForEach(commit.files) { file in
            NavigationLink(value: Route.diff(DiffTarget(workspaceId: workspaceId, path: file.path, scope: nil, agentId: nil, sha: sha))) {
              FileRow(file: file)
            }
          }
        } header: {
          Text("Compared with \(commit.baseLabel)")
        } footer: {
          if let note = commit.note { Text(note) }
        }
      } else if let error {
        Label(error, systemImage: "exclamationmark.triangle")
      } else {
        ProgressView().frame(maxWidth: .infinity)
      }
    }
    .navigationTitle(String(sha.prefix(7)))
    .navigationBarTitleDisplayMode(.inline)
    .task {
      do {
        commit = try await session.api.commit(workspaceId: workspaceId, sha: sha)
      } catch {
        self.error = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
      }
    }
  }
}

/// Find files by name and lines by content (git's view: tracked and untracked, .gitignore honored).
struct SearchView: View {
  let workspaceId: String
  let session: Session
  @State private var query = ""
  @State private var result: SearchResult?
  @State private var error: String?

  var body: some View {
    List {
      if let result {
        if result.names.isEmpty && result.lines.isEmpty {
          ContentUnavailableView.search(text: result.query)
        }
        if !result.names.isEmpty {
          Section("Files") {
            ForEach(result.names, id: \.path) { name in
              NavigationLink(value: Route.file(workspaceId: workspaceId, path: name.path)) {
                Text(name.path).font(.footnote.monospaced()).lineLimit(2).truncationMode(.head)
              }
            }
          }
        }
        if !result.lines.isEmpty {
          Section("Lines") {
            ForEach(result.lines, id: \.self) { line in
              NavigationLink(value: Route.file(workspaceId: workspaceId, path: line.path)) {
                VStack(alignment: .leading, spacing: 2) {
                  Text("\(line.path):\(line.line)").font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                  Text(line.text.trimmingCharacters(in: .whitespaces)).font(.footnote.monospaced()).lineLimit(3)
                }
              }
            }
          }
        }
      } else if let error {
        Label(error, systemImage: "exclamationmark.triangle")
      }
    }
    .navigationTitle("Search")
    .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "File names or text")
    .task(id: query) {
      let trimmed = query.trimmingCharacters(in: .whitespaces)
      guard !trimmed.isEmpty else {
        result = nil
        return
      }
      try? await Task.sleep(for: .milliseconds(300))
      do {
        result = try await session.api.search(workspaceId: workspaceId, query: trimmed)
        error = nil
      } catch is CancellationError {
      } catch {
        self.error = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
      }
    }
  }
}

/// A file of the checkout: Markdown rendered, anything else as text.
struct FileView: View {
  let workspaceId: String
  let path: String
  let session: Session
  @State private var file: FileText?
  @State private var error: String?
  @State private var source = false

  var body: some View {
    ScrollView(source || !isMarkdown ? [.vertical, .horizontal] : .vertical) {
      if let file {
        if isMarkdown && !source {
          MarkdownView(text: file.text).padding()
        } else {
          Text(file.text)
            .font(.system(size: 12, design: .monospaced))
            .textSelection(.enabled)
            .fixedSize(horizontal: true, vertical: false)
            .padding()
        }
        if file.truncated {
          Text("Cut at 1 MiB.").font(.caption).foregroundStyle(.secondary).padding()
        }
      } else if let error {
        Label(error, systemImage: "exclamationmark.triangle").padding()
      } else {
        ProgressView().padding()
      }
    }
    .navigationTitle((path as NSString).lastPathComponent)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if isMarkdown {
        ToolbarItem(placement: .topBarTrailing) {
          Button(source ? "Rendered" : "Source") { source.toggle() }
        }
      }
    }
    .task {
      do {
        file = try await session.api.read(workspaceId: workspaceId, path: path)
      } catch {
        self.error = (error as? RowrowError)?.errorDescription ?? error.localizedDescription
      }
    }
  }

  private var isMarkdown: Bool { path.lowercased().hasSuffix(".md") || path.lowercased().hasSuffix(".markdown") }
}
