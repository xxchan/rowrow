import Foundation
import os

// The app talks to the server the way the CLI and curl do (docs/decisions.md, D-026): every
// procedure of the contract is `POST /api/<group>/<name>` with JSON in and out, streams come
// back as server-sent events, and every request carries the device's bearer token and a
// trace id (`rowrow logs --trace <id>` finds what a call caused).

let logger = Logger(subsystem: "rowrow", category: "core")

public enum RowrowError: Error, LocalizedError, Sendable, Equatable {
  /// The server doesn't know this device's credential (revoked, or another server now).
  case signedOut(String)
  /// The server refused the call: its code (NOT_FOUND, CONFLICT…) and a message that says what to do.
  case server(status: Int, code: String, message: String)
  /// The server can't be reached.
  case offline(String)
  /// The answer didn't make sense to this app (an older app, a newer server?).
  case unreadable(String)
  /// A sign-in link that doesn't work.
  case invalidLink(String)

  public var errorDescription: String? {
    switch self {
    case .signedOut(let message), .offline(let message), .unreadable(let message), .invalidLink(let message):
      message
    case .server(_, _, let message): message
    }
  }

  public var code: String? {
    if case .server(_, let code, _) = self { return code }
    return nil
  }
}

extension URLSession {
  /// One session for everything the app asks a server: no cookies, no cache, streams held open.
  public static let rowrow: URLSession = {
    let config = URLSessionConfiguration.default
    // Idle time between bytes; a stream's server sends a keepalive every 5 s.
    config.timeoutIntervalForRequest = 30
    config.httpMaximumConnectionsPerHost = 8
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.urlCache = nil
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.waitsForConnectivity = false
    return URLSession(configuration: config)
  }()
}

/// No input.
public struct Empty: Codable, Sendable { public init() {} }

public struct APIClient: Sendable {
  public let baseURL: URL
  private let token: String
  private let session: URLSession

  public init(baseURL: URL, token: String, session: URLSession = .rowrow) {
    self.baseURL = baseURL
    self.token = token
    self.session = session
  }

  /// Call a procedure (`agents.send`) and decode its answer.
  public func call<Output: Decodable>(
    _ procedure: String, _ input: some Encodable = Empty(), as: Output.Type = Output.self
  ) async throws -> Output {
    let data = try await raw(procedure, input)
    do {
      return try JSONDecoder().decode(Output.self, from: data)
    } catch {
      logger.error("api.unreadable \(procedure, privacy: .public): \(String(describing: error), privacy: .public)")
      throw RowrowError.unreadable("rowrow's answer to \(procedure) didn't make sense to this app: update the app, or rowrow on your computer.")
    }
  }

  /// Call a procedure and keep its answer as JSON text (transcripts go to the kit as they are).
  public func raw(_ procedure: String, _ input: some Encodable = Empty()) async throws -> Data {
    let request = try makeRequest(procedure, input)
    let (data, response) = try await perform { try await session.data(for: request) }
    try check(response, body: data, procedure: procedure)
    return data
  }

