import AppKit
import Foundation

enum WeeklyStyle: String, CaseIterable { case bar, text, off }
struct MenuSettings {
  let raw: JSONValue
  var weeklyStyle: WeeklyStyle {
    if let value = raw["weeklyStyle"].string, let style = WeeklyStyle(rawValue: value) { return style }
    return raw["preferences"]["weekly"].bool == false ? .off : .bar
  }
  var unknownStyle: Bool {
    raw["weeklyStyle"].string.map { WeeklyStyle(rawValue: $0) == nil } ?? false
  }
  func offer(style: WeeklyStyle) -> BridgeOffer? {
    guard !unknownStyle else { return nil }
    let offers = raw["actions"].array.map { BridgeOffer(raw: $0) }
    if let exact = offers.first(where: { $0.raw["op"].string == "weeklyStyle.set" && $0.raw["params"]["value"].string == style.rawValue }) { return exact }
    guard raw["weeklyStyle"].string == nil, style != .text else { return nil }
    return offers.first { $0.raw["op"].string == "preference.set" && $0.raw["params"]["name"].string == "weekly" && $0.raw["params"]["value"].bool == (style != .off) }
  }
}
struct DiscoveryLink: Identifiable, Equatable {
  let raw: JSONValue
  var id: String { raw["id"].string ?? "" }
  var title: String { raw["title"].string ?? "More from the maker of Peras" }
  var detail: String { raw["detail"].string ?? "" }
  static func rows(_ snapshot: Snapshot?) -> [DiscoveryLink] {
    snapshot?.raw["discovery"]["links"].array.compactMap { value in
      guard let id = value["id"].string, !id.isEmpty, value["title"].string != nil else { return nil }
      return DiscoveryLink(raw: value)
    } ?? []
  }
}
struct CompactProvider {
  let provider: ProviderSnapshot
  // The snapshot's own clock, so fixture readings from another year still read as "today".
  var generatedAtMs: Double = 0
  var presentation: ProviderPresentation { ProviderPresentation(provider: provider) }
  var window: WindowPresentation { WindowPresentation(provider.windows.first { $0["window"].string == "five_hour" } ?? .null, window: "five_hour") }
  var weekly: WindowPresentation { WindowPresentation(provider.windows.first { $0["window"].string == "seven_day" } ?? .null, window: "seven_day") }
  var health: String { provider.payload["health"]["state"].string ?? "unverified" }
  // "unverified" is a live guard seen for these hooks, just not in the last 15 minutes: an idle agent, not a setup problem.
  var needsHealth: Bool { !["active", "unverified"].contains(health) }
  var hasAttention: Bool { ["pause", "ask"].contains(presentation.verdict) || needsHealth }
  var tone: String {
    if presentation.verdict == "pause" { return "indigo" }
    if presentation.verdict == "ask" { return "blue" }
    return "orange"
  }
  var fillTone: String {
    if presentation.verdict == "pause" { return "indigo" }
    let warned = ConfiguredThreshold.rows(provider, window: "five_hour").contains { $0.action == "warn" && $0.evaluatedState == "crossed" }
    if warned { return "orange" }
    if let used = window.used, ConfiguredThreshold.rows(provider, window: "five_hour").contains(where: {
      $0.action == "warn" && $0.evaluatedState == "clear" && used < $0.value && used >= $0.value - 5
    }) { return "pear" }
    return "grey"
  }
  var title: String {
    if ["pause", "ask"].contains(presentation.verdict) {
      let name = provider.label
      if presentation.projectOnly { return name + (presentation.verdict == "ask" ? " needs project approval" : " is paused for this project") }
      let reason = presentation.reasons.first(where: \.stopping)
      if reason?.raw["kind"].string == "manual" { return name + " is paused" }
      return name + (presentation.verdict == "ask" ? " needs approval" : " is paused") + (reason.map { " · " + $0.title.lowercased() } ?? "")
    }
    return provider.label + " · " + presentation.health
  }
  var detail: String {
    if let reason = presentation.reasons.first(where: \.stopping) {
      let nowMs = max(Date().timeIntervalSince1970 * 1000, generatedAtMs)
      let expiry = reason.raw["expiresAtMs"].number.map { "Lifts " + CompactTime.lift($0, nowMs: nowMs) } ?? reason.expiry
      return [Self.shortValues(reason), expiry].compactMap { $0 }.joined(separator: ". ") + "."
    }
    switch health {
    case "setup_missing", "hooks_disabled": return "Run peras setup in your terminal, then finish setup."
    case "needs_activation": return provider.id == "codex" ? "Trust Peras in /hooks and restart open sessions." : "Restart Claude Code to pick up the hooks."
    default: return "Open setup to verify the hooks. Protection has not been confirmed."
    }
  }
  // The strip says what happened in plain words; the tooltip keeps the exact line.
  static func shortValues(_ reason: ReasonPresentation) -> String? {
    guard let at = reason.raw["at"].number, let used = reason.raw["used"].number else { return nil }
    let usedText = PresentationText.number(used), atText = PresentationText.number(at)
    switch reason.raw["unit"].string {
    case "percent": return usedText + "% used, past the " + atText + "% line"
    case "points":
      switch reason.raw["kind"].string {
      case "daily": return "Today’s allowance is used up (" + usedText + " of " + atText + ")"
      case "prompt": return "This prompt’s allowance is used up (" + usedText + " of " + atText + ")"
      default: return usedText + " of " + atText + " used"
      }
    default: return nil
    }
  }
  var fullDetails: String {
    let policy = FailurePolicyPresentation(raw: provider.payload["failurePolicy"])
    let fiveHour = fiveHourReset().map { ["Five-hour " + window.valueText + ", " + $0] } ?? []
    return ([title] + fiveHour + [detail] + presentation.reasons.map(\.summary) + allowances + [policy.mode, policy.capability])
      .map { $0.hasSuffix(".") && !$0.hasSuffix("..") ? String($0.dropLast()) : $0 }.filter { !$0.isEmpty }.joined(separator: ". ")
  }
  /// Only your own pause holds: Resume clears it for good, so "for 1 Hour" would be untrue.
  var manualOnly: Bool {
    guard let plain = presentation.offers.first(where: { $0.raw["op"].string == "resume" && $0.raw["params"]["duration"] == .null }) else { return false }
    let lifted = plain.raw["lifts"].array.compactMap(\.string)
    let manual = Set(provider.payload["reasons"].array.filter { $0["kind"].string == "manual" }.compactMap { $0["id"].string })
    return !lifted.isEmpty && lifted.allSatisfy(manual.contains)
  }
  var resume: BridgeOffer? {
    presentation.offers.first { $0.raw["op"].string == "resume" && (manualOnly ? $0.raw["params"]["duration"] == .null : $0.raw["params"]["duration"].string == "1h") }
  }
  var pauseIndefinitely: BridgeOffer? { presentation.offers.first { offer in
    guard offer.raw["op"].string == "pause", case .null = offer.raw["params"]["duration"] else { return false }
    return true
  } }
  var allowances: [String] { provider.payload["planning"]["meters"].array.enumerated().map { index, raw in
    let meter = PlanningPresentation(raw: raw, index: index)
    return meter.title + ": " + meter.summary + ". Base " + meter.number("baseLimit") + ", extra " + meter.number("extra") + " points. Extra expiry " + PresentationText.expiry(raw["extraExpiresAtMs"])
  } }
  var paceTarget: Double? {
    guard weekly.freshness == "current", weekly.used != nil,
      let meter = provider.payload["planning"]["meters"].array.first(where: { $0["kind"].string == "pacing" && $0["project"] == .null }),
      meter["waitingForReading"].bool != true,
      let target = meter["expectedByTonightPercent"].number, target.isFinite, (0...100).contains(target) else { return nil }
    return target
  }
  var paceText: String? {
    let meter = provider.payload["planning"]["meters"].array.first { $0["kind"].string == "pacing" && $0["project"] == .null } ?? .null
    guard weekly.freshness == "current", meter["waitingForReading"].bool != true else { return nil }
    if meter["workday"].bool == false { return "not a working day" }
    switch meter["pace"].string {
    case "within": return "within today’s plan"
    case "reached": return "today’s share used"
    default: return nil
    }
  }
  var weeklyCaption: String {
    guard weekly.used != nil else { return weekly.freshness == "expired" ? "Weekly reset · awaiting reading" : "Waiting for the first weekly reading" }
    return "Weekly " + weekly.valueText + (paceText.map { " · " + $0 } ?? "")
  }
  // An expired window's reset has already happened; its caption says it's awaiting a reading.
  var weeklyReset: String? {
    guard weekly.freshness != "expired", let value = weekly.resetAtMs, value > Date().timeIntervalSince1970 * 1000 else { return nil }
    return "resets " + CompactTime.weekday.string(from: Date(timeIntervalSince1970: value / 1000))
  }
  // 0.3 showed the five-hour reset beside its usage. Same guard as the weekly reset, on the snapshot's clock:
  // no reading, an expired window or a reset already behind us shows nothing.
  // A reset later today reads "resets 17:40", any other day "resets Mon 01:10".
  func fiveHourReset(nowMs: Double? = nil, calendar: Calendar = .current) -> String? {
    let now = nowMs ?? max(Date().timeIntervalSince1970 * 1000, generatedAtMs)
    guard window.freshness != "expired", window.used != nil, let value = window.resetAtMs, value > now else { return nil }
    let date = Date(timeIntervalSince1970: value / 1000)
    let sameDay = calendar.isDate(date, inSameDayAs: Date(timeIntervalSince1970: now / 1000))
    return "resets " + CompactTime.formatter(sameDay ? "jmm" : "EEEjmm", calendar: calendar).string(from: date)
  }
  var shortAllowance: String? {
    guard let raw = provider.payload["planning"]["meters"].array.first(where: { ($0["extra"].number ?? 0) > 0 }) else { return nil }
    return "+" + PresentationText.number(raw["extra"].number!) + " extra"
  }
}
enum CompactTime {
  static let weekday = formatter("EEEjmm")
  // Templates follow the user's 12/24-hour setting: "Wed 17:46" or "Wed 5:46 PM".
  static func formatter(_ template: String, calendar: Calendar = .current) -> DateFormatter {
    let formatter = DateFormatter(), locale = calendar.locale ?? .current
    formatter.calendar = calendar; formatter.timeZone = calendar.timeZone; formatter.locale = locale
    formatter.dateFormat = DateFormatter.dateFormat(fromTemplate: template, options: 0, locale: locale)
    return formatter
  }
  // "today 18:37", "at midnight", "tomorrow 09:00", "Wed 17:46", then "17 Mar 18:37".
  // A lift time already behind us (an older snapshot) reads "now", never a date that looks ahead.
  static func lift(_ ms: Double, nowMs: Double, calendar: Calendar = .current) -> String {
    let date = Date(timeIntervalSince1970: ms / 1000), now = Date(timeIntervalSince1970: nowMs / 1000)
    guard ms > nowMs else { return "now" }
    let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 99
    let midnight = calendar.dateComponents([.hour, .minute], from: date) == DateComponents(hour: 0, minute: 0)
    let time = formatter("jmm", calendar: calendar).string(from: date)
    switch days {
    case 0: return "today " + time
    case 1: return midnight ? "at midnight" : "tomorrow " + time
    case 2...6: return formatter("EEEjmm", calendar: calendar).string(from: date)
    default: return formatter("dMMMjmm", calendar: calendar).string(from: date)
    }
  }
}
struct SetupStep: Identifiable {
  let id: String
  let title: String
  let detail: String
  let complete: Bool
}
struct SetupPresentation {
  let providers: [ProviderSnapshot]
  /// Names the agents Peras can't pause yet, when others are already protected.
  var caption: String {
    let waiting = unfinished
    guard !waiting.isEmpty, waiting.count < providers.count else { return "Until then, Peras shows usage but can’t pause." }
    return "Until then, Peras can’t pause " + waiting.map(\.label).joined(separator: " or ") + "."
  }
  var unfinished: [ProviderSnapshot] { providers.filter {
    let setup = $0.payload["setup"]
    return setup["hooks"].string != "configured" || setup["current"].bool != true
      || setup["next"] != .null || !["active", "unverified"].contains($0.payload["health"]["state"].string ?? "")
  } }
  private var hookGuidance: String {
    let instructions = ["claude", "codex"].compactMap { id -> String? in
      guard let provider = providers.first(where: { $0.id == id }) else { return nil }
      let setup = provider.payload["setup"]
      if setup["hooks"].string == "disabled" || setup["next"].string == "enable_hooks" {
        return id == "claude"
          ? "Turn off disableAllHooks in Claude Code’s settings, then run peras doctor."
          : "Enable Codex hooks in config.toml, then run peras codex doctor."
      }
      guard setup["hooks"].string != "configured" || setup["current"].bool != true
        || ["run_setup", "update_hooks"].contains(setup["next"].string ?? "") else { return nil }
      return id == "claude" ? "Run peras setup for Claude Code." : "Run peras codex setup for Codex."
    }
    return instructions.isEmpty ? "Choose the agents you use, then install their Peras hooks." : instructions.joined(separator: " ")
  }
  var steps: [SetupStep] {
    let hooksReady = !providers.isEmpty && providers.allSatisfy { $0.payload["setup"]["hooks"].string == "configured" && $0.payload["setup"]["current"].bool == true }
    let missing = providers.contains { $0.payload["setup"]["hooks"].string == "missing" }
    let disabled = providers.contains { $0.payload["setup"]["hooks"].string == "disabled" }
    // Peras itself is installed once this app runs, so setup never starts from zero.
    var result = [SetupStep(id: "installed", title: "Peras installed", detail: "The menu and the peras command are ready.", complete: true)]
    result.append(SetupStep(id: "hooks", title: hooksReady ? "Hooks installed" : missing ? "Install Peras hooks" : disabled ? "Enable Peras hooks" : "Update Peras hooks", detail: hooksReady ? "Peras hooks are configured for the providers shown below." : hookGuidance, complete: hooksReady))
    for id in ["claude", "codex"] {
      let provider = providers.first { $0.id == id }
      result.append(SetupStep(id: id + "-active", title: id == "codex" ? "Trust Peras in Codex" : "Restart Claude Code", detail: id == "codex" ? "Type /hooks, trust Peras, and restart open sessions. This turns green after a guarded tool call." : "Restart open sessions. This turns green after Claude Code’s next guarded tool call.", complete: ["active", "unverified"].contains(provider?.payload["health"]["state"].string ?? "")))
    }
    result.append(SetupStep(id: "test", title: "Check that pausing works", detail: "Checks both configured agents in an isolated folder. Your agents keep running.", complete: !providers.isEmpty && providers.allSatisfy { $0.payload["setup"]["testPassedAtMs"].number != nil }))
    return result
  }
}

