import Foundation

struct BridgeOffer: Identifiable, Equatable {
  let raw: JSONValue
  var id: String {
    (raw["provider"].string ?? "global") + ":" + (raw["op"].string ?? "") + ":" + canonicalParams
  }
  private var canonicalParams: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return (try? encoder.encode(raw["params"])).flatMap { String(data: $0, encoding: .utf8) }
      ?? "{}"
  }
  var provider: String? { raw["provider"].string }
  var key: String { provider ?? "global" }
  var eligible: Bool { raw["eligible"].bool == true }
  var disabledReason: String? { raw["disabledReason"].string }
  var label: String {
    let op = raw["op"].string ?? "Action"
    let duration = raw["params"]["duration"].string
    let labels = [
      "pause": "Pause", "resume": "Resume", "extra.daily": "+3 daily points",
      "profile.use": "Use profile", "preference.set": "Change preference",
      "display.set": "Change display", "failurePolicy.set": "Failure policy",
      "settings.open": "Settings", "status.open": "Status", "protection.test": "Test protection",
    ]
    return (labels[op] ?? op) + (duration.map { " · " + $0 } ?? "")
  }
}
struct PendingCommand {
  let id: String
  let key: String
  let revision: Double
  let waitsForSnapshot: Bool
  let sentAt = Date()
}
enum BridgeEvent {
  case hello
  case snapshot(Snapshot)
  case result(String, Bool, String?)
  case ignored
}
final class BridgeSession {
  private(set) var bridgeInstance: String?
  private(set) var revision = -1.0
  private(set) var snapshot: Snapshot?
  private(set) var pending = [String: PendingCommand]()
  private(set) var waitingForSnapshot = Set<String>()
  var offers: [BridgeOffer] {
    guard let snapshot else { return [] }
    return snapshot.providers.flatMap { $0.payload["actions"].array.map { BridgeOffer(raw: $0) } }
      + snapshot.raw["settings"]["actions"].array.map { BridgeOffer(raw: $0) }
      + (snapshot.raw["discovery"]["suggestion"]["dismiss"] == .null ? [] : [BridgeOffer(raw: snapshot.raw["discovery"]["suggestion"]["dismiss"])])
  }
  func receive(_ data: Data) throws -> BridgeEvent {
    guard data.count <= LineFramer.maximumBytes else { throw BridgeError.oversize }
    let value = try JSONDecoder().decode(JSONValue.self, from: data)
    if let version = value["protocol"].number, version != 1 { throw SnapshotError.incompatible }
    guard value["protocol"].number == 1 else { throw BridgeError.protocolViolation }
    if bridgeInstance == nil {
      guard value["type"].string == "hello", let identity = value["bridgeInstance"].string,
        !identity.isEmpty, value["runtimeVersion"].string != nil,
        value["environmentId"].string != nil
      else { throw BridgeError.protocolViolation }
      bridgeInstance = identity
      return .hello
    }
    switch value["type"].string {
    case "snapshot":
      let next = try Snapshot.decode(data)
      guard next.bridgeInstance == bridgeInstance else { throw BridgeError.protocolViolation }
      guard next.revision > revision else { return .ignored }
      revision = next.revision
      snapshot = next
      waitingForSnapshot.removeAll()
      return .snapshot(next)
    case "result":
      guard let id = value["id"].string, let ok = value["ok"].bool else {
        throw BridgeError.protocolViolation
      }
      guard let match = pending.values.first(where: { $0.id == id }) else { return .ignored }
      pending.removeValue(forKey: match.key)
      // Never infer a successful local change from an acknowledgement.
      // A state_changed failure also requires a fresh reviewed snapshot.
      let code = value["code"].string
      if match.waitsForSnapshot && (ok || code == "state_changed" || code == "busy") { waitingForSnapshot.insert(match.key) }
      return .result(match.key, ok, code)
    default: throw BridgeError.protocolViolation
    }
  }
  func command(_ offer: BridgeOffer) throws -> Data {
    guard bridgeInstance != nil, snapshot != nil else { throw BridgeError.unavailable }
    guard pending[offer.key] == nil, !waitingForSnapshot.contains(offer.key) else {
      throw BridgeError.busy
    }
    guard offer.eligible, offers.contains(offer), let operation = offer.raw["op"].string,
      operation != "failurePolicy.set", case .object(let params) = offer.raw["params"]
    else { throw BridgeError.ineligible }
    let fixed = ["settings.open", "status.open", "protection.test"].contains(operation)
    let token = offer.raw["actionToken"].string
    guard fixed ? params.isEmpty : (token?.isEmpty == false) else { throw BridgeError.ineligible }
    let id = UUID().uuidString
    var fields: [String: JSONValue] = [
      "type": .string("command"), "protocol": .number(1),
      "id": .string(id), "op": .string(operation),
      "params": offer.raw["params"],
    ]
    if !fixed, let token { fields["actionToken"] = .string(token) }
    if let provider = offer.provider { fields["provider"] = .string(provider) }
    var data = try JSONEncoder().encode(JSONValue.object(fields))
    guard data.count <= 65_536 else { throw BridgeError.oversize }
    data.append(10)
    pending[offer.key] = PendingCommand(id: id, key: offer.key, revision: revision, waitsForSnapshot: !["settings.open", "status.open"].contains(operation))
    return data
  }
  func linkCommand(_ linkID: String) throws -> Data {
    guard bridgeInstance != nil, let snapshot,
      DiscoveryLink.rows(snapshot).contains(where: { $0.id == linkID }) else { throw BridgeError.ineligible }
    guard pending["global"] == nil, !waitingForSnapshot.contains("global") else { throw BridgeError.busy }
    let id = UUID().uuidString
    var data = try JSONEncoder().encode(JSONValue.object([
      "type": .string("command"), "protocol": .number(1), "id": .string(id),
      "op": .string("link.open"), "params": .object(["id": .string(linkID)])]))
    data.append(10)
    pending["global"] = PendingCommand(id: id, key: "global", revision: revision, waitsForSnapshot: false)
    return data
  }
  func disconnect() -> [String] {
    let uncertain = pending.keys.sorted()
    pending.removeAll()
    waitingForSnapshot.removeAll()
    snapshot = nil
    revision = -1
    bridgeInstance = nil
    return uncertain
  }
}