  /// A streaming procedure (`state.watch`, `agents.watch`): each message's JSON text, until the
  /// server ends it or the task is cancelled.
  public func stream(_ procedure: String, _ input: some Encodable = Empty()) -> AsyncThrowingStream<String, any Error> {
    let request: URLRequest
    do {
      request = try makeRequest(procedure, input, accept: "text/event-stream")
    } catch {
      return AsyncThrowingStream { $0.finish(throwing: error) }
    }
    let session = session
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          let (bytes, response) = try await perform { try await session.bytes(for: request) }
          if (response as? HTTPURLResponse)?.statusCode != 200 {
            var body = Data()
            for try await byte in bytes { body.append(byte) }
            try check(response, body: body, procedure: procedure)
          }
          var parser = ServerSentEvents()
          var line = Data()
          for try await byte in bytes {
            guard byte == 0x0A else {
              line.append(byte)
              continue
            }
            let text = String(decoding: line, as: UTF8.self)
            line.removeAll(keepingCapacity: true)
            guard let event = parser.feed(text) else { continue }
            switch event.name {
            case "message": continuation.yield(event.data)
            case "done":
              continuation.finish()
              return
            case "error":
              throw serverError(status: 500, body: Data(event.data.utf8), procedure: procedure)
            default: break
            }
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  /// Upload a file (`files.upload`): an attachment for the next message (the server keeps it a week).
  public func upload(_ data: Data, filename: String, type: String) async throws -> Attachment {
    let boundary = "rowrow-\(UUID().uuidString)"
    var body = Data()
    let safeName = filename.replacingOccurrences(of: "\"", with: "")
    body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: \(type)\r\n\r\n".utf8))
    body.append(data)
    body.append(Data("\r\n--\(boundary)--\r\n".utf8))
    var request = baseRequest(path: "api/files/upload")
    request.httpMethod = "POST"
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "content-type")
    request.timeoutInterval = 120
    let (answer, response) = try await perform { try await session.upload(for: request, from: body) }
    try check(response, body: answer, procedure: "files.upload")
    do {
      return try JSONDecoder().decode(Attachment.self, from: answer)
    } catch {
      throw RowrowError.unreadable("rowrow's answer to the upload didn't make sense to this app.")
    }
  }

  public enum KitDownload: Sendable {
    case unchanged
    case changed(source: String, etag: String?)
  }

  /// The server's kit (its folds, for JavaScriptCore), unless the copy with `etag` is still current.
  public func kit(etag: String?) async throws -> KitDownload {
    var request = baseRequest(path: "kit.js")
    request.httpMethod = "GET"
    if let etag { request.setValue(etag, forHTTPHeaderField: "if-none-match") }
    let (data, response) = try await perform { try await session.data(for: request) }
    let http = response as? HTTPURLResponse
    if http?.statusCode == 304 { return .unchanged }
    guard http?.statusCode == 200 else {
      throw RowrowError.unreadable("This rowrow can't serve the app what it needs (/kit.js answered \(http?.statusCode ?? 0)): update rowrow on your computer.")
    }
    return .changed(source: String(decoding: data, as: UTF8.self), etag: http?.value(forHTTPHeaderField: "etag"))
  }

  // ─── Plumbing ──────────────────────────────────────────────────────────────

  private func baseRequest(path: String) -> URLRequest {
    var request = URLRequest(url: baseURL.appending(path: path))
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    request.setValue(traceId(), forHTTPHeaderField: "x-rowrow-trace")
    return request
  }

  private func makeRequest(_ procedure: String, _ input: some Encodable, accept: String = "application/json") throws
    -> URLRequest
  {
    var request = baseRequest(path: "api/" + procedure.replacingOccurrences(of: ".", with: "/"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue(accept, forHTTPHeaderField: "accept")
    request.httpBody = try JSONEncoder().encode(input)
    return request
  }

  private func check(_ response: URLResponse, body: Data, procedure: String) throws {
    guard let http = response as? HTTPURLResponse else {
      throw RowrowError.offline("No answer from rowrow.")
    }
    if (200..<300).contains(http.statusCode) { return }
    throw serverError(status: http.statusCode, body: body, procedure: procedure)
  }
}

func serverError(status: Int, body: Data, procedure: String) -> RowrowError {
  struct Problem: Decodable {
    let code: String?
    let message: String?
  }
  let problem = try? JSONDecoder().decode(Problem.self, from: body)
  let message = problem?.message ?? (String(data: body, encoding: .utf8).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } ?? "")
  if status == 401 {
    return .signedOut("This device isn't signed in to rowrow anymore. Pair it again from Settings → Pair a device on your computer.")
  }
  logger.warn("api.error \(procedure) \(status) \(message)")
  return .server(status: status, code: problem?.code ?? "HTTP_\(status)", message: message.isEmpty ? "rowrow answered \(status) to \(procedure)." : message)
}

/// Runs a URLSession call, turning transport failures into `RowrowError.offline`.
func perform<T>(_ body: () async throws -> T) async throws -> T {
  do {
    return try await body()
  } catch let error as URLError {
    if error.code == .cancelled { throw CancellationError() }
    throw RowrowError.offline(describe(error))
  }
}

private func describe(_ error: URLError) -> String {
  switch error.code {
  case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
    "No network connection."
  case .timedOut: "rowrow didn't answer in time."
  case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed:
    "Can't reach rowrow at \(error.failingURL?.host() ?? "its address"). Is your computer awake and on the same network (or Tailscale)?"
  case .appTransportSecurityRequiresSecureConnection:
    "iOS only allows plain HTTP on your local network. Serve rowrow over HTTPS (tailscale serve, or --tls-cert)."
  case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot, .secureConnectionFailed:
    "rowrow's HTTPS certificate isn't trusted by this iPhone."
  default: error.localizedDescription
  }
}

func traceId() -> String {
  (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
}

extension Logger {
  func warn(_ message: String) { warning("\(message, privacy: .public)") }
}

// ─── Server-sent events ──────────────────────────────────────────────────────

/// Reads server-sent events one line at a time: `event:` and `data:` lines, a blank line ends
/// an event, `:` lines are comments (the server's keepalives).
public struct ServerSentEvents: Sendable {
  public struct Event: Sendable, Equatable {
    public let name: String
    public let data: String
  }

  private var name = ""
  private var data: [String] = []

  public init() {}

  public mutating func feed(_ rawLine: String) -> Event? {
    let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
    if line.isEmpty {
      defer {
        name = ""
        data = []
      }
      guard !data.isEmpty || !name.isEmpty else { return nil }
      return Event(name: name.isEmpty ? "message" : name, data: data.joined(separator: "\n"))
    }
    if line.hasPrefix(":") { return nil }
    let field: Substring
    var value: Substring
    if let colon = line.firstIndex(of: ":") {
      field = line[..<colon]
      value = line[line.index(after: colon)...]
      if value.hasPrefix(" ") { value = value.dropFirst() }
    } else {
      field = line[...]
      value = ""
    }
    switch field {
    case "event": name = String(value)
    case "data": data.append(String(value))
    default: break
    }
    return nil
  }
}

// ─── Pairing ─────────────────────────────────────────────────────────────────

/// What pairing gives the app: where the server is, and this device's credential there.
public struct Pairing: Sendable, Equatable {
  public let baseURL: URL
  public let token: String
  public let deviceId: String
  public let deviceName: String
}

extension APIClient {
  /// Reads a sign-in link (`https://host/auth/redeem?code=…`, as `rowrow pair` prints and Pair a
  /// device shows as a QR code): the server's address and the one-time code.
  public static func parseLink(_ text: String) throws -> (baseURL: URL, code: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard var components = URLComponents(string: trimmed),
      let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
      components.host != nil,
      let range = components.path.range(of: "/auth/redeem"),
      let code = components.queryItems?.first(where: { $0.name == "code" })?.value, !code.isEmpty
    else {
      throw RowrowError.invalidLink("That isn't a rowrow sign-in link. On your computer, run `rowrow pair`, or open Settings → Pair a device, and scan or copy the link it shows.")
    }
    components.path = String(components.path[..<range.lowerBound])
    components.query = nil
    components.fragment = nil
    guard let baseURL = components.url else { throw RowrowError.invalidLink("That link has no usable address.") }
    return (baseURL, code)
  }

  /// Trade a sign-in link's code for this device's bearer token (POST /auth/token).
  public static func pair(link: String, deviceName: String, session: URLSession = .rowrow) async throws -> Pairing {
    let (baseURL, code) = try parseLink(link)
    var request = URLRequest(url: baseURL.appending(path: "auth/token"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try JSONEncoder().encode(["code": code, "name": deviceName])
    let (data, response) = try await perform { try await session.data(for: request) }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    struct Answer: Decodable {
      struct Device: Decodable {
        let id: String
        let name: String
      }
      let token: String
      let device: Device
    }
    if status == 200, let answer = try? JSONDecoder().decode(Answer.self, from: data) {
      return Pairing(baseURL: baseURL, token: answer.token, deviceId: answer.device.id, deviceName: answer.device.name)
    }
    if status == 404 {
      throw RowrowError.invalidLink("This rowrow is too old for the app: update it on your computer (npm install -g rowrow).")
    }
    struct Problem: Decodable { let message: String? }
    let message = (try? JSONDecoder().decode(Problem.self, from: data))?.message
    throw RowrowError.invalidLink(message ?? "rowrow didn't accept that link (\(status)).")
  }
}