struct CompactSpriteLayout {
  let sprite: CGRect
  let cup: CGRect
  // The cup art has its handle on the right; it flips when the cup sits right of the mascot,
  // so the handle always faces the paw that holds it.
  let cupFlipped: Bool
  // Codex's art is narrow inside its frame, so it is drawn larger, cup included.
  // Codex's art is narrow in its frame, so it's drawn larger: exactly 1.5 screen pixels per art pixel
  // (30 × 21 pt) and its cup exactly 3 (12 × 10.5 pt). Whole ratios keep nearest-neighbour pixels exact.
  static func size(_ provider: String) -> Double { provider == "codex" ? 30.0 / 22 : 1 }
  static func cupSize(_ provider: String) -> Double { provider == "codex" ? 12.0 / 11 : 1 }
  // Where each mascot's paws end, as a share of its 40-pixel frame (from the atlas art).
  static func paws(_ provider: String) -> (left: Double, right: Double) {
    // Each side is pulled in by the cup art's one empty column, so the handle touches the paw.
    let pixels: (left: Double, right: Double) = provider == "codex" ? (14.5, 25.5) : (4.5, 35)
    return (pixels.left / 40, pixels.right / 40)
  }
  // Clawd's arms are high on its body, so its cup is lifted until the handle meets the arm.
  static func hold(_ provider: String) -> Double { provider == "codex" ? 0 : 4.5 }
  static func make(usage: Double?, patrol: Double, dy: Double, stretch: Double, cupLift: Double, scale: CGFloat, width: Double = 288, provider: String = "claude") -> CompactSpriteLayout {
    func snap(_ value: Double) -> Double { (value * scale).rounded() / scale }
    let size = Self.size(provider), paws = Self.paws(provider)
    let spriteWidth = snap(22 * size), spriteHeight = snap(15.5 * size), cupWidth = snap(11 * Self.cupSize(provider)), cupHeight = snap(9.5 * Self.cupSize(provider))
    let x = snap(usage == nil ? 0 : max(0, min(1, patrol)) * (width - spriteWidth))
    let y = snap(23 - spriteHeight + dy * 0.55 * size)
    let right = x + spriteWidth * paws.right
    let fitsRight = right + cupWidth <= width
    let cupX = snap(max(0, min(width - cupWidth, fitsRight ? right : x + spriteWidth * paws.left - cupWidth)))
    let cupY = snap(y + spriteHeight - cupHeight - Self.hold(provider) - cupLift * 0.55 * size)
    return CompactSpriteLayout(sprite: CGRect(x: x, y: y, width: spriteWidth, height: spriteHeight + snap(stretch * 0.55 * size)),
      cup: CGRect(x: cupX, y: cupY, width: cupWidth, height: cupHeight), cupFlipped: fitsRight)
  }
}
