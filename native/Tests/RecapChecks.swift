import Foundation

enum RecapChecks {
  static func input(options: Options) throws -> Snapshot {
    try Snapshot.decode(Data(contentsOf: options.fixtureDirectory.appendingPathComponent("weekly-recap.json")))
  }
  static func canaries(options: Options) throws -> [WeeklyRecap] {
    let snapshot = try input(options: options)
    let raw = snapshot.providers[0].payload["recap"]
    return [ShareModel.Provider.claude, .codex].compactMap { provider in
      var recap = PresentationChecks.replacing(raw, "id", .string("SECRET_RECAP_ID_" + provider.rawValue))
      recap = PresentationChecks.replacing(recap, "pauses", provider == .claude ? .number(27) : .null)
      recap = PresentationChecks.replacing(recap, "atReset", .bool(provider == .claude))
      recap = PresentationChecks.replacing(recap, "usedPercent", .number(provider == .claude ? 88.75 : 42.25))
      var payload = PresentationChecks.replacing(snapshot.providers[0].payload, "accountContextId", .string("ctx_SECRET_RECAP_ACCOUNT"))
      payload = PresentationChecks.replacing(payload, "label", .string("SECRET_PROVIDER_LABEL"))
      payload = PresentationChecks.replacing(payload, "recap", recap)
      return WeeklyRecap(ProviderSnapshot(id: provider.rawValue, payload: payload), generatedAtMs: snapshot.generatedAtMs, nowMs: snapshot.generatedAtMs)
    }
  }
  static func run(options: Options, resources: SpriteResources) throws {
    var passed = [String]()
    func check(_ value: Bool, _ name: String) throws {
      guard value else { throw SnapshotError.invalid("Recap check failed: " + name) }; passed.append(name)
    }
    let snapshot = try input(options: options)
    let provider = snapshot.providers[0]
    let now = snapshot.generatedAtMs
    let recap = WeeklyRecap(provider, generatedAtMs: now, nowMs: now)!
    try check(recap.caption == "Last week: 88% used, never paused, 12% to spare", "actual fixture caption uses exact backend reset facts")
    let canaries = try canaries(options: options)
    try check(canaries.count == 2 && canaries[0].caption.contains("paused 27×") && !canaries[1].caption.contains("paused") && !canaries[1].caption.contains("spare"), "unknown pause coverage and non-reset spare omitted")
    try check(!canaries[1].caption.contains(":00") && canaries[1].privateHelp.contains("% at "), "last-reading time belongs only in private help")
    let blank = RecapShareModel.build([], includeReadings: false)
    try check(blank == RecapShareModel.build(canaries, includeReadings: false), "private recap model is source-independent")
    for included in [false, true] {
      let model = RecapShareModel.build(canaries, includeReadings: included)
      let data = try JSONEncoder().encode(model)
      let raw = try JSONSerialization.jsonObject(with: data) as! [String: Any]
      let text = String(data: data, encoding: .utf8)!
      try check(Set(raw.keys) == ["mode", "readings"], "recap model top-level allowlist exact \(included)")
      try check(!text.contains("SECRET") && !text.contains("ctx_") && !text.contains(String(format: "%.0f", recap.lastReadingAtMs)) && !text.contains(String(format: "%.0f", recap.untilMs)), "no recap ID/account/label/exact time exported \(included)")
      let rows = raw["readings"] as! [[String: Any]]
      try check(rows.allSatisfy { Set($0.keys).isSubset(of: ["provider", "usedPercent", "pauses", "atReset"]) }, "recap reading enum/numeric/boolean allowlist exact \(included)")
      try check(included ? rows.count == 2 : rows.isEmpty, "recap readings require explicit inclusion \(included)")
    }
    let root = options.output.appendingPathComponent("recap-ledger-tests-" + UUID().uuidString)
    let ledger = RecapCoordinator(root: root, fixture: false)
    try check(ledger.candidate(provider, generatedAtMs: now, nowMs: now) != nil && !ledger.consume(recap, visible: false, nowMs: now), "hidden attachment never consumes recap")
    try check(!FileManager.default.fileExists(atPath: root.appendingPathComponent("native/recap-seen.json").path), "hidden attachment never writes ledger")
    try check(ledger.consume(recap, visible: true, nowMs: now) && !ledger.consume(recap, visible: true, nowMs: now), "first visible consumption occurs exactly once")
    try check(ledger.candidate(provider, generatedAtMs: now, nowMs: now) != nil, "seen caption remains in its current open session")
    ledger.clearSession()
    try check(ledger.candidate(provider, generatedAtMs: now, nowMs: now) == nil, "close/wake clear session without replay")
    let reloaded = RecapCoordinator(root: root, fixture: false)
    try check(reloaded.candidate(provider, generatedAtMs: now, nowMs: now) == nil, "seen IDs survive process reopen")
    let fixtureLedger = RecapCoordinator(root: root, fixture: true)
    try check(fixtureLedger.candidate(provider, generatedAtMs: now, nowMs: now) != nil, "fixture ledger never consumes live ledger")
    let other = ProviderSnapshot(id: provider.id, payload: PresentationChecks.replacing(provider.payload, "accountContextId", .string("ctx_OTHER_ACCOUNT")))
    let otherRecap = WeeklyRecap(other, generatedAtMs: now, nowMs: now)!
    try check(reloaded.candidate(other, generatedAtMs: now, nowMs: now) != nil && reloaded.consume(otherRecap, visible: true, nowMs: now), "same backend ID in a genuinely new account has independent first visibility")
    reloaded.clearSession()
    try check(reloaded.candidate(provider, generatedAtMs: now, nowMs: now) == nil && reloaded.candidate(other, generatedAtMs: now, nowMs: now) == nil, "switch away/back never replays either account’s seen ID")
    try check(WeeklyRecap(provider, generatedAtMs: now, nowMs: recap.untilMs) == nil && !ledger.consume(recap, visible: true, nowMs: recap.untilMs), "expired recap is neither offered nor consumed")
    let legacy = PresentationChecks.replacing(PresentationChecks.replacing(snapshot.raw["settings"], "displayStyle", .null), "actions", .array(snapshot.raw["settings"]["actions"].array.filter { $0["op"].string != "displayStyle.set" }))
    try check(DisplayPresentation(raw: legacy).style == .pear && DisplayPresentation(raw: legacy).offer(.fill) == nil, "legacy display fallback never invents filling offer")
    let unknown = DisplayPresentation(raw: PresentationChecks.replacing(legacy, "displayStyle", .string("future")))
    try check(unknown.unknown && unknown.style == .pear && unknown.offer(.usage) == nil, "unknown display style disables selector only")
    try check(StatusItemAppearance.frames.count == 9 && StatusItemAppearance.frames.allSatisfy { !$0.isTemplate }, "nine cached pixel-pear fill frames")
    try check(FillingPear(snapshot).step == Int(((FillingPear(snapshot).used ?? 0) * 8 / 100).rounded()), "fill is quantized from busiest known actual reading")
    let expiredRows = snapshot.providers.map { provider in
      ProviderSnapshot(id: provider.id, payload: PresentationChecks.replacing(provider.payload, "windows", .array(provider.windows.map { PresentationChecks.replacing($0, "freshness", .string("expired")) })))
    }
    let expired = Snapshot(revision: snapshot.revision, bridgeInstance: snapshot.bridgeInstance, generatedAtMs: now, providers: expiredRows, raw: snapshot.raw)
    try check(FillingPear(expired).step == nil && FillingPear(expired).used == nil, "expired values never fabricate a zero filling pear")
    let mixed = ProviderSnapshot(id: provider.id, payload: PresentationChecks.replacing(PresentationChecks.replacing(provider.payload, "thresholds", .array([])), "verdict", .object(["action": .string("warn")])))
    try check(CompactProvider(provider: mixed).fillTone == "grey", "weekly/daily/project verdict warnings do not color five-hour bar")
    let used = CompactProvider(provider: provider).window.used ?? 0
    for (state, expected) in [("clear", "pear"), ("crossed", "orange"), ("inactive", "grey"), ("lifted", "grey")] {
      let threshold: JSONValue = .object(["window": .string("five_hour"), "action": .string("warn"), "at": .number(min(100, used + 4)), "state": .string(state), "scope": .string("global"), "kind": .string("window"), "project": .null, "during": .null])
      let near = ProviderSnapshot(id: provider.id, payload: PresentationChecks.replacing(provider.payload, "thresholds", .array([threshold])))
      try check(CompactProvider(provider: near).fillTone == expected, "five-hour presentation near band respects backend state \(state)")
    }
    let pauseSnapshot = try Snapshot.decode(Data(contentsOf: options.fixtureDirectory.appendingPathComponent("manual-pause.json")))
    let pendingStore = FixtureStore(resources: resources, fixtureDirectory: options.fixtureDirectory, fixtureMode: false)
    pendingStore.apply(pauseSnapshot)
    if let resume = pendingStore.currentOffers.first(where: { $0.raw["op"].string == "resume" && $0.eligible }) {
      let actorPaused = pendingStore.actors.map(\.paused)
      pendingStore.send(resume)
      try check(pendingStore.resumingProviders.contains(resume.key), "Resume sets immediate pending presentation synchronously")
      try check(pendingStore.actors.map(\.paused) == actorPaused, "pending Resume never optimistically removes authoritative coffee")
      pendingStore.receiveState("Result uncertain", blocked: [])
      try check(pendingStore.resumingProviders.isEmpty, "uncertain/disconnected Resume clears spinner without replay")
    } else { try check(false, "real manual-pause fixture must offer eligible Resume") }
    for offer in snapshot.raw["settings"]["actions"].array.map({ BridgeOffer(raw: $0) }).filter({ $0.raw["op"].string == "displayStyle.set" }) {
      let session = BridgeSession()
      _ = try session.receive(JSONSerialization.data(withJSONObject: ["type": "hello", "protocol": 1, "bridgeInstance": snapshot.bridgeInstance, "runtimeVersion": "test", "environmentId": "test"]))
      _ = try session.receive(JSONEncoder().encode(snapshot.raw))
      let command = try JSONDecoder().decode(JSONValue.self, from: session.command(offer))
      try check(command["params"] == offer.raw["params"] && command["actionToken"] == offer.raw["actionToken"] && UUID(uuidString: command["id"].string!) != nil, "display style forwards actual signed offer with fresh ID")
    }
    let store = FixtureStore(resources: resources, fixtureDirectory: options.fixtureDirectory, fixtureMode: false)
    store.apply(snapshot); store.setVisible(true)
    let travel = store.actors.map(\.travel)
    store.apply(snapshot)
    try check(store.actors.allSatisfy { $0.reaction?.kind != "greet" } && travel == store.actors.map(\.travel), "recap snapshots never manufacture reset greetings")
    store.setVisible(false)
    try Probe(directory: options.output).write(["count": passed.count, "passed": passed], name: "recap-checks")
  }
}
