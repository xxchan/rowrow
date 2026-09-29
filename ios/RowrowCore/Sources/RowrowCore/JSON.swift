import Foundation

/// A JSON value. The app state arrives as a snapshot and then as immer patches against it
/// (docs/architecture.md, "Replicating state to clients"): the app keeps the raw tree,
/// applies patches to it, and decodes typed models from it.
public enum JSONValue: Sendable, Equatable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])
}

public struct JSONError: Error, CustomStringConvertible {
  public let description: String
}

extension JSONValue {
  /// Parses JSON text (JSONSerialization: much faster than Codable on a big snapshot).
  public static func parse(_ data: Data) throws -> JSONValue {
    try from(JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]))
  }

  private static func from(_ any: Any) throws -> JSONValue {
    switch any {
    case is NSNull: return .null
    case let number as NSNumber:
      // Booleans come out of JSONSerialization as NSNumber too; CFBoolean tells them apart.
      if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
      return .number(number.doubleValue)
    case let string as String: return .string(string)
    case let array as [Any]: return .array(try array.map(from))
    case let object as [String: Any]: return .object(try object.mapValues(from))
    default: throw JSONError(description: "not JSON: \(type(of: any))")
    }
  }

  private var foundation: Any {
    switch self {
    case .null: NSNull()
    case .bool(let value): value
    case .number(let value): value
    case .string(let value): value
    case .array(let value): value.map(\.foundation)
    case .object(let value): value.mapValues(\.foundation)
    }
  }

  /// JSON text of this value.
  public func data() throws -> Data {
    try JSONSerialization.data(withJSONObject: foundation, options: [.fragmentsAllowed])
  }

  /// A typed value decoded from this one.
  public func decode<T: Decodable>(_ type: T.Type) throws -> T {
    try JSONDecoder().decode(type, from: data())
  }

  public subscript(key: String) -> JSONValue? {
    if case .object(let object) = self { return object[key] }
    return nil
  }
}

extension JSONValue: Codable {
  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    }
  }
}

/// One step of a path into a JSON value: an object key or an array index.
public enum PathComponent: Sendable, Equatable, CustomStringConvertible {
  case key(String)
  case index(Int)

  public var description: String {
    switch self {
    case .key(let key): key
    case .index(let index): String(index)
    }
  }
}

/// An immer patch, as `state.watch` sends them: add, replace or remove a value at a path.
public struct Patch: Sendable, Equatable {
  public enum Op: String, Sendable { case add, replace, remove }
  public let op: Op
  public let path: [PathComponent]
  public let value: JSONValue?

  public init(op: Op, path: [PathComponent], value: JSONValue? = nil) {
    self.op = op
    self.path = path
    self.value = value
  }

  /// A patch from its JSON form (`{op, path, value}`).
  public init(json: JSONValue) throws {
    guard case .string(let op) = json["op"], let kind = Op(rawValue: op),
      case .array(let path) = json["path"]
    else { throw JSONError(description: "not an immer patch") }
    self.op = kind
    self.path = try path.map { component in
      switch component {
      case .string(let key): return .key(key)
      case .number(let index): return .index(Int(index))
      default: throw JSONError(description: "bad patch path")
      }
    }
    self.value = json["value"]
  }
}

extension JSONValue {
  /// Apply immer patches in order. Throws when a patch doesn't fit the tree: the client
  /// then takes a fresh snapshot, as after a reconnect.
  public mutating func apply(_ patches: [Patch]) throws {
    for patch in patches { try apply(patch, at: patch.path[...]) }
  }

  private mutating func apply(_ patch: Patch, at path: ArraySlice<PathComponent>) throws {
    guard let first = path.first else {
      guard patch.op != .remove, let value = patch.value else { throw misfit(patch) }
      self = value
      return
    }
    let rest = path.dropFirst()
    switch (self, first) {
    case (.object(var object), .key(let key)):
      if rest.isEmpty {
        switch patch.op {
        case .add, .replace: object[key] = try value(of: patch)
        case .remove: object.removeValue(forKey: key)
        }
      } else {
        guard var child = object[key] else { throw misfit(patch) }
        try child.apply(patch, at: rest)
        object[key] = child
      }
      self = .object(object)
    case (.array(var array), .index(let index)):
      if rest.isEmpty {
        switch patch.op {
        case .add:
          guard index <= array.count else { throw misfit(patch) }
          array.insert(try value(of: patch), at: index)
        case .replace:
          guard index < array.count else { throw misfit(patch) }
          array[index] = try value(of: patch)
        case .remove:
          guard index < array.count else { throw misfit(patch) }
          array.remove(at: index)
        }
      } else {
        guard index < array.count else { throw misfit(patch) }
        var child = array[index]
        try child.apply(patch, at: rest)
        array[index] = child
      }
      self = .array(array)
    case (.array(var array), .key("length")) where rest.isEmpty && patch.op == .replace:
      // immer shortens an array by replacing its length.
      guard case .number(let length) = patch.value, length >= 0 else { throw misfit(patch) }
      let count = Int(length)
      if count < array.count {
        array.removeLast(array.count - count)
      } else {
        array.append(contentsOf: Array(repeating: .null, count: count - array.count))
      }
      self = .array(array)
    case (.array, .key(let key)):
      guard let index = Int(key) else { throw misfit(patch) }
      try apply(patch, at: [.index(index)] + rest)
    default:
      throw misfit(patch)
    }
  }

  private func value(of patch: Patch) throws -> JSONValue {
    guard let value = patch.value else { throw misfit(patch) }
    return value
  }

  private func misfit(_ patch: Patch) -> JSONError {
    JSONError(
      description:
        "\(patch.op.rawValue) at /\(patch.path.map(\.description).joined(separator: "/")) doesn't fit the state")
  }
}
