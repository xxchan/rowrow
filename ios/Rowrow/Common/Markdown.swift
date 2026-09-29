import SwiftUI
import UIKit

/// What an agent writes, rendered: Foundation parses the Markdown (GitHub's flavor) and marks
/// each run with the blocks it sits in (PresentationIntent); this turns those into views.
/// Inline styles (bold, italic, code, links) stay in the attributed text, which Text renders.
struct MarkdownView: View {
  let text: String
  var font: Font = .body

  var body: some View {
    let blocks = MarkdownCache.shared.blocks(for: text)
    VStack(alignment: .leading, spacing: 10) {
      ForEach(blocks) { block in
        BlockView(block: block, font: font)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct MarkdownBlock: Identifiable {
  enum Kind {
    case paragraph(AttributedString)
    case heading(level: Int, AttributedString)
    case code(language: String?, text: String)
    /// A list item's paragraph: its nesting depth (1 = top level) and its marker (none for a
    /// second paragraph of the same item).
    case item(depth: Int, marker: String?, AttributedString)
    case quote(AttributedString)
    case table(header: [AttributedString], rows: [[AttributedString]])
    case rule
  }
  let id: Int
  let kind: Kind
}

@MainActor
final class MarkdownCache {
  static let shared = MarkdownCache()
  private var cache: [String: [MarkdownBlock]] = [:]
  private var order: [String] = []

  func blocks(for text: String) -> [MarkdownBlock] {
    if let hit = cache[text] { return hit }
    let blocks = parseMarkdown(text)
    cache[text] = blocks
    order.append(text)
    if order.count > 200 { cache.removeValue(forKey: order.removeFirst()) }
    return blocks
  }
}

func parseMarkdown(_ text: String) -> [MarkdownBlock] {
  guard
    let parsed = try? AttributedString(
      markdown: text,
      options: .init(
        allowsExtendedAttributes: true, interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible))
  else {
    return [MarkdownBlock(id: 0, kind: .paragraph(AttributedString(text)))]
  }

  var blocks: [MarkdownBlock] = []
  var current: (identity: Int, intent: PresentationIntent?, text: AttributedString)?
  var table: (identity: Int, header: [AttributedString], rows: [[AttributedString]], row: Int?, cells: [AttributedString])?
  var itemsSeen = Set<Int>()

  func flushTable() {
    guard var t = table else { return }
    if !t.cells.isEmpty {
      if t.row == nil { t.header = t.cells } else { t.rows.append(t.cells) }
    }
    blocks.append(MarkdownBlock(id: blocks.count, kind: .table(header: t.header, rows: t.rows)))
    table = nil
  }

  func flush() {
    guard let block = current else { return }
    current = nil
    let components = block.intent?.components ?? []
    let text = styled(block.text)
    guard let innermost = components.first else {
      blocks.append(MarkdownBlock(id: blocks.count, kind: .paragraph(text)))
      return
    }
    // A table cell: collected into its table.
    if case .tableCell = innermost.kind {
      let tableIdentity = components.first { if case .table = $0.kind { true } else { false } }?.identity ?? -1
      let row: Int? = components.lazy.compactMap { component -> Int?? in
        switch component.kind {
        case .tableHeaderRow: return .some(nil)
        case .tableRow(let index): return .some(index)
        default: return nil
        }
      }.first ?? nil
      if table?.identity != tableIdentity {
        flushTable()
        table = (tableIdentity, [], [], nil, [])
      }
      if table?.row != row {
        if let t = table, !t.cells.isEmpty {
          if t.row == nil { table?.header = t.cells } else { table?.rows.append(t.cells) }
        }
        table?.row = row
        table?.cells = []
      }
      table?.cells.append(text)
      return
    }
    flushTable()
    switch innermost.kind {
    case .codeBlock(let language):
      var code = String(block.text.characters)
      if code.hasSuffix("\n") { code.removeLast() }
      blocks.append(MarkdownBlock(id: blocks.count, kind: .code(language: language, text: code)))
    case .header(let level):
      blocks.append(MarkdownBlock(id: blocks.count, kind: .heading(level: level, text)))
    case .thematicBreak:
      blocks.append(MarkdownBlock(id: blocks.count, kind: .rule))
    default:
      let lists = components.filter {
        switch $0.kind {
        case .orderedList, .unorderedList: true
        default: false
        }
      }
      if let item = components.first(where: { if case .listItem = $0.kind { true } else { false } }) {
        let first = itemsSeen.insert(item.identity).inserted
        var marker: String?
        if first, case .listItem(let ordinal) = item.kind {
          let ordered = lists.first.map { if case .orderedList = $0.kind { true } else { false } } ?? false
          marker = ordered ? "\(ordinal)." : (lists.count > 1 ? "◦" : "•")
        }
        blocks.append(MarkdownBlock(id: blocks.count, kind: .item(depth: max(1, lists.count), marker: marker, text)))
      } else if components.contains(where: { if case .blockQuote = $0.kind { true } else { false } }) {
        blocks.append(MarkdownBlock(id: blocks.count, kind: .quote(text)))
      } else {
        blocks.append(MarkdownBlock(id: blocks.count, kind: .paragraph(text)))
      }
    }
  }

  for run in parsed.runs {
    let intent = run.presentationIntent
    let identity = intent?.components.first?.identity ?? -1
    if current?.identity != identity {
      flush()
      current = (identity, intent, AttributedString())
    }
    current?.text.append(parsed[run.range])
  }
  flush()
  flushTable()
  return blocks
}

/// Inline code gets a monospaced face and a tint; links take the accent color.
private func styled(_ text: AttributedString) -> AttributedString {
  var out = text
  for run in out.runs {
    if let inline = run.inlinePresentationIntent, inline.contains(.code) {
      out[run.range].font = .system(.callout, design: .monospaced)
      out[run.range].backgroundColor = Color(uiColor: .tertiarySystemFill)
    }
  }
  // Trailing newlines of a block would draw as empty lines.
  while out.characters.last == "\n" { out.removeSubrange(out.index(beforeCharacter: out.endIndex)..<out.endIndex) }
  return out
}

private struct BlockView: View {
  let block: MarkdownBlock
  let font: Font

  var body: some View {
    switch block.kind {
    case .paragraph(let text):
      Text(text).font(font).textSelection(.enabled)
    case .heading(let level, let text):
      Text(text)
        .font(level <= 1 ? .title3.bold() : level == 2 ? .headline : .subheadline.bold())
        .padding(.top, 4)
        .accessibilityAddTraits(.isHeader)
    case .code(let language, let code):
      CodeBlock(code: code, language: language)
    case .item(let depth, let marker, let text):
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(marker ?? "").font(font).foregroundStyle(.secondary).frame(minWidth: 14, alignment: .trailing)
        Text(text).font(font).textSelection(.enabled)
      }
      .padding(.leading, CGFloat(depth - 1) * 18)
    case .quote(let text):
      Text(text)
        .font(font)
        .foregroundStyle(.secondary)
        .padding(.leading, 10)
        .overlay(alignment: .leading) { Capsule().fill(.quaternary).frame(width: 3) }
    case .table(let header, let rows):
      ScrollView(.horizontal) {
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
          if !header.isEmpty {
            GridRow { ForEach(header.indices, id: \.self) { Text(header[$0]).font(.subheadline.bold()) } }
            Divider()
          }
          ForEach(rows.indices, id: \.self) { row in
            GridRow { ForEach(rows[row].indices, id: \.self) { Text(rows[row][$0]).font(.subheadline) } }
          }
        }
        .padding(10)
      }
      .background(.fill.quinary, in: RoundedRectangle(cornerRadius: 10))
    case .rule:
      Divider()
    }
  }
}

/// Code: monospaced, scrolling sideways rather than wrapping, with a copy button.
struct CodeBlock: View {
  let code: String
  var language: String?
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(language ?? "code").font(.caption2.monospaced()).foregroundStyle(.secondary)
        Spacer()
        Button {
          UIPasteboard.general.string = code
          copied = true
        } label: {
          Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
            .font(.caption)
        }
        .buttonStyle(.borderless)
        .sensoryFeedback(.success, trigger: copied)
      }
      .padding(.horizontal, 10)
      .padding(.top, 6)
      ScrollView(.horizontal) {
        Text(code)
          .font(.system(.footnote, design: .monospaced))
          .textSelection(.enabled)
          .fixedSize(horizontal: true, vertical: false)
          .padding(10)
      }
    }
    .background(.fill.quinary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }
}
