import Foundation

enum PresentationChecks {
  static let canaries = [
    "SECRET_ACCOUNT_LABEL", "SECRET_PROFILE_NAME", "SECRET_PROJECT_NAME", "/private/SECRET_PATH",
    "SECRET_ACTION_TOKEN", "ctx_SECRET_CONTEXT", "SECRET_ADDITIVE_VALUE",
  ]
  static func replacing(_ value: JSONValue, _ key: String, _ next: JSONValue) -> JSONValue {
    guard case .object(var object) = value else { return value }
    object[key] = next
    return .object(object)
  }
  static func canarySnapshot(fixtures: URL) throws -> Snapshot {
    let data = try Data(contentsOf: fixtures.appendingPathComponent("normal-usage.json"))
    var root = try JSONDecoder().decode(JSONValue.self, from: data)
    let providers = root["providers"].array.map { provider -> JSONValue in
      var result = replacing(provider, "label", .string(canaries[0]))
      result = replacing(result, "accountContextId", .string(canaries[5]))
      result = replacing(
        result, "profiles",
        .object([
          "names": .array([.string(canaries[1])]), "active": .string(canaries[1]),
          "modified": .bool(true),
        ]))
      result = replacing(
        result, "reasons",
        .array([
          .object([
            "id": .string("SECRET_REASON_ID"), "kind": .string("window"),
            "action": .string("pause"), "scope": .string("project"),
            "project": .object(["id": .string("SECRET_PROJECT_ID"), "label": .string(canaries[2])]),
            "expiresAtMs": .number(2_500_123_456_789),
          ])
        ]))
      result = replacing(
        result, "windows",
        .array(
          provider["windows"].array.map { row in
            replacing(
              replacing(row, "seenAtMs", .number(2_400_123_456_789)), "resetsAtMs",
              .number(2_500_123_456_789))
          }))
      result = replacing(
        result, "actions",
        .array(
          provider["actions"].array.map { action in
            replacing(
              replacing(action, "actionToken", .string(canaries[4])), "privatePath",
              .string(canaries[3]))
          }))
      return replacing(result, "additive", .object(["secret": .string(canaries[6])]))
    }
    root = replacing(
      replacing(root, "providers", .array(providers)), "privatePath", .string(canaries[3]))
    return try Snapshot.decode(JSONEncoder().encode(root))
  }
  static func run(options: Options) throws {
    var checks = [String]()
    func check(_ condition: Bool, _ text: String) throws {
      guard condition else { throw SnapshotError.invalid("Presentation check failed: " + text) }
      checks.append(text)
    }
    func fixture(_ name: String) throws -> Snapshot {
      try Snapshot.decode(
        Data(contentsOf: options.fixtureDirectory.appendingPathComponent(name + ".json")))
    }
    let scoped = try fixture("scoped-stop")
    let project = ProviderPresentation(provider: scoped.providers.first { $0.id == "claude" }!)
    try check(
      project.projectOnly && project.status == "Project stop",
      "project-only stop is never provider-wide")
    try check(
      project.reasons[0].values?.contains("48%") == true
        && project.reasons[0].values?.contains("40%") == true,
      "project reason exposes observed usage and its own line")
    let weekly = ConfiguredThreshold.rows(project.provider, window: "seven_day")
    try check(
      weekly.map(\.value) == [75, 90] && !weekly.contains { $0.value == 40 },
      "project 40 percent stop never becomes a global marker")
    let daily = ProviderPresentation(provider: try fixture("daily-exhausted").providers[0])
    try check(
      daily.reasons[0].values?.contains("12 points") == true
        && daily.reasons[0].values?.contains("10 points") == true
        && daily.reasons[0].values?.contains("%") == false,
      "daily spent and limit use points, not weekly percentages")
    let expired = WindowPresentation(
      .object(["used": .number(99), "freshness": .string("expired")]), window: "seven_day")
    try check(
      expired.used == nil && !expired.valueText.contains("99"),
      "expired reading cannot appear as current fill or percentage")
    let missing = WindowPresentation(
      .object(["freshness": .string("missing")]), window: "five_hour")
    try check(
      missing.used == nil && missing.valueText == "Not reported",
      "missing window has no invented reading")
    var conditionalProvider = project.provider.payload
    let conditional = JSONValue.object([
      "window": .string("seven_day"), "at": .number(80), "action": .string("ask"),
      "during": .object(["days": .array([.string("mon")])]),
    ])
    let badScoped = replacing(conditional, "scope", .string("project"))
    conditionalProvider = replacing(
      conditionalProvider, "thresholds", .array([conditional, badScoped]))
    let markers = ConfiguredThreshold.rows(
      ProviderSnapshot(id: "claude", payload: conditionalProvider), window: "seven_day")
    try check(
      markers.count == 1 && markers[0].conditional
        && markers[0].label.contains("conditional/scheduled"),
      "configured scheduled marker is conditional, never evaluated in Swift")
    let emptyDay = PlanningPresentation(
      raw: .object(["limit": .number(0), "spent": .number(0), "workday": .bool(false)]), index: 0)
    try check(
      emptyDay.summary.contains("Non-working") && !emptyDay.summary.contains("0/0"),
      "non-working zero allocation is not a 0/0 fraction")
    let resume = BridgeOffer(
      raw: .object([
        "op": .string("resume"), "expiresAtMs": .number(120000),
        "extends": .array([.object(["reason": .string("unreported"), "untilMs": .number(300000)])]),
      ]))
    let resumeImpact = project.impact(resume)
    try check(
      resumeImpact.first?.contains("Provider-wide") == true
        && resumeImpact.last?.contains(
          "replaces previous bypass expiry " + PresentationText.expiry(.number(300000)) + " with "
            + PresentationText.expiry(.number(120000))) == true,
      "resume describes prior-to-offered expiry replacement, including shortening")
    let extra = BridgeOffer(
      raw: .object(["op": .string("extra.daily"), "expiresAtMs": .number(2000)]))
    try check(
      daily.impact(extra).first?.contains("each matching global daily meter") == true
        && daily.impact(extra).first?.contains("unrelated stops remain") == true,
      "daily extra covers matching meters without promising to clear unrelated stops")
    let normal = try fixture("normal-usage")
    let settings = SettingsPresentation(raw: normal.raw["settings"])
    try check(
      settings.offers.filter { ["preference.set", "display.set"].contains($0.raw["op"].string ?? "") }.count == 8
        && settings.offers.filter { $0.raw["op"].string == "weeklyStyle.set" }.count == (normal.raw["settings"]["weeklyStyle"].string == nil ? 0 : 2)
        && settings.mascots && settings.weekly,
      "actual fixture exposes settings offers and current display preferences")
    try check(
      settings.label(settings.offers[0]) == "Show mascots: on → off"
        && settings.label(settings.offers[2]).contains("notifications"),
      "settings labels distinguish display from notifications and show offered next value")
    let settingsSession = BridgeSession()
    let hello = JSONValue.object([
      "type": .string("hello"), "protocol": .number(1),
      "bridgeInstance": .string(normal.bridgeInstance), "runtimeVersion": .string("test"),
      "environmentId": .string("test"),
    ])
    _ = try settingsSession.receive(JSONEncoder().encode(hello))
    _ = try settingsSession.receive(JSONEncoder().encode(normal.raw))
    var previousID: String?
    for offer in settings.offers {
      let command = try JSONDecoder().decode(JSONValue.self, from: settingsSession.command(offer))
      try check(
        command["actionToken"] == offer.raw["actionToken"]
          && command["params"] == offer.raw["params"]
          && command["id"].string != previousID && settingsSession.pending["global"] != nil,
        "settings command preserves exact offered token/params with fresh ID and global pending slot"
      )
      var concurrentRefused = false
      do { _ = try settingsSession.command(offer) } catch { concurrentRefused = true }
      try check(concurrentRefused, "one global settings mutation remains in flight at a time")
      previousID = command["id"].string
      let uncertain = settingsSession.disconnect()
      try check(
        uncertain == ["global"] && settingsSession.pending.isEmpty
          && settingsSession.offers.isEmpty,
        "settings disconnect forgets uncertain command and never replays its offer")
      _ = try settingsSession.receive(JSONEncoder().encode(hello))
      _ = try settingsSession.receive(JSONEncoder().encode(normal.raw))
    }
    for modified in [
      replacing(settings.offers[0].raw, "eligible", .bool(false)),
      replacing(settings.offers[0].raw, "actionToken", .string("not-the-offered-token")),
    ] {
      var refused = false
      do { _ = try settingsSession.command(BridgeOffer(raw: modified)) } catch { refused = true }
      try check(
        refused && settingsSession.pending.isEmpty,
        "disabled or modified settings offer cannot dispatch or enter pending")
    }
    let resources = try SpriteResources(directory: Bundle.main.resourceURL!)
    let preferenceStore = FixtureStore(
      resources: resources, fixtureDirectory: options.fixtureDirectory, fixtureMode: false)
    preferenceStore.apply(normal)
    preferenceStore.setVisible(true)
    let travel = preferenceStore.actors.map(\.travel)
    let hiddenPreferences = replacing(
      normal.raw["settings"]["preferences"], "mascots", .bool(false))
    let hiddenSettings = replacing(
      replacing(normal.raw["settings"], "preferences", hiddenPreferences), "display",
      .string("pear"))
    let hidden = try Snapshot.decode(
      JSONEncoder().encode(replacing(normal.raw, "settings", hiddenSettings)))
    preferenceStore.apply(hidden)
    let ticks = preferenceStore.ticks
    _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
    try check(
      !preferenceStore.mascotsEnabled && preferenceStore.timer == nil
        && preferenceStore.ticks == ticks && preferenceStore.actors.map(\.travel) == travel,
      "authoritative mascots off stops ticks while retaining actual patrol phase")
    preferenceStore.apply(normal)
    try check(
      preferenceStore.mascotsEnabled && preferenceStore.actors.map(\.travel) == travel,
      "mascots on restores the retained patrol phase without a greeting backlog")
    preferenceStore.setVisible(false)
    let noWeekSettings = replacing(
      normal.raw["settings"], "preferences",
      replacing(normal.raw["settings"]["preferences"], "weekly", .bool(false)))
    let noWeek = try Snapshot.decode(
      JSONEncoder().encode(replacing(normal.raw, "settings", noWeekSettings)))
    preferenceStore.apply(noWeek)
    try check(
      !preferenceStore.weeklyEnabled
        && preferenceStore.snapshot?.providers.count == normal.providers.count,
      "weekly preference changes presentation without dropping stop or planning provider data")
    try check(
      SettingsPresentation.statusTitle(normal).contains("%")
        && SettingsPresentation.statusTitle(hidden).isEmpty,
      "status title follows authoritative usage versus pear display")
    let input = try canarySnapshot(fixtures: options.fixtureDirectory)
    let privateModel = ShareModel.build(input, includeReadings: false)
    let optIn = ShareModel.build(input, includeReadings: true)
    try check(
      privateModel == ShareModel.build(nil, includeReadings: false)
        && privateModel.readings.isEmpty, "private model independent of all source snapshot values")
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    for (name, model) in [("private", privateModel), ("opt-in", optIn)] {
      let data = try encoder.encode(model)
      let text = String(data: data, encoding: .utf8)!
      try check(
        canaries.allSatisfy { !text.contains($0) } && !text.contains("2500123456789")
          && !text.contains("2400123456789"),
        name + " model excludes labels, IDs, paths, tokens, timestamps and additive fields")
      let object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
      try check(
        Set(object.keys) == Set(["mode", "readings"]),
        name + " export has only allowlisted root fields")
      for row in object["readings"] as! [[String: Any]] {
        try check(
          Set(row.keys).isSubset(of: Set(["provider", "window", "freshness", "used"])),
          "opt-in reading has no private or arbitrary fields")
      }
    }
    try check(
      optIn.readings.count == 4 && optIn.readings.allSatisfy { $0.used != nil },
      "opt-in includes only enum providers/windows, finite numeric usage and freshness")
    try check(
      ShareModel.motto == "spend the last of your week on purpose"
        && ShareModel.canonicalURL == "https://peras.vertias.eu",
      "share copy and canonical URL fixed")
    // Confirmed resets require a new current reading across a previous window's end.
    func resetSnapshot(_ bridge: String, reset: Double, seen: Double, context: String = "first")
      -> Snapshot
    {
      let p = ProviderSnapshot(
        id: "claude",
        payload: .object([
          "accountContextId": .string(context),
          "windows": .array([
            .object([
              "window": .string("five_hour"), "freshness": .string("current"),
              "resetsAtMs": .number(reset), "seenAtMs": .number(seen),
            ])
          ]),
        ]))
      return Snapshot(
        revision: 1, bridgeInstance: bridge, generatedAtMs: seen, providers: [p], raw: .null)
    }
    var tracker = WindowResetTracker()
    try check(
      tracker.consume(resetSnapshot("a", reset: 1000, seen: 900), visible: true).isEmpty,
      "initial current reading never greets")
    try check(
      tracker.consume(resetSnapshot("a", reset: 2000, seen: 999), visible: true).isEmpty,
      "changed reset prediction before previous end cannot greet")
    // Reset the baseline for a separately confirmed transition.
    tracker = WindowResetTracker()
    _ = tracker.consume(resetSnapshot("a", reset: 1000, seen: 900), visible: true)
    try check(
      tracker.consume(resetSnapshot("a", reset: 2000, seen: 1100), visible: true)["claude"] != nil,
      "post-end current reading confirms a new reported window")
    try check(
      tracker.consume(resetSnapshot("b", reset: 3000, seen: 2100), visible: true).isEmpty,
      "reconnect identity never queues a greeting")
    tracker = WindowResetTracker()
    _ = tracker.consume(resetSnapshot("a", reset: 1000, seen: 900), visible: true)
    try check(
      tracker.consume(resetSnapshot("a", reset: 2000, seen: 1100, context: "other"), visible: true)
        .isEmpty,
      "same-bridge account context change establishes a new baseline without greeting")
    try check(
      tracker.consume(resetSnapshot("a", reset: 3000, seen: 2100, context: "other"), visible: true)[
        "claude"] != nil,
      "new account context can greet only after its own observed transition")
    tracker.hidden()
    _ = tracker.consume(resetSnapshot("b", reset: 4000, seen: 3100), visible: false)
    try check(
      tracker.consume(resetSnapshot("b", reset: 5000, seen: 4100), visible: true).isEmpty,
      "hidden and wake backlog is dropped")
    try Probe(directory: options.output).write(
      ["checks": checks, "clipboardWrites": 0, "canaryCount": canaries.count],
      name: "presentation-checks")
    print("Native presentation/share checks passed: \(checks.count)")
  }
}
