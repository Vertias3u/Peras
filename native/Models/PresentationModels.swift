import Foundation

// Presentation interprets backend facts; it never evaluates schedules, grants or guard rules.
enum PresentationText {
  static func number(_ value: Double) -> String {
    // Round to the shown tenth first, so 99.96 reads "100", not "100.0".
    let tenth = (value * 10).rounded() / 10
    return tenth.rounded() == tenth ? String(format: "%.0f", tenth) : String(format: "%.1f", tenth)
  }
  static func provider(_ id: String) -> String { id == "claude" ? "Claude Code" : "Codex" }
  static func expiry(_ value: JSONValue, absent: String = "No expiry reported") -> String {
    guard let ms = value.number, ms.isFinite, ms > 0 else { return absent }
    return DateFormatter.localizedString(
      from: Date(timeIntervalSince1970: ms / 1000), dateStyle: .short, timeStyle: .short)
  }
  static func disabled(_ code: String?) -> String? {
    guard let code else { return nil }
    switch code {
    case "not_ready": return "Not available in this runtime yet"
    case "requires_upgrade": return "Update Claude Code to use this operation"
    case "no_reading": return "Waiting for a fresh usage reading"
    case "setup_missing": return "Set up the provider's hooks first"
    case "hooks_disabled": return "Provider hooks are disabled"
    case "runtime_outdated": return "The installed hooks use an older runtime. Run peras setup in your terminal to update them."
    case "state_changed": return "The limits changed; review again"
    default: return "Unavailable in the current state"
    }
  }
  static func result(_ code: String?) -> String {
    switch code {
    case "state_changed": return "The stop changed. Review it again."
    case "busy": return "Another change is being saved. Waiting for a fresh authoritative state before offering one manual retry."
    case "test_failed": return "The protection test did not pass. Review the refreshed status and hook setup."
    case "setup_missing": return "Provider hook setup is missing. Run peras setup in your terminal, then review the refreshed state."
    default: return "Action was not applied. Review the refreshed state."
    }
  }
  // A pause until resumed reads "Keep Paused" on a stopped agent and "Pause Until Resumed" on a running one.
  static func action(_ offer: BridgeOffer, stopped: Bool = true) -> String {
    let duration = offer.raw["params"]["duration"].string
    let span = duration.map { $0 == "1h" ? "for 1 Hour" : $0.hasSuffix("h") || $0.hasSuffix("m") ? "for " + $0 : "Until " + $0 }
    switch offer.raw["op"].string {
    case "pause": return span.map { "Pause " + $0 } ?? (stopped ? "Keep Paused" : "Pause Until Resumed")
    case "resume": return span.map { "Resume " + $0 } ?? "Resume Reviewed Stops"
    case "extra.daily": return "+3 daily points · up to 1 hour"
    case "profile.use": return "Use Profile · " + (offer.raw["params"]["name"].string ?? "Unnamed profile")
    case "failurePolicy.set": return "Change failure handling"
    case "settings.open": return "Settings"
    case "status.open": return "Detailed status"
    case "protection.test": return "Test Protection"
    case "preference.set": return "Change preference"
    case "display.set": return "Change menu display"
    default: return "Apply reviewed action"
    }
  }
}
struct ConfiguredThreshold: Identifiable, Equatable {
  let index: Int
  let value: Double
  let action: String
  let conditional: Bool
  var evaluatedState: String? = nil
  var liftedUntil: JSONValue = .null
  var id: Int { index }
  var outlined: Bool { evaluatedState == "inactive" || evaluatedState == "lifted" }
  var opacity: Double { outlined ? 0.35 : conditional ? 0.55 : 1 }
  var symbol: String {
    let shape = action == "pause" ? "stop" : action == "ask" ? "diamond" : "circle"
    return shape + (outlined ? "" : ".fill")
  }
  var actionName: String { action == "pause" ? "pause" : action == "ask" ? "ask" : "warn" }
  var label: String {
    "\(PresentationText.number(value))% \(actionName)"
      + (conditional ? " · conditional/scheduled" : " · configured") + stateLabel
  }
  var stateLabel: String {
    switch evaluatedState {
    case "clear": return " · currently clear"
    case "inactive": return " · outside scheduled hours"
    case "lifted": return " · temporarily lifted until " + PresentationText.expiry(liftedUntil)
    case "crossed": return " · line crossed"
    default: return ""
    }
  }
  static func rows(_ provider: ProviderSnapshot, window: String) -> [ConfiguredThreshold] {
    provider.payload["thresholds"].array.enumerated().compactMap { index, row in
      guard row["window"].string == window,
        let at = row["at"].number, at.isFinite, (0...100).contains(at),
        let action = row["action"].string, ["warn", "ask", "pause"].contains(action),
        row["scope"].string == nil || row["scope"].string == "global",
        row["kind"].string == nil || row["kind"].string == "window",
        case .null = row["project"]
      else { return nil }
      let conditional: Bool
      if case .null = row["during"] { conditional = false } else { conditional = true }
      return ConfiguredThreshold(index: index, value: at, action: action, conditional: conditional, evaluatedState: row["state"].string, liftedUntil: row["liftedUntilMs"])
    }
  }
}
struct WindowPresentation {
  let window: String
  let freshness: String
  let used: Double?
  let resetAtMs: Double?
  // Formatting belongs to visible text, never readiness checks or sprite ticks.
  var reset: String? { resetAtMs.map { PresentationText.expiry(.number($0)) } }
  var title: String { window == "five_hour" ? "Five-hour window" : "Weekly window" }
  var valueText: String {
    if freshness == "expired" { return "Reset · awaiting reading" }
    guard let used else { return "Not reported" }
    return PresentationText.number(used) + "%"
  }
  var freshnessText: String {
    switch freshness {
    case "current": return "Current reading"
    case "stale": return "Older reading"
    case "expired": return "Previous window expired"
    default: return "No reading available"
    }
  }
  var fraction: Double { (used ?? 0) / 100 }
  init(_ row: JSONValue, window: String) {
    self.window = window
    freshness = row["freshness"].string ?? "missing"
    used = Self.readingValue(row)
    resetAtMs = row["resetsAtMs"].number
  }
  static func readingValue(_ row: JSONValue) -> Double? {
    guard let freshness = row["freshness"].string, freshness == "current" || freshness == "stale",
      let value = row["used"].number, value.isFinite, (0...100).contains(value) else { return nil }
    return value
  }
}
struct ReasonPresentation: Identifiable {
  let raw: JSONValue
  let index: Int
  var id: Int { index }
  var backendID: String? { raw["id"].string }
  var projectScoped: Bool { raw["scope"].string == "project" }
  var stopping: Bool { ["ask", "pause"].contains(raw["action"].string ?? "") }
  var title: String {
    switch raw["kind"].string {
    case "manual": return "Manual pause"
    case "window": return raw["window"].string == "five_hour" ? "Five-hour limit" : "Weekly limit"
    case "daily": return "Daily allowance"
    case "prompt": return "Prompt allowance"
    case "pacing", "pace": return "Reserve pace"
    default: return "Configured limit"
    }
  }
  var scope: String {
    projectScoped
      ? "Observed project · " + (raw["project"]["label"].string ?? "project") : "Global scope"
  }
  var expiry: String {
    PresentationText.expiry(
      raw["expiresAtMs"],
      absent: raw["kind"].string == "manual" ? "Until resumed" : "Expiry not reported")
  }
  var values: String? {
    guard let at = raw["at"].number, let used = raw["used"].number else { return nil }
    let unit: String
    switch raw["unit"].string {
    case "percent": unit = "%"
    case "points": unit = " points"
    default: return nil
    }
    return PresentationText.number(used) + unit + " observed · " + PresentationText.number(at)
      + unit + " line"
  }
  var summary: String { title + " · " + scope + (values.map { " · " + $0 } ?? "") + " · " + expiry }
}
struct ProviderPresentation {
  let provider: ProviderSnapshot
  var reasons: [ReasonPresentation] {
    provider.payload["reasons"].array.enumerated().map {
      ReasonPresentation(raw: $0.element, index: $0.offset)
    }
  }
  var verdict: String { provider.payload["verdict"]["action"].string ?? "none" }
  var projectOnly: Bool {
    let stops = reasons.filter(\.stopping)
    return !stops.isEmpty && stops.allSatisfy(\.projectScoped)
  }
  var status: String {
    if verdict == "ask" { return projectOnly ? "Project approval" : "Approval required" }
    if verdict == "pause" { return projectOnly ? "Project stop" : "Paused" }
    if verdict == "warn" { return "Warning" }
    return "No current stop"
  }
  var health: String {
    switch provider.payload["health"]["state"].string {
    case "active": return "Live guard recently observed"
    case "setup_missing": return "Hook setup needed"
    case "hooks_disabled": return "Hooks disabled"
    case "needs_activation": return "Hook activation needed"
    default: return "Guard not recently verified"
    }
  }
  var offers: [BridgeOffer] { provider.payload["actions"].array.map { BridgeOffer(raw: $0) }.filter { $0.raw["op"].string != "failurePolicy.set" } }
  func impact(_ offer: BridgeOffer) -> [String] {
    guard offer.raw["op"].string == "resume" else {
      if offer.raw["op"].string == "extra.daily" {
        var lines = [
          "Adds 3 points to each matching global daily meter for this provider, until "
            + PresentationText.expiry(offer.raw["expiresAtMs"])
            + ". Usage is not erased; unrelated stops remain."
        ]
        for (index, meter) in provider.payload["planning"]["meters"].array.enumerated() {
          guard meter["period"].string == "daily", case .null = meter["project"] else { continue }
          let row = PlanningPresentation(raw: meter, index: index)
          lines.append("Applies to: " + row.title + " · " + row.summary)
        }
        return lines
      }
      return []
    }
    var lines = [
      "Provider-wide resume for " + PresentationText.provider(provider.id)
        + " across the reviewed observed contexts. Other stops remain in effect; usage is not erased."
    ]
    lines += offer.raw["lifts"].array.map { value -> String in
      let reason = reasons.first { $0.backendID == value.string }
      return "Lifts: "
        + (reason?.summary ?? "another reviewed stop (context not named in this snapshot)")
    }
    lines += offer.raw["extends"].array.map { value in
      let reason = reasons.first { $0.backendID == value["reason"].string }
      let old = PresentationText.expiry(value["untilMs"], absent: "no explicit expiry")
      let new = PresentationText.expiry(offer.raw["expiresAtMs"], absent: "no explicit expiry")
      return (reason?.summary ?? "Reviewed bypass (context not named in this snapshot)")
        + ": replaces previous bypass expiry " + old + " with " + new
    }
    if offer.raw["lifts"].array.isEmpty && offer.raw["extends"].array.isEmpty {
      lines.append("No stop-lifting impact was reported for this offer.")
    }
    return lines
  }
}
struct PlanningPresentation: Identifiable {
  let raw: JSONValue
  let index: Int
  var id: Int { index }
  var title: String {
    if raw["kind"].string == "pacing" { return "Pacing plan" }
    if let project = raw["project"]["label"].string { return "Project allowance · " + project }
    return "Daily allowance"
  }
  func number(_ key: String) -> String { raw[key].number.map(PresentationText.number) ?? "—" }
  var summary: String {
    if raw["workday"].bool == false {
      return "Non-working day · " + number("spent") + " points spent"
    }
    guard let limit = raw["limit"].number, limit > 0 else {
      return "No allowance allocated · " + number("spent") + " points spent"
    }
    return number("spent") + " spent · " + number("remaining") + " remaining of " + number("limit")
      + " points"
  }
}

