import Foundation

// Unknown additive payloads are retained rather than discarded by the fixture reader.
enum JSONValue: Codable, Equatable {
  case object([String: JSONValue])
  case array([JSONValue])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null
  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let b = try? c.decode(Bool.self) {
      self = .bool(b)
    } else if let n = try? c.decode(Double.self), n.isFinite {
      self = .number(n)
    } else if let s = try? c.decode(String.self) {
      self = .string(s)
    } else if let a = try? c.decode([JSONValue].self) {
      self = .array(a)
    } else {
      self = .object(try c.decode([String: JSONValue].self))
    }
  }
  func encode(to encoder: Encoder) throws {
    var value = encoder.singleValueContainer()
    switch self {
    case .object(let o): try value.encode(o)
    case .array(let a): try value.encode(a)
    case .string(let s): try value.encode(s)
    case .number(let n): try value.encode(n)
    case .bool(let b): try value.encode(b)
    case .null: try value.encodeNil()
    }
  }
  subscript(_ key: String) -> JSONValue {
    if case .object(let o) = self { return o[key] ?? .null }
    return .null
  }
  var string: String? {
    if case .string(let s) = self { return s }
    return nil
  }
  var number: Double? {
    if case .number(let n) = self { return n }
    return nil
  }
  var array: [JSONValue] {
    if case .array(let a) = self { return a }
    return []
  }
  var bool: Bool? {
    if case .bool(let b) = self { return b }
    return nil
  }
}
struct ProviderSnapshot: Identifiable {
  let id: String
  let payload: JSONValue
  var label: String { payload["label"].string ?? id.capitalized }
  var windows: [JSONValue] { payload["windows"].array }
  var readError: Bool { payload["readError"].bool == true }
  var paused: Bool {
    let action = payload["verdict"]["action"].string ?? payload["verdict"].string
    return ["pause", "deny", "ask", "stop"].contains(action ?? "")
  }
}
struct Snapshot {
  let revision: Double
  let bridgeInstance: String
  let generatedAtMs: Double
  let providers: [ProviderSnapshot]
  let raw: JSONValue
  private static func validTime(_ v: JSONValue) -> Bool {
    if case .null = v { return true }
    guard let n = v.number else { return false }
    return n >= 0 && n.rounded() == n
  }
  static func decode(_ data: Data) throws -> Snapshot {
    guard data.count <= 1_048_576 else { throw SnapshotError.invalid("Frame exceeds 1 MiB") }
    let v = try JSONDecoder().decode(JSONValue.self, from: data)
    if let version = v["protocol"].number, version != 1 { throw SnapshotError.incompatible }
    guard v["type"].string == "snapshot", v["protocol"].number == 1,
      let revision = v["revision"].number, revision >= 0, revision.rounded() == revision,
      let bridge = v["bridgeInstance"].string, !bridge.isEmpty,
      let generated = v["generatedAtMs"].number, generated >= 0, generated.rounded() == generated,
      case .array(let rows) = v["providers"]
    else { throw SnapshotError.invalid("Expected protocol-1 snapshot envelope") }
    var ids = Set<String>()
    let providers = try rows.map { p -> ProviderSnapshot in
      for (value, allowed) in [
        (p["id"], ["claude", "codex"]),
        (p["verdict"]["action"], ["none", "warn", "ask", "pause"]),
        (p["health"]["state"], ["active", "unverified", "needs_activation", "setup_missing", "hooks_disabled"]),
        (p["failurePolicy"]["mode"], ["default", "strict"]),
      ] {
        if let core = value.string, !allowed.contains(core) { throw SnapshotError.incompatible }
      }

      guard let id = p["id"].string, ["claude", "codex"].contains(id), ids.insert(id).inserted
      else { throw SnapshotError.invalid("Invalid or duplicate provider") }
      guard p["accountContextId"].string?.hasPrefix("ctx_") == true,
        p["label"].string != nil,
        ["none", "warn", "ask", "pause"].contains(p["verdict"]["action"].string ?? ""),
        ["active", "unverified", "needs_activation", "setup_missing", "hooks_disabled"].contains(
          p["health"]["state"].string ?? ""),
        ["default", "strict"].contains(p["failurePolicy"]["mode"].string ?? ""),
        case .array = p["reasons"], case .array = p["thresholds"],
        case .array = p["planning"]["meters"], case .array = p["profiles"]["names"],
        case .array = p["actions"], p["windows"].array.count == 2
      else {
        throw SnapshotError.invalid("Invalid provider payload")
      }
      var windows = Set<String>()
      for w in p["windows"].array {
        if let window = w["window"].string, !["five_hour", "seven_day"].contains(window) { throw SnapshotError.incompatible }
        if let freshness = w["freshness"].string, !["current", "stale", "expired", "missing"].contains(freshness) { throw SnapshotError.incompatible }

        guard let name = w["window"].string, ["five_hour", "seven_day"].contains(name),
          windows.insert(name).inserted,
          let freshness = w["freshness"].string,
          ["current", "stale", "expired", "missing"].contains(freshness),
          validTime(w["seenAtMs"]), validTime(w["resetsAtMs"])
        else { throw SnapshotError.invalid("Invalid window") }
        if freshness == "missing" {
          guard case .null = w["used"] else {
            throw SnapshotError.invalid("Missing window has usage")
          }
        } else {
          guard let used = w["used"].number, (0...100).contains(used) else {
            throw SnapshotError.invalid("Invalid usage")
          }
        }
      }
      return ProviderSnapshot(id: id, payload: p)
    }
    return Snapshot(
      revision: revision, bridgeInstance: bridge, generatedAtMs: generated, providers: providers,
      raw: v)
  }
}
// Cache is display-only: no offer, link declaration, or originally fresh reading survives as live.
extension Snapshot {
  func cachedPresentation() -> Snapshot {
    func replacing(_ value: JSONValue, _ key: String, _ next: JSONValue) -> JSONValue {
      guard case .object(var fields) = value else { return value }
      fields[key] = next; return .object(fields)
    }
    let cachedProviders = providers.map { provider -> ProviderSnapshot in
      let windows = provider.windows.map { row in
        row["freshness"].string == "current" ? replacing(row, "freshness", .string("stale")) : row
      }
      return ProviderSnapshot(id: provider.id, payload: replacing(replacing(provider.payload, "windows", .array(windows)), "actions", .array([])))
    }
    var cached = replacing(raw, "providers", .array(cachedProviders.map(\.payload)))
    cached = replacing(cached, "settings", replacing(raw["settings"], "actions", .array([])))
    cached = replacing(cached, "discovery", .null)
    return Snapshot(revision: revision, bridgeInstance: bridgeInstance, generatedAtMs: generatedAtMs, providers: cachedProviders, raw: cached)
  }
}
enum SnapshotError: Error { case invalid(String), incompatible }
