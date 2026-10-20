import AppKit

// Headless semantic checks; real display/Space behavior is covered separately by owned-app probes.
enum DesktopChecks {
  static func run(options: Options, resources: SpriteResources) throws {
    var passed = [String]()
    func check(_ result: Bool, _ name: String) throws {
      guard result else { throw SnapshotError.invalid("Desktop check failed: " + name) }
      passed.append(name)
    }
    let left = NSRect(x: -1280, y: -200, width: 1280, height: 500)
    let right = NSRect(x: 0, y: 0, width: 1440, height: 900)
    let clamped = DesktopGeometry.clamp(NSRect(x: -1200, y: -500, width: 400, height: 900), screens: [left, right])
    try check(left.contains(clamped) && clamped.height == 500 && clamped.minX < 0, "negative-origin short screen clamps all edges")
    let unplugged = DesktopGeometry.clamp(NSRect(x: -1200, y: -200, width: 400, height: 680), screens: [right])
    try check(right.contains(unplugged), "disconnected screen geometry moves to available screen")
    let small = NSRect(x: 0, y: 0, width: 220, height: 180)
    try check(small.contains(DesktopGeometry.clamp(NSRect(x: 50, y: 50, width: 400, height: 680), screens: [small])), "screen smaller than minimum remains contained")
    // Over another app's full-screen Space the menu activates only after didShow; on the desktop before.
    try check(MenuActivation.timing(overFullScreen: false) == .beforeShow && MenuActivation.timing(overFullScreen: true) == .afterDidShow,
      "menu activates before show on the desktop and after didShow over a full-screen app")
    let display = CGRect(x: 0, y: 0, width: 1280, height: 800)
    func window(_ pid: Int32, _ rect: CGRect, layer: Int = 0) -> [String: Any] {
      [kCGWindowOwnerPID as String: pid, kCGWindowLayer as String: layer, kCGWindowBounds as String: rect.dictionaryRepresentation as NSDictionary]
    }
    try check(AppDelegate.coversDisplay([window(42, display)], display: display, mine: 7), "another app's display-sized window is a full-screen Space")
    try check(!AppDelegate.coversDisplay([window(42, CGRect(x: 0, y: 0, width: 1280, height: 775))], display: display, mine: 7)
      && !AppDelegate.coversDisplay([window(7, display)], display: display, mine: 7)
      && !AppDelegate.coversDisplay([window(42, display, layer: 25)], display: display, mine: 7),
      "zoomed windows, Peras's own windows and overlay layers are not a full-screen Space")
    for mode in ["default", "strict"] {
      for capability in ["supported", "requires_upgrade", "unknown", "unsupported"] {
        let model = FailurePolicyPresentation(raw: .object(["mode": .string(mode), "strict": .string(capability), "claudeVersion": .string("2.1.302")]))
        try check(model.activeStrict == (mode == "strict") && model.version == "2.1.302", "policy \(mode) capability \(capability) kept distinct")
      }
    }
    try check(PresentationText.disabled("runtime_outdated")?.contains("peras setup") == true, "outdated runtime explains terminal setup")
    for action in ["warn", "ask", "pause"] {
      let active = ConfiguredThreshold(index: 0, value: 90, action: action, conditional: false, evaluatedState: "crossed")
      for state in ["inactive", "lifted"] {
        let inactive = ConfiguredThreshold(index: 0, value: 90, action: action, conditional: false, evaluatedState: state)
        try check(inactive.outlined && inactive.opacity < active.opacity && inactive.symbol != active.symbol,
          "\(action) \(state) retains distinct shape with dim outlined marker")
      }
    }
    let pace = ReasonPresentation(raw: .object(["kind": .string("pace"), "unit": .string("percent"), "used": .number(80), "at": .number(75)]), index: 0)
    let prompt = ReasonPresentation(raw: .object(["kind": .string("prompt"), "unit": .string("points"), "used": .number(4), "at": .number(3)]), index: 0)
    let unknownUnit = ReasonPresentation(raw: .object(["kind": .string("window"), "used": .number(4), "at": .number(3)]), index: 0)
    try check(pace.values?.contains("80%") == true && pace.values?.contains("points") == false, "pace reason uses authoritative percent unit")
    try check(prompt.values?.contains("4 points") == true && prompt.values?.contains("%") == false, "prompt reason uses authoritative points unit")
    try check(unknownUnit.values == nil, "missing reason unit never invents numerical semantics")
    try check(PresentationText.disabled("requires_upgrade")?.contains("Update") == true
      && PresentationText.disabled("no_reading")?.contains("reading") == true
      && PresentationText.result("test_failed").contains("did not pass")
      && PresentationText.result("setup_missing").contains("peras setup"), "actual unavailable and result codes have actionable explanations")
    let source = try Data(contentsOf: options.fixtureDirectory.appendingPathComponent("normal-usage.json"))
    let snapshot = try Snapshot.decode(source)
    let store = FixtureStore(resources: resources, fixtureDirectory: options.fixtureDirectory, fixtureMode: false)
    store.apply(snapshot)
    let offers = snapshot.providers.flatMap { $0.payload["actions"].array }.map { BridgeOffer(raw: $0) }
    let a = offers.first { $0.provider == "claude" && $0.eligible }!
    let b = offers.first { $0.provider == "codex" && $0.eligible }!
    store.send(a)
    store.send(b)
    store.recordResult(key: a.key, code: "busy")
    try check(store.retryOffers.isEmpty, "busy requires a post-result snapshot")
    store.recordResult(key: b.key, code: nil)
    store.blockedProviders.removeAll()
    store.apply(snapshot)
    try check(store.retryOffers == [a], "interleaved result retains only matching provider retry")
    store.retryOnce(a)
    store.recordResult(key: a.key, code: "busy")
    store.blockedProviders.removeAll()
    store.apply(snapshot)
    try check(store.retryOffers.isEmpty, "second busy cannot rearm manual retry")

    store.send(a)
    store.recordResult(key: a.key, code: "busy")
    let contextRoot = PresentationChecks.replacing(snapshot.raw, "providers", .array(snapshot.providers.map { provider in
      provider.id == a.provider ? PresentationChecks.replacing(provider.payload, "accountContextId", .string("ctx_changed")) : provider.payload
    }))
    store.blockedProviders.removeAll()
    store.apply(try Snapshot.decode(JSONEncoder().encode(contextRoot)))
    try check(store.retryOffers.isEmpty && store.retryIntents.isEmpty, "account context change clears retry intent")
    store.apply(snapshot)
    store.send(a)
    store.recordResult(key: a.key, code: "busy")
    store.receiveState("Result uncertain. Review the refreshed state.", blocked: [])
    try check(store.snapshot == nil && store.retryIntents.isEmpty, "disconnect clears pending retry and authoritative data")
    store.receiveState("Connecting", blocked: [])
    try check(store.actionMessage?.hasPrefix("Result uncertain") == true, "reconnect alone does not clear uncertainty")
    store.apply(snapshot)
    try check(store.actionMessage?.hasPrefix("Fresh state received") == true, "only authoritative snapshot clears uncertainty")

    let base = try JSONDecoder().decode(JSONValue.self, from: source)
    let session = BridgeSession()
    _ = try session.receive(JSONSerialization.data(withJSONObject: ["type": "hello", "protocol": 1, "bridgeInstance": snapshot.bridgeInstance, "runtimeVersion": "test", "environmentId": "test"]))
    _ = try session.receive(source)
    let offer = session.offers.first { $0.eligible }!
    let first = try JSONDecoder().decode(JSONValue.self, from: session.command(offer))
    _ = try session.receive(JSONSerialization.data(withJSONObject: ["type": "result", "protocol": 1, "id": first["id"].string!, "ok": false, "code": "busy"]))
    try check(session.waitingForSnapshot.contains(offer.key), "transport busy blocks old offer")
    var blocked = false
    do { _ = try session.command(offer) } catch { blocked = true }
    try check(blocked, "transport refuses busy token reuse before fresh snapshot")
    let next = PresentationChecks.replacing(base, "revision", .number(snapshot.revision + 1))
    _ = try session.receive(JSONEncoder().encode(next))
    let retry = try JSONDecoder().decode(JSONValue.self, from: session.command(session.offers.first { $0.id == offer.id }!))
    try check(retry["id"] != first["id"] && retry["actionToken"] == session.offers.first { $0.id == offer.id }!.raw["actionToken"], "manual retry creates UUID and uses current offer token")
    for op in ["settings.open", "status.open", "protection.test"] {
      var fields: [String: JSONValue] = ["op": .string(op), "params": .object([:]), "eligible": .bool(true), "disabledReason": .null]
      if op == "protection.test" { fields["provider"] = .string("claude") }
      let fixed = BridgeOffer(raw: .object(fields))
      let augmentedProviders = base["providers"].array.enumerated().map { i, provider in
        i == 0 ? PresentationChecks.replacing(provider, "actions", .array(provider["actions"].array + [fixed.raw])) : provider
      }
      let augmented = PresentationChecks.replacing(base, "providers", .array(augmentedProviders))
      let fixedSession = BridgeSession()
      _ = try fixedSession.receive(JSONSerialization.data(withJSONObject: ["type": "hello", "protocol": 1, "bridgeInstance": snapshot.bridgeInstance, "runtimeVersion": "test", "environmentId": "test"]))
      _ = try fixedSession.receive(JSONEncoder().encode(augmented))
      let wire = try JSONDecoder().decode(JSONValue.self, from: fixedSession.command(fixed))
      try check(wire["actionToken"] == .null && wire["params"] == .object([:]) && UUID(uuidString: wire["id"].string!) != nil, "fixed \(op) uses empty params, no token and fresh UUID")
      var duplicateRefused = false
      do { _ = try fixedSession.command(fixed) } catch { duplicateRefused = true }
      try check(duplicateRefused, "fixed \(op) cannot send twice while pending")
      _ = fixedSession.disconnect()
      try check(fixedSession.pending.isEmpty && fixedSession.offers.isEmpty, "fixed \(op) disconnect never replays command")
    }
    try check(!ProviderPresentation(provider: snapshot.providers.first { $0.id == "claude" }!).offers.contains { $0.raw["op"].string == "failurePolicy.set" }, "policy mutation absent from display-only UI")
    try Probe(directory: options.output).write(["passed": passed, "count": passed.count], name: "desktop-checks")
  }
}
