import Foundation

// This is the entire export boundary. It cannot store Snapshot, JSONValue, labels,
// account/context IDs, profiles, projects, paths, tokens or exact timestamps.
struct ShareModel: Encodable, Equatable {
  enum Mode: String, Encodable { case privateCard, readings }
  enum Provider: String, Encodable {
    case claude, codex
    var title: String { self == .claude ? "Claude Code" : "Codex" }
  }
  enum Window: String, Encodable {
    case five_hour, seven_day
    var title: String { self == .five_hour ? "Five hours" : "Week" }
  }
  enum Freshness: String, Encodable { case current, stale, expired, missing }
  struct Reading: Encodable, Equatable {
    let provider: Provider
    let window: Window
    let freshness: Freshness
    let used: Double?
  }
  static let motto = "spend the last of your week on purpose"
  static let canonicalURL = "https://peras.vertias.eu"
  let mode: Mode
  let readings: [Reading]
  static func build(_ snapshot: Snapshot?, includeReadings: Bool) -> ShareModel {
    guard includeReadings else { return ShareModel(mode: .privateCard, readings: []) }
    let rows = (snapshot?.providers ?? []).flatMap { provider -> [Reading] in
      guard let known = Provider(rawValue: provider.id) else { return [] }
      return provider.windows.compactMap { row in
        guard let rawWindow = row["window"].string, let window = Window(rawValue: rawWindow) else {
          return nil
        }
        let freshness = Freshness(rawValue: row["freshness"].string ?? "") ?? .missing
        let value: Double?
        if [.current, .stale].contains(freshness), let used = row["used"].number, used.isFinite,
          (0...100).contains(used)
        {
          value = used
        } else {
          value = nil
        }
        return Reading(provider: known, window: window, freshness: freshness, used: value)
      }
    }
    return ShareModel(mode: .readings, readings: rows)
  }
}
