import ImageIO
import PhotosUI
import QuickLook
import RowrowCore
import SwiftUI
import UniformTypeIdentifiers

/// A file on its way into a message (D-024): uploaded the moment it's picked, waiting as a tile
/// until the message goes. In memory only, like drafts.
struct PendingAttachment: Identifiable, Equatable {
  enum State: Equatable {
    case uploading
    case ready(Attachment)
    case failed(String)
  }
  let id = UUID()
  let name: String
  /// A picked image, shown as itself (a thumbnail, made while it uploads).
  var preview: UIImage?
  var state: State = .uploading

  static func == (a: PendingAttachment, b: PendingAttachment) -> Bool {
    a.id == b.id && a.state == b.state && a.preview === b.preview
  }
}

extension AppModel {
  /// Upload `data` as an attachment of `key`'s next message (an agent's id, or a new-agent form's).
  func attach(_ data: Data, name: String, type: String, to key: String, session: Session) {
    let pending = PendingAttachment(name: name)
    attachments[key, default: []].append(pending)
    if type.hasPrefix("image/") {
      Task {
        guard let preview = await thumbnail(data) else { return }
        update(pending.id, in: key) { $0.preview = preview }
      }
    }
    Task {
      let state: PendingAttachment.State
      do {
        state = .ready(try await session.api.upload(data, filename: name, type: type))
      } catch {
        state = .failed((error as? RowrowError)?.errorDescription ?? error.localizedDescription)
      }
      update(pending.id, in: key) { $0.state = state }
    }
  }

  private func update(_ id: UUID, in key: String, _ change: (inout PendingAttachment) -> Void) {
    guard var files = attachments[key], let index = files.firstIndex(where: { $0.id == id }) else { return }
    change(&files[index])
    attachments[key] = files
  }

  /// A file that couldn't be read: a tile that says so, until you take it back.
  func attachFailed(_ name: String, because reason: String, to key: String) {
    attachments[key, default: []].append(PendingAttachment(name: name, preview: nil, state: .failed(reason)))
  }

  func detach(_ id: UUID, from key: String) {
    attachments[key]?.removeAll { $0.id == id }
  }

  /// What the message can carry now, or why it can't go yet.
  func readyAttachments(_ key: String) -> Result<[Attachment], AttachmentProblem> {
    let files = attachments[key] ?? []
    if files.contains(where: { if case .failed = $0.state { true } else { false } }) {
      return .failure(AttachmentProblem(message: "Remove the files that didn't upload."))
    }
    if files.contains(where: { $0.state == .uploading }) {
      return .failure(AttachmentProblem(message: "Wait for the files to finish uploading."))
    }
    return .success(files.compactMap { if case .ready(let file) = $0.state { file } else { nil } })
  }
}

struct AttachmentProblem: Error {
  let message: String
}

/// Adding files to a message, the way iOS does it (Messages' +, Notes' and Mail's attach
/// menus): one button beside the text that offers the photo library, the camera and Files.
/// What you pick uploads at once and waits as a tile (PendingTiles) until the message goes.
struct AttachButton<Extra: View>: View {
  /// Whose next message the files go with: an agent's id, or a new-agent form's key.
  let key: String
  let session: Session
  /// More items for the menu (the composer adds its commands).
  @ViewBuilder var extra: () -> Extra

  @Environment(AppModel.self) private var model
  @State private var photos: [PhotosPickerItem] = []
  @State private var choosingPhotos = false
  @State private var choosingFiles = false
  @State private var takingPhoto = false

