import Foundation
import Testing

@testable import RowrowCore

@Suite struct JSONPatches {
  func tree(_ json: String) throws -> JSONValue { try JSONValue.parse(Data(json.utf8)) }

  func patches(_ json: String) throws -> [Patch] {
    guard case .array(let list) = try tree(json) else { throw JSONError(description: "not a list") }
    return try list.map(Patch.init(json:))
  }

  @Test func addsReplacesAndRemovesInObjects() throws {
    var state = try tree(#"{"agents":{"a":{"attention":"working","n":1}},"host":{"name":"mac"}}"#)
    try state.apply(
      patches(
        #"""
        [{"op":"replace","path":["agents","a","attention"],"value":"done"},
         {"op":"add","path":["agents","b"],"value":{"attention":"idle"}},
         {"op":"remove","path":["agents","a","n"]}]
        """#))
    #expect(state == (try tree(#"{"agents":{"a":{"attention":"done"},"b":{"attention":"idle"}},"host":{"name":"mac"}}"#)))
  }

  @Test func insertsAndRemovesInArrays() throws {
    var state = try tree(#"{"list":["a","c"]}"#)
    try state.apply(patches(#"[{"op":"add","path":["list",1],"value":"b"},{"op":"add","path":["list",3],"value":"d"}]"#))
    #expect(state == (try tree(#"{"list":["a","b","c","d"]}"#)))
    try state.apply(patches(#"[{"op":"remove","path":["list",0]},{"op":"replace","path":["list",0],"value":"B"}]"#))
    #expect(state == (try tree(#"{"list":["B","c","d"]}"#)))
  }

  @Test func shortensAnArrayByItsLength() throws {
    var state = try tree(#"{"list":[1,2,3,4]}"#)
    try state.apply(patches(#"[{"op":"replace","path":["list","length"],"value":2}]"#))
    #expect(state == (try tree(#"{"list":[1,2]}"#)))
  }

  @Test func replacesTheRoot() throws {
    var state = try tree(#"{"a":1}"#)
    try state.apply(patches(#"[{"op":"replace","path":[],"value":{"b":2}}]"#))
    #expect(state == (try tree(#"{"b":2}"#)))
  }

  @Test func refusesAPatchThatDoesNotFit() throws {
    var state = try tree(#"{"agents":{}}"#)
    #expect(throws: JSONError.self) {
      try state.apply(try patches(#"[{"op":"replace","path":["agents","nope","attention"],"value":"done"}]"#))
    }
  }

  @Test func keepsBooleansApartFromNumbers() throws {
    let value = try tree(#"{"t":true,"f":false,"one":1,"zero":0,"x":1.5}"#)
    #expect(value["t"] == .bool(true))
    #expect(value["f"] == .bool(false))
    #expect(value["one"] == .number(1))
    #expect(value["zero"] == .number(0))
    #expect(try JSONValue.parse(value.data()) == value)
  }
}
