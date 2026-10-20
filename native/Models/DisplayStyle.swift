import Foundation

enum DisplayStyle: String, CaseIterable { case pear, usage, fill }
struct DisplayPresentation {
  let raw: JSONValue
  var style: DisplayStyle { raw["displayStyle"].string.flatMap(DisplayStyle.init) ?? (raw["display"].string == "usage" ? .usage : .pear) }
  var unknown: Bool { raw["displayStyle"].string.map { DisplayStyle(rawValue: $0) == nil } ?? false }
  func offer(_ style: DisplayStyle) -> BridgeOffer? {
    guard !unknown else { return nil }
    let offers = raw["actions"].array.map { BridgeOffer(raw: $0) }
    if let exact = offers.first(where: { $0.raw["op"].string == "displayStyle.set" && $0.raw["params"]["value"].string == style.rawValue }) { return exact }
    guard raw["displayStyle"].string == nil, style != .fill else { return nil }
    return offers.first { $0.raw["op"].string == "display.set" && $0.raw["params"]["value"].string == style.rawValue }
  }
}
struct FillingPear: Equatable {
  let step: Int?
  let used: Double?
  let freshness: String
  let tone: String
  init(_ snapshot: Snapshot?) {
    let candidates = (snapshot?.providers ?? []).map { CompactProvider(provider: $0) }.filter { $0.window.used != nil }
    guard let busiest = candidates.max(by: { ($0.window.used ?? 0) < ($1.window.used ?? 0) }), let value = busiest.window.used else {
      step = nil; used = nil; freshness = "missing"; tone = "default"; return
    }
    used = value; freshness = busiest.window.freshness
    step = max(0, min(8, Int((value * 8 / 100).rounded())))
    tone = busiest.presentation.verdict == "pause" ? "indigo" : busiest.fillTone == "orange" ? "orange" : "default"
  }
  var label: String { used.map { "Busiest five-hour usage: " + PresentationText.number($0) + "%, " + freshness + (tone == "indigo" ? ", paused" : tone == "orange" ? ", warning line crossed" : "") } ?? "Waiting for a five-hour reading" }
}
