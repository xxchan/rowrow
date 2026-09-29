import Foundation
import Observation
import RowrowCore

/// Review comments you're collecting (on diff lines, or on what an agent wrote), per
/// workspace, until they become one "Review feedback" message in an agent's composer. Kept on
/// this device, so they survive the app being closed; gone once they're in a composer.
@MainActor
@Observable
final class ReviewStore {
  private(set) var comments: [ReviewComment] = []
  @ObservationIgnored private let key = "rowrow.reviewComments"

  init() {
    if let data = UserDefaults.standard.data(forKey: key),
      let stored = try? JSONDecoder().decode([ReviewComment].self, from: data)
    {
      comments = stored
    }
  }

  func comments(in workspaceId: String) -> [ReviewComment] {
    comments.filter { $0.workspaceId == workspaceId }
  }

  func comments(on path: String, in workspaceId: String) -> [ReviewComment] {
    comments.filter { $0.workspaceId == workspaceId && $0.source.path == path }
  }

  func add(_ comment: ReviewComment) {
    comments.append(comment)
    save()
  }

  func remove(_ id: String) {
    comments.removeAll { $0.id == id }
    save()
  }

  func remove(in workspaceId: String) {
    comments.removeAll { $0.workspaceId == workspaceId }
    save()
  }

  private func save() {
    UserDefaults.standard.set(try? JSONEncoder().encode(comments), forKey: key)
  }
}
