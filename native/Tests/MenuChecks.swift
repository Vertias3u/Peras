import AppKit

enum MenuChecks {
  static func run(options: Options, resources: SpriteResources) throws {
    var passed = [String]()
    func check(_ value: Bool, _ name: String) throws {
      guard value else { throw SnapshotError.invalid("Menu check failed: " + name) }; passed.append(name)
    }
    let source = try Data(contentsOf: options.fixtureDirectory.appendingPathComponent("suggestion-pause.json"))
    let snapshot = try Snapshot.decode(source)
    func replacing(_ value: JSONValue, _ key: String, _ next: JSONValue) -> JSONValue { PresentationChecks.replacing(value, key, next) }
    let legacy = replacing(snapshot.raw["settings"], "weeklyStyle", .null)
    try check(MenuSettings(raw: legacy).weeklyStyle == .bar, "legacy weekly true defaults to Bar")
    let off = replacing(legacy, "preferences", replacing(legacy["preferences"], "weekly", .bool(false)))
    try check(MenuSettings(raw: off).weeklyStyle == .off, "legacy weekly false maps to Off")
    for style in WeeklyStyle.allCases {
      try check(MenuSettings(raw: replacing(legacy, "weeklyStyle", .string(style.rawValue))).weeklyStyle == style, "known weekly style \(style.rawValue) renders additively")
    }
    let unknown = MenuSettings(raw: replacing(legacy, "weeklyStyle", .string("future")))
    try check(unknown.weeklyStyle == .bar && unknown.unknownStyle && unknown.offer(style: .off) == nil, "unknown weekly style keeps legacy rendering and disables only selector")
    for scale in [CGFloat(1), CGFloat(2)] {
      for usage in [0.0, 45, 100] {
        for patrol in [0.0, 0.5, 1] { for provider in ["claude", "codex"] {
          let geometry = CompactSpriteLayout.make(usage: usage, patrol: patrol, dy: 0, stretch: 0, cupLift: 0, scale: scale, provider: provider)
          try check(geometry.sprite.minX >= 0 && geometry.sprite.maxX <= 288 && geometry.cup.minX >= 0 && geometry.cup.maxX <= 288,
            "sprite/cup clamped usage\(usage) phase\(patrol) scale\(scale)")
          try check([geometry.sprite.minX, geometry.sprite.minY, geometry.sprite.width, geometry.sprite.height, geometry.cup.minX, geometry.cup.minY, geometry.cup.width, geometry.cup.height].allSatisfy { ($0 * scale).rounded() == $0 * scale }, "all geometry is backing-pixel aligned \(usage)/\(patrol)/\(scale)/\(provider)")
          try check(geometry.cupFlipped == (geometry.cup.minX >= geometry.sprite.midX), "cup handle faces its mascot \(provider) \(patrol)")
        } }
      }
    }
    for dark in [false, true] {
      for high in [false, true] {
        try check(PearPalette.contrast(PearPalette.components(dark: dark, contrast: high), background: dark ? 0.12 : 0.96) >= 3,
          "pear accent exceeds3:1 on reference panel dark\(dark) contrast\(high)")
      }
    }
    try check(PearPalette.contrast(PearPalette.segmented, background: 1) >= 4.5,
      "native white segmented labels exceed4.5:1 with dedicated pear tint")
    for background in [0.96, 0.12] {
      try check(PearPalette.contrast(PearPalette.segmented, background: background) >= 3,
        "native segmented tint exceeds3:1 against reference panel \(background)")
    }
    for provider in ["claude", "codex"] {
      let held = CompactSpriteLayout.make(usage: 50, patrol: 0.3, dy: 0, stretch: 0, cupLift: 0, scale: 2, provider: provider)
      try check(held.cupFlipped && abs(held.cup.minX - (held.sprite.minX + held.sprite.width * CompactSpriteLayout.paws(provider).right)) <= 0.5
        && held.cup.maxY <= held.sprite.maxY, "\(provider)'s cup handle meets its paw")
    }
    try check(CompactSpriteLayout.make(usage: 50, patrol: 0.3, dy: 0, stretch: 0, cupLift: 0, scale: 2, provider: "codex").sprite.width > CompactSpriteLayout.make(usage: 50, patrol: 0.3, dy: 0, stretch: 0, cupLift: 0, scale: 2).sprite.width,
      "Codex is drawn larger than its frame's default")
    let freeA = CompactSpriteLayout.make(usage: 0, patrol: 0.7, dy: 0, stretch: 0, cupLift: 0, scale: 2)
    let freeB = CompactSpriteLayout.make(usage: 100, patrol: 0.7, dy: 0, stretch: 0, cupLift: 0, scale: 2)
    try check(freeA.sprite == freeB.sprite, "decorative patrol position is independent of usage")
    let emptySteps = SetupPresentation(providers: []).steps
    try check(emptySteps.count == 5 && emptySteps[0].id == "installed" && emptySteps[0].complete && emptySteps.dropFirst().allSatisfy { !$0.complete }, "setup counts the installed app and never invents missing activation")
    var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC")!; utc.locale = Locale(identifier: "en_GB")
    let sunday = 1_900_000_000_000.0 // Sun 17 Mar 2030 17:46:40 UTC
    try check(CompactTime.lift(sunday + 3_600_000, nowMs: sunday, calendar: utc) == "today 18:46"
      && CompactTime.lift(sunday + 22_400_000, nowMs: sunday, calendar: utc) == "at midnight"
      && CompactTime.lift(sunday + 54_800_000, nowMs: sunday, calendar: utc) == "tomorrow 09:00"
      && CompactTime.lift(sunday + 3 * 86_400_000, nowMs: sunday, calendar: utc).hasSuffix(" 17:46")
      && !CompactTime.lift(sunday + 3 * 86_400_000, nowMs: sunday, calendar: utc).contains("2030"),
      "pause strip times read today/midnight/tomorrow/weekday, never a numeric date")
    var us = utc; us.locale = Locale(identifier: "en_US")
    try check(CompactTime.lift(sunday - 60_000, nowMs: sunday, calendar: utc) == "now"
      && CompactTime.lift(sunday - 3 * 86_400_000, nowMs: sunday, calendar: utc) == "now",
      "a lift time already past reads now, never a date that looks ahead")
    try check(CompactTime.lift(sunday + 3_600_000, nowMs: sunday, calendar: us).hasSuffix("PM")
      && CompactTime.lift(sunday + 22_400_000, nowMs: sunday, calendar: us) == "at midnight",
      "lift times follow a 12-hour locale")
    try check(PresentationText.number(99.96) == "100" && PresentationText.number(0.04) == "0" && PresentationText.number(45.25) == "45.3" && PresentationText.number(46) == "46",
      "percentages round to the shown tenth before choosing a format")
    let thirtyMinutes = BridgeOffer(raw: .object(["op": .string("pause"), "params": .object(["duration": .string("30m")])]))
    let untilSix = BridgeOffer(raw: .object(["op": .string("pause"), "params": .object(["duration": .string("18:00")])]))
    try check(PresentationText.action(thirtyMinutes) == "Pause for 30m" && PresentationText.action(untilSix) == "Pause Until 18:00",
      "an unfamiliar pause length is named, never mislabelled Keep Paused")
    let week = snapshot.providers[0]
    let expiredWeek = replacing(week.payload, "windows", .array(week.windows.map { $0["window"].string == "seven_day"
      ? replacing($0, "freshness", .string("expired")) : $0 }))
    let pastReset = replacing(week.payload, "windows", .array(week.windows.map { $0["window"].string == "seven_day"
      ? replacing($0, "resetsAtMs", .number(Date().timeIntervalSince1970 * 1000 - 60_000)) : $0 }))
    try check(CompactProvider(provider: ProviderSnapshot(id: week.id, payload: expiredWeek)).weeklyReset == nil
      && CompactProvider(provider: ProviderSnapshot(id: week.id, payload: pastReset)).weeklyReset == nil,
      "an expired or already-passed weekly reset shows no reset time")
    // Five-hour reset: 0.3 showed it beside the usage; the v0.4 row lost it.
    func fiveHour(_ change: (JSONValue) -> JSONValue) -> CompactProvider {
      CompactProvider(provider: ProviderSnapshot(id: week.id, payload: replacing(week.payload, "windows", .array(week.windows.map { $0["window"].string == "five_hour" ? change($0) : $0 }))), generatedAtMs: sunday)
    }
    let fixtureFive = CompactProvider(provider: week, generatedAtMs: sunday)
    try check(fixtureFive.window.resetAtMs == sunday + 7_200_000 && fixtureFive.fiveHourReset(nowMs: sunday, calendar: utc) == "resets 19:46",
      "five-hour reset later today reads its clock time: \(fixtureFive.fiveHourReset(nowMs: sunday, calendar: utc) ?? "nil")")
    try check(fixtureFive.fiveHourReset(nowMs: sunday, calendar: us).map { $0.hasPrefix("resets 7:46") && $0.hasSuffix("PM") } == true,
      "five-hour reset follows a 12-hour locale")
    let overnight = fiveHour { replacing($0, "resetsAtMs", .number(sunday + 36_000_000)) }
    try check(overnight.fiveHourReset(nowMs: sunday, calendar: utc) == "resets Mon 03:46" && overnight.fiveHourReset(nowMs: sunday, calendar: utc)?.contains("2030") == false,
      "five-hour reset on another day names the weekday, never a numeric date")
    try check(fiveHour { replacing($0, "freshness", .string("stale")) }.fiveHourReset(nowMs: sunday, calendar: utc) == "resets 19:46",
      "a stale five-hour reading still counts until its reset, so its reset shows")
    try check(fiveHour { replacing($0, "freshness", .string("expired")) }.fiveHourReset(nowMs: sunday, calendar: utc) == nil
      && fiveHour { replacing(replacing(replacing($0, "freshness", .string("missing")), "used", .null), "resetsAtMs", .null) }.fiveHourReset(nowMs: sunday, calendar: utc) == nil
      && fiveHour { replacing(replacing($0, "freshness", .string("missing")), "used", .null) }.fiveHourReset(nowMs: sunday, calendar: utc) == nil
      && fiveHour { replacing($0, "resetsAtMs", .null) }.fiveHourReset(nowMs: sunday, calendar: utc) == nil,
      "an expired or missing five-hour reading shows no current-looking reset")
    try check(fixtureFive.fiveHourReset(nowMs: sunday + 7_260_000, calendar: utc) == nil
      && fiveHour { replacing($0, "resetsAtMs", .number(Date().timeIntervalSince1970 * 1000 - 60_000)) }.fiveHourReset() == nil,
      "an already-passed five-hour reset shows nothing, on the snapshot's or the wall clock")
    try check(fixtureFive.fiveHourReset() != nil, "the fixture's five-hour reset shows on the snapshot's own clock")
    // Through the row itself (exists on the old code too): the reset is there with weekly Off.
    let offRoot = replacing(snapshot.raw, "settings", replacing(snapshot.raw["settings"], "weeklyStyle", .string("off")))
    let offSnapshot = try Snapshot.decode(JSONEncoder().encode(offRoot))
    let resetStore = FixtureStore(resources: resources, fixtureDirectory: options.fixtureDirectory, fixtureMode: false)
    resetStore.apply(offSnapshot)
    for row in offSnapshot.providers.map({ CompactProviderRow(provider: $0, store: resetStore) }) {
      try check(row.style == .off && row.trackLabel.contains("Five-hour window resets ") && row.model.fullDetails.contains(", resets "),
        "\(row.provider.id) row names its five-hour reset to VoiceOver and the tooltip with weekly Off: \(row.trackLabel)")
    }
    // VoiceOver hears details once, with single full stops, and the filling pear names a paused or warned state.
    for name in try FileManager.default.contentsOfDirectory(atPath: options.fixtureDirectory.path) where name.hasSuffix(".json") {
      guard let fixture = try? Snapshot.decode(Data(contentsOf: options.fixtureDirectory.appendingPathComponent(name))) else { continue }
      for provider in fixture.providers {
        let details = CompactProvider(provider: provider, generatedAtMs: sunday).fullDetails
        try check(!details.contains("..") && !details.contains(". ."), "\(name) \(provider.id) details have single full stops: \(details)")
      }
      let pear = FillingPear(fixture)
      try check(pear.tone != "indigo" || pear.label.hasSuffix(", paused"), "\(name) filling pear says paused: \(pear.label)")
      try check(pear.tone != "orange" || pear.label.hasSuffix(", warning line crossed"), "\(name) filling pear says warned: \(pear.label)")
    }
    // A five-hour reading older than five minutes fades its % like the rail; a current one doesn't.
    for row in offSnapshot.providers.map({ CompactProviderRow(provider: $0, store: resetStore) }) {
      try check(row.model.window.freshness != "current" || row.numberOpacity == 1, "\(row.provider.id) current % is full strength")
    }
    let staleRoot = replacing(offRoot, "providers", .array(offRoot["providers"].array.map { provider in
      replacing(provider, "windows", .array(provider["windows"].array.map { $0["window"].string == "five_hour" ? replacing($0, "freshness", .string("stale")) : $0 }))
    }))
    for provider in try Snapshot.decode(JSONEncoder().encode(staleRoot)).providers {
      let row = CompactProviderRow(provider: provider, store: resetStore)
      try check(row.model.window.freshness == "stale" && row.numberOpacity == 0.5, "\(provider.id) stale five-hour % fades")
    }
    // Only your own pause: one plain Resume, since clearing it is untimed. A rule stop keeps Resume for 1 Hour.
    let manualFixture = try Snapshot.decode(Data(contentsOf: options.fixtureDirectory.appendingPathComponent("manual-pause.json")))
    let manualRow = CompactProvider(provider: manualFixture.providers[0], generatedAtMs: sunday)
    try check(manualRow.manualOnly && manualRow.resume?.raw["params"]["duration"] == .null, "only your own pause offers plain Resume")
    let ruleRow = CompactProvider(provider: try Snapshot.decode(Data(contentsOf: options.fixtureDirectory.appendingPathComponent("daily-exhausted.json"))).providers[0], generatedAtMs: sunday)
    try check(!ruleRow.manualOnly && ruleRow.resume?.raw["params"]["duration"].string == "1h", "a rule stop keeps Resume for 1 Hour")
    // The setup card names the agent it can't pause yet when another is protected.
    let oneWaiting = offSnapshot.providers.enumerated().map { index, provider in
      index == 1 ? replacing(provider.payload, "health", replacing(provider.payload["health"], "state", .string("needs_activation"))) : provider.payload
    }
    let waitingRoot = replacing(offRoot, "providers", .array(oneWaiting))
    let waiting = try Snapshot.decode(JSONEncoder().encode(waitingRoot))
    let caption = SetupPresentation(providers: waiting.providers).caption
    try check(waiting.providers.count == 2 && caption == "Until then, Peras can’t pause " + waiting.providers[1].label + ".", "setup card names the agent it can't pause yet: \(caption)")
    // An agent idle for 15 minutes ("unverified": a live guard seen for these hooks, not recently) doesn't reopen setup.
    let idleRoot = replacing(offRoot, "providers", .array(offSnapshot.providers.map { replacing($0.payload, "health", replacing($0.payload["health"], "state", .string("unverified"))) }))
    let idle = try Snapshot.decode(JSONEncoder().encode(idleRoot))
    try check(SetupPresentation(providers: idle.providers).unfinished.isEmpty && idle.providers.allSatisfy { !CompactProvider(provider: $0).needsHealth },
      "idle agents keep setup complete and show no health card")
    try check(!SetupPresentation(providers: waiting.providers).unfinished.isEmpty, "an agent never seen live still needs setup")
    let dailyStop = CompactProvider(provider: try Snapshot.decode(Data(contentsOf: options.fixtureDirectory.appendingPathComponent("daily-exhausted.json"))).providers[0], generatedAtMs: sunday)
    try check(dailyStop.detail.hasPrefix("Today’s allowance is used up (") && !dailyStop.detail.contains("observed") && dailyStop.detail.contains("Lifts "),
      "daily stop strip says what happened in plain words: \(dailyStop.detail)")
    try check(PearPalette.contrast(PearPalette.buttonLabel, PearPalette.buttonFill) >= 7 && PearPalette.contrast(PearPalette.buttonLabel, PearPalette.buttonFillHigh) >= 4.5,
      "pear button label stays readable on its fill")
    let cleanSetup = try Snapshot.decode(Data(contentsOf: options.fixtureDirectory.appendingPathComponent("missing-setup.json")))
    let cleanInstructions = SetupPresentation(providers: cleanSetup.providers).steps[1].detail
    try check(cleanInstructions.contains("Run peras setup for Claude Code.") && cleanInstructions.contains("Run peras codex setup for Codex."), "actual clean two-provider fixture names both setup commands")
    func setupProvider(_ id: String, hooks: String, current: Bool, next: String?) -> ProviderSnapshot {
      let source = snapshot.providers.first { $0.id == id }!
      return ProviderSnapshot(id: id, payload: replacing(source.payload, "setup", .object([
        "hooks": .string(hooks), "current": .bool(current), "next": next.map(JSONValue.string) ?? .null,
      ])))
    }
    let claudeMissing = setupProvider("claude", hooks: "missing", current: false, next: "run_setup")
    let codexMissing = setupProvider("codex", hooks: "missing", current: false, next: "run_setup")
    let claudeCurrent = setupProvider("claude", hooks: "configured", current: true, next: "restart")
    let codexCurrent = setupProvider("codex", hooks: "configured", current: true, next: "trust_and_restart")
    let claudeOnly = SetupPresentation(providers: [claudeMissing]).steps[1].detail
    let codexOnly = SetupPresentation(providers: [codexMissing]).steps[1].detail
    try check(claudeOnly.contains("peras setup") && !claudeOnly.contains("peras codex setup"), "Claude-only setup never suggests installing Codex")
    try check(codexOnly.contains("peras codex setup") && !codexOnly.contains("Run peras setup"), "Codex-only setup never substitutes Claude setup")
    for id in ["claude", "codex"] {
      let outdated = setupProvider(id, hooks: "configured", current: false, next: "update_hooks")
      let other = id == "claude" ? codexCurrent : claudeCurrent
      let detail = SetupPresentation(providers: [other, outdated]).steps[1].detail
      try check(detail == (id == "claude" ? "Run peras setup for Claude Code." : "Run peras codex setup for Codex."), "only outdated \(id) gets its actual setup command")
    }
    let configuredSteps = SetupPresentation(providers: [claudeCurrent, codexCurrent]).steps
    try check(configuredSteps[1].complete && !configuredSteps[1].detail.contains("Run peras"), "installed current hooks do not request reinstall for pending activation")
    for id in ["claude", "codex"] {
      let model = SetupPresentation(providers: [setupProvider(id, hooks: "disabled", current: false, next: "enable_hooks")]).steps[1]
      try check(!model.complete && model.title == "Enable Peras hooks" && !model.detail.contains("setup")
        && model.detail.contains(id == "claude" ? "disableAllHooks" : "config.toml")
        && model.detail.contains(id == "claude" ? "peras doctor" : "peras codex doctor"), "disabled \(id) hooks explain settings and supported doctor without claiming setup enables them")
    }
    let missing = CompactSpriteLayout.make(usage: nil, patrol: 1, dy: 0, stretch: 0, cupLift: 0, scale: 2)
    try check(missing.sprite.minX == 0, "missing reading waits at start without fabricated fill")
    let futureRoot = replacing(snapshot.raw, "settings", replacing(snapshot.raw["settings"], "weeklyStyle", .string("future")))
    try check((try? Snapshot.decode(JSONEncoder().encode(futureRoot))) != nil, "unknown additive weekly style does not reject the core snapshot")
    var brokenCore = snapshot.providers.map(\.payload)
    brokenCore[0] = replacing(brokenCore[0], "verdict", .object(["action": .string("future_core_verdict")]))
    try check((try? Snapshot.decode(JSONEncoder().encode(replacing(futureRoot, "providers", .array(brokenCore))))) == nil, "core verdict enum stays strict with unknown presentation style")
    let current = snapshot.providers[0]
    let oldActive = ProviderSnapshot(id: current.id, payload: replacing(current.payload, "setup", .object(["hooks": .string("configured"), "current": .bool(false), "next": .string("update_hooks") ])))
    try check(!SetupPresentation(providers: [oldActive]).unfinished.isEmpty, "old active guard does not hide outdated runtime setup")
    try check(SetupPresentation(providers: [oldActive]).steps.first { $0.id.hasSuffix("-active") }?.complete == (oldActive.payload["health"]["state"].string == "active"), "activation is reported only from actual live guard health")
    for (value, expected) in [("within", "within today’s plan"), ("reached", "today’s share used"), ("future", "")] {
      let meter: JSONValue = .object(["kind": .string("pacing"), "project": .null, "expectedByTonightPercent": .number(42), "pace": .string(value), "waitingForReading": .bool(false)])
      let payload = replacing(current.payload, "planning", .object(["meters": .array([meter])]))
      let model = CompactProvider(provider: ProviderSnapshot(id: current.id, payload: payload))
      try check((model.paceText ?? "") == expected && model.paceTarget == 42, "backend pace \(value) uses agreed copy without inferred ahead/behind")
      let staleWindows = payload["windows"].array.map { row in row["window"].string == "seven_day" ? replacing(row, "freshness", .string("stale")) : row }
      let staleModel = CompactProvider(provider: ProviderSnapshot(id: current.id, payload: replacing(payload, "windows", .array(staleWindows))))
      try check(staleModel.paceTarget == nil && staleModel.paceText == nil, "stale weekly reading omits numeric pace target and status")
    }
    let nonWorkingPayload = replacing(current.payload, "planning", .object(["meters": .array([.object(["kind": .string("pacing"), "project": .null, "workday": .bool(false), "expectedByTonightPercent": .null, "pace": .string("within")])])]))
    try check(CompactProvider(provider: ProviderSnapshot(id: current.id, payload: nonWorkingPayload)).paceText == "not a working day", "non-working day uses explicit backend workday fact")
    let nullPacePayload = replacing(current.payload, "planning", .object(["meters": .array([.object(["kind": .string("pacing"), "project": .null, "expectedByTonightPercent": .null, "pace": .null])])]))
    try check(CompactProvider(provider: ProviderSnapshot(id: current.id, payload: nullPacePayload)).paceTarget == nil, "null target never creates a pace tick")
    try check(!StatusItemAppearance.pear.isTemplate && StatusItemAppearance.pear.size == NSSize(width: 11, height: 14)
      && StatusItemAppearance.pearPixels.flatMap(\.rects).count == 11, "status pear is 0.3's coloured pixel pear, one point per pixel")
    try check(StatusItemAppearance.filledRows(0) == 0 && StatusItemAppearance.filledRows(8) == 11 && StatusItemAppearance.filledRows(4) == 6,
      "filling pear colours whole pixel rows of the body")
    try check(StatusItemAppearance.frame(3, tone: "indigo") !== StatusItemAppearance.frame(3, tone: nil)
      && StatusItemAppearance.frame(3, tone: "indigo") === StatusItemAppearance.frame(3, tone: "indigo"), "toned fill frames are cached separately")
    let runningPause = BridgeOffer(raw: .object(["op": .string("pause"), "params": .object(["duration": .null])]))
    try check(PresentationText.action(runningPause, stopped: false) == "Pause Until Resumed" && PresentationText.action(runningPause) == "Keep Paused",
      "a running agent's pause reads Pause Until Resumed; a stopped one's reads Keep Paused")
    if let running = snapshot.providers.first(where: { !["pause", "ask"].contains(CompactProvider(provider: $0).presentation.verdict) }) {
      let titles = CompactProvider(provider: running).presentation.offers.filter { $0.raw["op"].string == "pause" }.map { PresentationText.action($0, stopped: false) }
      try check(titles.sorted() == ["Pause Until Resumed", "Pause for 1 Hour"].sorted(), "a running agent offers both pauses from the header menu")
    }
    // The bridge's real row shape: no impact field, a rolling token and a minute-rounded expiry.
    func row(token: String, expires: Double, eligible: Bool = true, lifts: [String]? = nil) -> BridgeOffer {
      var fields: [String: JSONValue] = ["provider": .string("claude"), "op": .string("pause"), "params": .object(["duration": .string("1h")]),
        "eligible": .bool(eligible), "disabledReason": .null, "actionToken": .string(token), "expiresAtMs": .number(expires)]
      if let lifts { fields["lifts"] = .array(lifts.map(JSONValue.string)) }
      return BridgeOffer(raw: .object(fields))
    }
    let timedPause = row(token: "old", expires: 1_000), refreshed = row(token: "new", expires: 61_000)
    try check(FixtureStore.reviewed(timedPause) == FixtureStore.reviewed(refreshed)
      && FixtureStore.reviewed(timedPause) != FixtureStore.reviewed(row(token: "new", expires: 61_000, eligible: false))
      && FixtureStore.reviewed(timedPause) != FixtureStore.reviewed(row(token: "new", expires: 61_000, lifts: ["rsn_a"])),
      "a menu choice resends the offer with its new token and expiry, never one whose shown fields changed")
    let session = BridgeSession()
    _ = try session.receive(JSONSerialization.data(withJSONObject: ["type": "hello", "protocol": 1, "bridgeInstance": snapshot.bridgeInstance, "runtimeVersion": "test", "environmentId": "test"]))
    _ = try session.receive(source)
    let links = DiscoveryLink.rows(snapshot)
    let command = try JSONDecoder().decode(JSONValue.self, from: session.linkCommand(links[0].id))
    try check(command["actionToken"] == .null && command["params"] == .object(["id": .string(links[0].id)]) && UUID(uuidString: command["id"].string!) != nil, "link sends only current declared ID and fresh UUID, no URL or token")
    _ = try session.receive(JSONSerialization.data(withJSONObject: ["type": "result", "protocol": 1, "id": command["id"].string!, "ok": true]))
    try check(session.pending.isEmpty && session.waitingForSnapshot.isEmpty, "read-only link ACK releases global slot without impossible changed snapshot")
    let second = try JSONDecoder().decode(JSONValue.self, from: session.linkCommand(links[0].id))
    try check(second["id"] != command["id"], "every deliberate link click creates a distinct command ID")
    _ = session.disconnect()
    try check(session.pending.isEmpty && session.snapshot == nil, "link commands never replay on reconnect")
    for op in ["settings.open", "status.open"] {
      let fixed = BridgeOffer(raw: .object(["op": .string(op), "params": .object([:]), "eligible": .bool(true)]))
      var providerRows = snapshot.providers.map(\.payload)
      providerRows[0] = replacing(providerRows[0], "actions", .array(providerRows[0]["actions"].array + [fixed.raw]))
      let fixedSource = try JSONEncoder().encode(replacing(snapshot.raw, "providers", .array(providerRows)))
      let fixedSession = BridgeSession()
      _ = try fixedSession.receive(JSONSerialization.data(withJSONObject: ["type": "hello", "protocol": 1, "bridgeInstance": snapshot.bridgeInstance, "runtimeVersion": "test", "environmentId": "test"]))
      _ = try fixedSession.receive(fixedSource)
      let fixedWire = try JSONDecoder().decode(JSONValue.self, from: fixedSession.command(fixed))
      _ = try fixedSession.receive(JSONSerialization.data(withJSONObject: ["type": "result", "protocol": 1, "id": fixedWire["id"].string!, "ok": true]))
      try check(fixedSession.pending.isEmpty && fixedSession.waitingForSnapshot.isEmpty, "\(op) ACK releases slot without needing changed snapshot")
      var rejected = false
      do { _ = try fixedSession.linkCommand("https://unoffered.example/path") } catch { rejected = true }
      try check(rejected, "typed link rejects a URL rather than a current declared ID")
    }
    let nested = BridgeOffer(raw: snapshot.raw["discovery"]["suggestion"]["dismiss"])
    let dismissSession = BridgeSession()
    _ = try dismissSession.receive(JSONSerialization.data(withJSONObject: ["type": "hello", "protocol": 1, "bridgeInstance": snapshot.bridgeInstance, "runtimeVersion": "test", "environmentId": "test"]))
    _ = try dismissSession.receive(source)
    let dismissWire = try JSONDecoder().decode(JSONValue.self, from: dismissSession.command(nested))
    try check(dismissWire["actionToken"] == nested.raw["actionToken"] && dismissWire["params"] == nested.raw["params"], "nested signed dismiss forwards exact current token and params")
    _ = try dismissSession.receive(JSONSerialization.data(withJSONObject: ["type": "result", "protocol": 1, "id": dismissWire["id"].string!, "ok": true]))
    try check(dismissSession.waitingForSnapshot.contains("global"), "dismiss mutation still waits for fresh authoritative snapshot")
    for offer in snapshot.raw["settings"]["actions"].array.map({ BridgeOffer(raw: $0) }).filter({ $0.raw["op"].string == "weeklyStyle.set" }) {
      let styleSession = BridgeSession()
      _ = try styleSession.receive(JSONSerialization.data(withJSONObject: ["type": "hello", "protocol": 1, "bridgeInstance": snapshot.bridgeInstance, "runtimeVersion": "test", "environmentId": "test"]))
      _ = try styleSession.receive(source)
      let wire = try JSONDecoder().decode(JSONValue.self, from: styleSession.command(offer))
      try check(wire["params"] == offer.raw["params"] && wire["actionToken"] == offer.raw["actionToken"] && UUID(uuidString: wire["id"].string!) != nil, "weekly style mutation forwards exact offered params/token with fresh UUID")
      _ = try styleSession.receive(JSONSerialization.data(withJSONObject: ["type": "result", "protocol": 1, "id": wire["id"].string!, "ok": true]))
      try check(styleSession.waitingForSnapshot.contains("global"), "weekly style ACK waits for authoritative style update")
    }
    let store = FixtureStore(resources: resources, fixtureDirectory: options.fixtureDirectory, fixtureMode: false)
    store.apply(snapshot)
    try check(store.currentOffers.contains(nested), "busy retry enumeration includes actual nested dismiss offer")
    let readinessStore = FixtureStore(resources: resources, fixtureDirectory: options.fixtureDirectory, fixtureMode: false)
    let phaseBefore = readinessStore.actors.map(\.travel)
    for (freshness, expected) in [("current", Double(32)), ("stale", Double(32)), ("expired", nil), ("missing", nil)] {
      var rows = snapshot.providers.map(\.payload)
      let windows = rows[0]["windows"].array.map { row -> JSONValue in
        guard row["window"].string == "five_hour" else { return row }
        return replacing(replacing(row, "freshness", .string(freshness)), "used", freshness == "missing" ? .null : .number(32))
      }
      rows[0] = replacing(rows[0], "windows", .array(windows))
      let readingSnapshot = try Snapshot.decode(JSONEncoder().encode(replacing(snapshot.raw, "providers", .array(rows))))
      readinessStore.apply(readingSnapshot)
      try check(readinessStore.fiveHourUsed(for: "claude") == expected && readinessStore.hasReading(readinessStore.actors[0]) == (expected != nil),
        "snapshot scalar readiness preserves \(freshness) semantics")
    }
    readinessStore.receiveState("Disconnected", blocked: [])
    try check(readinessStore.fiveHourUsed(for: "claude") == nil && !readinessStore.hasReading(readinessStore.actors[0]), "disconnect invalidates cached readiness")
    readinessStore.apply(snapshot)
    try check(readinessStore.fiveHourUsed(for: "claude") == CompactProvider(provider: snapshot.providers[0]).window.used,
      "fresh authoritative snapshot restores exact cached reading")
    try check(readinessStore.actors.map(\.travel) == phaseBefore, "readiness cache transitions retain actor phase")
    try check(SettingsPresentation.statusTitle(snapshot).contains("🍐") == false, "status title relies on separate monochrome template pear")
    try Probe(directory: options.output).write(["count": passed.count, "passed": passed], name: "menu-checks")
  }
}