  var body: some View {
    Menu {
      Section {
        Button {
          choosingPhotos = true
        } label: {
          Label("Photo Library", systemImage: "photo.on.rectangle")
        }
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
          Button {
            takingPhoto = true
          } label: {
            Label("Take Photo", systemImage: "camera")
          }
        }
        Button {
          choosingFiles = true
        } label: {
          Label("Choose Files", systemImage: "folder")
        }
      }
      extra()
    } label: {
      Image(systemName: "plus")
        .font(.system(size: 17, weight: .semibold))
        .frame(width: 34, height: 34)
        .contentShape(Rectangle())
    }
    .accessibilityLabel("Add photos or files")
    .photosPicker(
      isPresented: $choosingPhotos, selection: $photos, maxSelectionCount: 10, selectionBehavior: .ordered,
      matching: .any(of: [.images, .screenshots, .videos]), preferredItemEncoding: .compatible)
    .onChange(of: photos) { _, items in
      guard !items.isEmpty else { return }
      photos = []
      for item in items { Task { await add(item) } }
    }
    .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      if case .success(let urls) = result { for url in urls { add(url) } }
    }
    .fullScreenCover(isPresented: $takingPhoto) {
      CameraPicker { image in
        takingPhoto = false
        if let data = image?.jpegData(compressionQuality: 0.85) {
          model.attach(data, name: "photo.jpg", type: "image/jpeg", to: key, session: session)
        }
      }
      .ignoresSafeArea()
    }
  }

  private func add(_ item: PhotosPickerItem) async {
    let type = item.supportedContentTypes.first
    let isVideo = type?.conforms(to: .movie) == true
    do {
      guard let data = try await item.loadTransferable(type: Data.self) else { throw CocoaError(.fileReadCorruptFile) }
      if isVideo {
        let ext = type?.preferredFilenameExtension ?? "mov"
        model.attach(data, name: "video.\(ext)", type: type?.preferredMIMEType ?? "video/quicktime", to: key, session: session)
      } else {
        let image = await modelReadable(data, type: type)
        model.attach(image.data, name: "image.\(image.ext)", type: image.mime, to: key, session: session)
      }
    } catch {
      model.attachFailed(isVideo ? "video" : "image", because: error.localizedDescription, to: key)
    }
  }

  private func add(_ url: URL) {
    let access = url.startAccessingSecurityScopedResource()
    defer { if access { url.stopAccessingSecurityScopedResource() } }
    do {
      let data = try Data(contentsOf: url)
      let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? ""
      model.attach(data, name: url.lastPathComponent, type: type, to: key, session: session)
    } catch {
      model.attachFailed(url.lastPathComponent, because: error.localizedDescription, to: key)
    }
  }
}

extension AttachButton where Extra == EmptyView {
  init(key: String, session: Session) {
    self.init(key: key, session: session, extra: { EmptyView() })
  }
}

/// An image in a format the model takes as an image (D-024: PNG, JPEG, GIF, WebP): a photo
/// from the library is often HEIC, so it becomes JPEG here (off the main actor).
@concurrent
private func modelReadable(_ data: Data, type: UTType?) async -> (data: Data, ext: String, mime: String) {
  for (kind, ext, mime) in [(UTType.png, "png", "image/png"), (.jpeg, "jpg", "image/jpeg"), (.gif, "gif", "image/gif"), (.webP, "webp", "image/webp")]
  where type?.conforms(to: kind) == true {
    return (data, ext, mime)
  }
  if let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.85) { return (jpeg, "jpg", "image/jpeg") }
  return (data, type?.preferredFilenameExtension ?? "img", type?.preferredMIMEType ?? "")
}

/// A small copy of an image for a tile, read straight from its bytes (ImageIO) off the main
/// actor: a photo is 12 megapixels, and ten of them decoded would take half a gigabyte.
@concurrent
private func thumbnail(_ data: Data, pixels: Int = 384) async -> UIImage? {
  let options: [CFString: Any] = [
    kCGImageSourceCreateThumbnailFromImageAlways: true,
    kCGImageSourceCreateThumbnailWithTransform: true,
    kCGImageSourceShouldCacheImmediately: true,
    kCGImageSourceThumbnailMaxPixelSize: pixels,
  ]
  guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
    let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
  else { return nil }
  return UIImage(cgImage: image)
}

