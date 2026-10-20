import Foundation

// Private UI facts. These identifiers and exact times never cross the export boundary.
struct WeeklyRecap: Identifiable, Equatable {
  let provider: ShareModel.Provider
  let account: String
  let id: String
  let used: Double
  let pauses: Int?
  let atReset: Bool
  let lastReadingAtMs: Double
  let untilMs: Double
  var ledgerKey: String { provider.rawValue + ":" + account + ":" + id }
  init?(_ provider: ProviderSnapshot, generatedAtMs: Double, nowMs: Double) {
    let raw = provider.payload["recap"]
    guard let known = ShareModel.Provider(rawValue: provider.id), let account = provider.payload["accountContextId"].string,
      let id = raw["id"].string, !id.isEmpty,
      let used = raw["usedPercent"].number, used.isFinite, (0...100).contains(used),
      let atReset = raw["atReset"].bool,
      let ended = raw["weekEndedAtMs"].number, ended.isFinite, ended <= generatedAtMs,
      let reading = raw["lastReadingAtMs"].number, reading.isFinite, reading <= ended,
      let until = raw["untilMs"].number, until.isFinite, until > max(nowMs, generatedAtMs) else { return nil }
    let pauses: Int?
    if raw["pauses"] == .null { pauses = nil }
    else if let value = raw["pauses"].number, value.isFinite, value >= 0, value.rounded() == value, value <= Double(Int32.max) { pauses = Int(value) }
    else { return nil }
    self.provider = known; self.account = account; self.id = id; self.used = used
    self.atReset = atReset; self.pauses = pauses; lastReadingAtMs = reading; untilMs = until
  }
  var caption: String {
    var parts = ["Last week: " + PresentationText.number(used) + "% used"]
    if let pauses { parts.append(pauses == 0 ? "never paused" : "paused \(pauses)×") }
    if atReset { parts.append(PresentationText.number(max(0, 100 - used)) + "% to spare") }
    return parts.joined(separator: ", ")
  }
  var privateHelp: String {
    guard !atReset else { return caption }
    let formatter = DateFormatter(); formatter.dateFormat = "EEE HH:mm"
    return caption + ". " + PresentationText.number(used) + "% at " + formatter.string(from: Date(timeIntervalSince1970: lastReadingAtMs / 1000))
  }
}
final class RecapCoordinator {
  private let file: URL?
  private var seen: Set<String>
  private var active = [String: WeeklyRecap]()
  private(set) var persistenceError: String?
  init(root: URL?, fixture: Bool) {
    file = root?.resolvingSymlinksInPath().appendingPathComponent("native/" + (fixture ? "recap-seen-preview.json" : "recap-seen.json"))
    seen = file.flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONDecoder().decode(Set<String>.self, from: $0) } ?? []
  }
  func candidate(_ provider: ProviderSnapshot, generatedAtMs: Double, nowMs: Double = Date().timeIntervalSince1970 * 1000) -> WeeklyRecap? {
    guard let recap = WeeklyRecap(provider, generatedAtMs: generatedAtMs, nowMs: nowMs) else { active.removeValue(forKey: provider.id); return nil }
    if let current = active[provider.id], current.ledgerKey != recap.ledgerKey { active.removeValue(forKey: provider.id) }
    return active[provider.id]?.ledgerKey == recap.ledgerKey || !seen.contains(recap.ledgerKey) ? recap : nil
  }
  @discardableResult func consume(_ recap: WeeklyRecap, visible: Bool, nowMs: Double = Date().timeIntervalSince1970 * 1000) -> Bool {
    guard visible, recap.untilMs > nowMs, !seen.contains(recap.ledgerKey) else { return false }
    seen.insert(recap.ledgerKey); active[recap.provider.rawValue] = recap
    if let file {
      do {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(seen).write(to: file, options: .atomic)
      } catch { persistenceError = "Peras couldn’t remember this recap. It may appear again after restarting the app." }
    }
    return true
  }
  func hasSeen(_ recap: WeeklyRecap) -> Bool { seen.contains(recap.ledgerKey) }
  func clearSession() { active.removeAll() }
}
