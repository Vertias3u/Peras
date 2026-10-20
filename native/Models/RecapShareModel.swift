import Foundation

// The complete recap export boundary: enum-labelled numeric/boolean facts only.
// No source JSON, recap/account ID, arbitrary strings, project, path or exact time.
struct RecapShareModel: Encodable, Equatable {
  struct Reading: Encodable, Equatable {
    let provider: ShareModel.Provider
    let usedPercent: Double
    let pauses: Int?
    let atReset: Bool
    var caption: String {
      var parts = [PresentationText.number(usedPercent) + "% used"]
      if let pauses { parts.append(pauses == 0 ? "never paused" : "paused \(pauses)×") }
      if atReset { parts.append(PresentationText.number(max(0, 100 - usedPercent)) + "% to spare") }
      return parts.joined(separator: ", ")
    }
  }
  let mode: ShareModel.Mode
  let readings: [Reading]
  static func build(_ recaps: [WeeklyRecap], includeReadings: Bool) -> RecapShareModel {
    guard includeReadings else { return RecapShareModel(mode: .privateCard, readings: []) }
    return RecapShareModel(mode: .readings, readings: recaps.map { Reading(provider: $0.provider, usedPercent: $0.used, pauses: $0.pauses, atReset: $0.atReset) })
  }
}