/// The camera, for a photo to send: `done` gets the photo, or nil when you cancel.
struct CameraPicker: UIViewControllerRepresentable {
  let done: (UIImage?) -> Void

  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.delegate = context.coordinator
    return picker
  }

  func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    let parent: CameraPicker
    init(parent: CameraPicker) { self.parent = parent }

    func imagePickerController(
      _ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
      parent.done(info[.originalImage] as? UIImage)
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.done(nil) }
  }
}

/// The files waiting to go with a message, as tiles you can take back.
struct PendingTiles: View {
  let key: String
  @Environment(AppModel.self) private var model

  var body: some View {
    let files = model.attachments[key] ?? []
    if !files.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(files) { file in
            Tile(name: file.name, image: file.preview, failed: { if case .failed = file.state { true } else { false } }())
              .overlay {
                if file.state == .uploading { ProgressView().padding(6).background(.thinMaterial, in: Circle()) }
              }
              .overlay(alignment: .topTrailing) {
                Button {
                  model.detach(file.id, from: key)
                } label: {
                  Image(systemName: "xmark.circle.fill")
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.6))
                    .font(.body)
                }
                .offset(x: 6, y: -6)
                .accessibilityLabel("Remove \(file.name)")
              }
          }
        }
        .padding(.top, 8)
        .padding(.horizontal, 2)
      }
    }
  }
}

/// The files that went with a sent message. A tap opens one (Quick Look).
struct SentTiles: View {
  let attachments: [Attachment]
  let session: Session
  @State private var opening: URL?
  @State private var loading: String?

  var body: some View {
    HStack(spacing: 8) {
      ForEach(attachments) { file in
        Button {
          Task { await open(file) }
        } label: {
          RemoteTile(file: file, session: session)
            .overlay { if loading == file.path { ProgressView() } }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open \(file.name)")
      }
    }
    .quickLookPreview($opening)
  }

  private func open(_ file: Attachment) async {
    loading = file.path
    defer { loading = nil }
    do {
      let data = try await session.api.file(file.path)
      let url = FileManager.default.temporaryDirectory.appending(path: "rowrow-\(file.name)")
      try data.write(to: url, options: .atomic)
      opening = url
    } catch {
      // Uploads are kept a week; an old one shows as a tile that no longer opens.
    }
  }
}

/// A sent image, fetched back from the server once and kept in memory.
private struct RemoteTile: View {
  let file: Attachment
  let session: Session
  @State private var image: UIImage?

  var body: some View {
    Tile(name: file.name, image: image, failed: false)
      .task(id: file.path) {
        guard file.isImage, image == nil else { return }
        if let cached = ImageCache.shared.image(file.path) {
          image = cached
        } else if let data = try? await session.api.file(file.path), let loaded = await thumbnail(data) {
          ImageCache.shared.keep(loaded, for: file.path)
          image = loaded
        }
      }
  }
}

private struct Tile: View {
  let name: String
  let image: UIImage?
  let failed: Bool

  var body: some View {
    Group {
      if let image {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        VStack(spacing: 4) {
          Image(systemName: failed ? "exclamationmark.triangle" : icon).font(.title3)
          Text(name).font(.caption2).lineLimit(2).multilineTextAlignment(.center)
        }
        .foregroundStyle(failed ? Color.red : .secondary)
        .padding(6)
      }
    }
    .frame(width: 64, height: 64)
    .background(.fill.tertiary)
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(failed ? Color.red : .clear, lineWidth: 1.5))
  }

  private var icon: String {
    let type = UTType(filenameExtension: (name as NSString).pathExtension)
    if type?.conforms(to: .movie) == true { return "film" }
    if type?.conforms(to: .pdf) == true { return "doc.richtext" }
    if type?.conforms(to: .text) == true || type?.conforms(to: .sourceCode) == true { return "doc.text" }
    return "doc"
  }
}

@MainActor
final class ImageCache {
  static let shared = ImageCache()
  private let cache = NSCache<NSString, UIImage>()

  func image(_ key: String) -> UIImage? { cache.object(forKey: key as NSString) }
  func keep(_ image: UIImage, for key: String) { cache.setObject(image, forKey: key as NSString) }
}