// Settings are authoritative facts plus signed offered changes, never local flips.
struct SettingsPresentation {
  let raw: JSONValue
  var mascots: Bool { raw["preferences"]["mascots"].bool ?? true }
  var weekly: Bool { raw["preferences"]["weekly"].bool ?? true }
  var offers: [BridgeOffer] { raw["actions"].array.map { BridgeOffer(raw: $0) } }
  func label(_ offer: BridgeOffer) -> String {
    if offer.raw["op"].string == "display.set" {
      return "Menu display: " + display(raw["display"].string) + " → "
        + display(offer.raw["params"]["value"].string)
    }
    let name = offer.raw["params"]["name"].string ?? ""
    let labels = [
      "mascots": "Show mascots", "weekly": "Show weekly usage", "warnings": "Warning notifications",
      "agents": "Tell agents their usage",
      "pauses": "Pause notifications", "resets": "Reset notifications",
      "unused": "Unused allowance notifications",
    ]
    return (labels[name] ?? "Preference") + ": " + boolean(raw["preferences"][name].bool) + " → "
      + boolean(offer.raw["params"]["value"].bool)
  }
  private func boolean(_ value: Bool?) -> String {
    value.map { $0 ? "on" : "off" } ?? "not reported"
  }
  private func display(_ value: String?) -> String {
    value == "pear" ? "pear" : value == "usage" ? "usage" : "not reported"
  }
  static func statusTitle(_ snapshot: Snapshot) -> String {
    statusParts(snapshot).map { ($0.provider == "claude" ? "C " : "X ") + $0.value }.joined(separator: " · ")
  }
  // One part per agent; the menu bar shows each agent's mark before its value.
  static func statusParts(_ snapshot: Snapshot) -> [(provider: String, value: String)] {
    guard snapshot.raw["settings"]["display"].string == "usage" else { return [] }
    return ["claude", "codex"].map { id in
        let row =
          snapshot.providers.first { $0.id == id }?.windows.first {
            $0["window"].string == "five_hour"
          } ?? .null
        let value =
          WindowPresentation(row, window: "five_hour").used.map {
            PresentationText.number($0) + "%"
          } ?? "—"
        return (id, (row["freshness"].string == "stale" ? "~" : "") + value)
      }
  }
}

// Written policy and runtime capability are distinct backend facts.
struct FailurePolicyPresentation {
  let raw: JSONValue
  var activeStrict: Bool { raw["mode"].string == "strict" }
  var mode: String { activeStrict ? "Configured policy: strict" : "Configured policy: default" }
  var capability: String {
    switch raw["strict"].string {
    case "supported": return "This Claude runtime supports strict mode."
    case "requires_upgrade": return "Strict mode requires a newer Claude Code version."
    case "unsupported": return "Strict mode is unsupported by this runtime."
    default: return "Strict mode capability has not been verified."
    }
  }
  var version: String? { raw["claudeVersion"].string }
}
