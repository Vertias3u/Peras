import Darwin
import Foundation

// All spawned children use the mandatory scratch runtime and its fake Codex PATH.
enum BridgeChecks {
  static func run(options: Options) throws {
    // Independent of the main run loop and bridge queue: a cleanup regression must
    // fail this test process instead of hanging the entire caller indefinitely.
    let suiteWatchdog = DispatchWorkItem {
      fputs("Native bridge checks exceeded their 90-second watchdog\n", stderr)
      _exit(75)
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + 90, execute: suiteWatchdog)
    defer { suiteWatchdog.cancel() }

    let output = options.output.appendingPathComponent("bridge-checks")
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    let source = try Data(
      contentsOf: options.fixtureDirectory.appendingPathComponent("normal-usage.json"))
    let base = try JSONDecoder().decode(JSONValue.self, from: source)
    var passed = [String]()
    func check(_ value: Bool, _ name: String) throws {
      guard value else { throw SnapshotError.invalid("Bridge check failed: " + name) }
      passed.append(name)
    }
    func encode(_ value: JSONValue) throws -> Data { try JSONEncoder().encode(value) }
    func changing(_ value: JSONValue, _ key: String, _ next: JSONValue) -> JSONValue {
      guard case .object(var object) = value else { return value }
      object[key] = next
      return .object(object)
    }
    func snapshot(_ revision: Double, identity: String? = nil) throws -> Data {
      var value = changing(base, "revision", .number(revision))
      if let identity { value = changing(value, "bridgeInstance", .string(identity)) }
      return try encode(value)
    }
    func hello(_ identity: String, protocol version: Int = 1) throws -> Data {
      try JSONSerialization.data(withJSONObject: [
        "type": "hello", "protocol": version, "bridgeInstance": identity, "runtimeVersion": "test",
        "environmentId": "env_test",
      ])
    }
    func rejects(_ body: () throws -> Void) -> Bool {
      do {
        try body()
        return false
      } catch { return true }
    }
    let identity = base["bridgeInstance"].string!
    let session = BridgeSession()
    try check(rejects { _ = try session.receive(source) }, "snapshot before hello rejected")
    try check(
      rejects { _ = try session.receive(hello(identity, protocol: 2)) },
      "wrong hello protocol rejected")
    _ = try session.receive(hello(identity))
    _ = try session.receive(source)
    let offer = session.offers.first {
      $0.provider == "claude" && $0.raw["op"].string == "pause" && $0.eligible
    }!
    let command = try session.command(offer)
    let decoded = try JSONDecoder().decode(JSONValue.self, from: command)
    let id = decoded["id"].string!
    try check(
      UUID(uuidString: id) != nil && decoded["actionToken"] == offer.raw["actionToken"]
        && decoded["params"] == offer.raw["params"], "unique UUID and exact offered params/token")
    try check(rejects { _ = try session.command(offer) }, "one pending command per provider")
    _ = try session.receive(snapshot(2))
    _ = try session.receive(
      JSONSerialization.data(withJSONObject: [
        "type": "result", "protocol": 1, "id": id, "ok": true,
      ]))
    try check(
      session.waitingForSnapshot.contains("claude"),
      "snapshot before acknowledgement cannot confirm mutation")
    try check(
      rejects { _ = try session.command(offer) }, "acknowledged mutation awaits subsequent snapshot"
    )
    _ = try session.receive(snapshot(3))
    try check(
      !session.waitingForSnapshot.contains("claude"), "subsequent snapshot restores reviewed offers"
    )
    let nextCommand = try JSONDecoder().decode(
      JSONValue.self, from: session.command(session.offers.first { $0.raw == offer.raw }!))
    try check(nextCommand["id"].string != id, "each click gets a new UUID")
    _ = try session.receive(snapshot(2))
    try check(session.revision == 3, "stale snapshot ignored")
    try check(
      rejects { _ = try session.receive(snapshot(4, identity: "another-bridge")) },
      "wrong bridge snapshot rejected")
    try check(
      session.disconnect() == ["claude"] && session.pending.isEmpty && session.offers.isEmpty,
      "disconnect clears offers/pending and reports uncertainty")
    try check(
      rejects { _ = try session.command(offer) }, "old offer never replayed after disconnect")
    _ = try session.receive(hello("new-instance"))
    var replacement = changing(base, "bridgeInstance", .string("new-instance"))
    var providerRows = replacement["providers"].array
    var actionRows = providerRows[0]["actions"].array
    let oldRaw = actionRows[0]
    actionRows[0] = changing(oldRaw, "actionToken", .string("new-bridge-token"))
    providerRows[0] = changing(providerRows[0], "actions", .array(actionRows))
    replacement = changing(replacement, "providers", .array(providerRows))
    _ = try session.receive(encode(replacement))
    try check(
      session.revision == base["revision"].number && session.pending.isEmpty,
      "new bridge resets revision and pending command identities")
    try check(
      rejects { _ = try session.command(BridgeOffer(raw: oldRaw)) },
      "rotated or previous-bridge offer cannot dispatch")
    actionRows[0] = changing(actionRows[0], "eligible", .bool(false))
    providerRows[0] = changing(providerRows[0], "actions", .array(actionRows))
    replacement = changing(
      changing(replacement, "providers", .array(providerRows)), "revision", .number(2))
    _ = try session.receive(encode(replacement))
    try check(
      rejects { _ = try session.command(BridgeOffer(raw: actionRows[0])) }
        && session.pending.isEmpty, "current disabled offer never enters pending or dispatches")
    try check(
      rejects { _ = try session.receive(hello("unexpected-second-hello")) },
      "unsolicited second hello on one connection rejected")
    let resources = try SpriteResources(directory: Bundle.main.resourceURL!)
    let liveStore = FixtureStore(
      resources: resources, fixtureDirectory: options.fixtureDirectory, fixtureMode: false)
    liveStore.actionMessage = "Saved. Waiting for the refreshed state."
    liveStore.apply(try Snapshot.decode(source))
    try check(
      liveStore.actionMessage == nil, "authoritative snapshot clears pending-success UI message")
    let travelBefore = liveStore.actors.map(\.travel)
    liveStore.simulate("pause", provider: "claude")
    try check(
      liveStore.actors.map(\.travel) == travelBefore && !liveStore.actors[0].paused,
      "fixture simulation is disabled in live model")
    var framer = LineFramer()
    let unicode = Data("{\"label\":\"🍐\"}\n".utf8)
    var framed = [Data]()
    for byte in unicode { framed += try framer.append(Data([byte])) }
    try check(
      framed.count == 1 && String(data: framed[0], encoding: .utf8) == "{\"label\":\"🍐\"}",
      "UTF8 codepoint split across arbitrary pipe chunks")
    try check(
      rejects {
        var invalid = LineFramer()
        _ = try invalid.append(Data([0xc3, 10]))
      }, "invalid UTF8 rejected")
    try check(
      rejects {
        var huge = LineFramer()
        _ = try huge.append(Data(repeating: 65, count: LineFramer.maximumBytes + 1))
      }, "oversize unterminated frame rejected")
    var retries = RetrySchedule()
    try check(
      (0..<8).map { _ in retries.next() } == [1, 2, 4, 8, 16, 30, 30, 30],
      "retries have deterministic capped exponential backoff")
    retries.reset()
    try check(retries.next() == 1, "stable connection may reset retry schedule")
    let original = try options.bridgeConfiguration()
    let fakeDirectory = output.appendingPathComponent("fake-child")
    try FileManager.default.createDirectory(at: fakeDirectory, withIntermediateDirectories: true)
    let fakeFile = fakeDirectory.appendingPathComponent("bridge.mjs")
    let launchLog = fakeDirectory.appendingPathComponent("launches.jsonl")
    let commandLog = fakeDirectory.appendingPathComponent("commands.jsonl")
    func literal(_ value: String) throws -> String {
      String(
        data: try JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed),
        encoding: .utf8)!
    }
    let fake = """
      import fs from 'node:fs'; import readline from 'node:readline';
      const launches=\(try literal(launchLog.path)), commands=\(try literal(commandLog.path));
      const count=fs.existsSync(launches)?fs.readFileSync(launches,'utf8').trim().split('\\n').length:0;
      fs.appendFileSync(launches,JSON.stringify({pid:process.pid,argv:process.argv.slice(2)})+'\\n');
      const identity='fake-'+count, snapshot=\(String(data: source, encoding: .utf8)!);
      snapshot.bridgeInstance=identity;
      console.log(JSON.stringify({type:'hello',protocol:1,bridgeInstance:identity,runtimeVersion:'test',environmentId:'env_test'}));
      console.log(JSON.stringify(snapshot));
      readline.createInterface({input:process.stdin}).on('line',line=>{fs.appendFileSync(commands,line+'\\n'); process.exit(0);});
      """
    try Data(fake.utf8).write(to: fakeFile)
    let mock = BridgeConfiguration(
      node: original.node, cli: fakeFile.path, environment: original.environment,
      fakeCodex: original.fakeCodex)
    let client = try BridgeClient(configuration: mock)
    var snapshots = 0
    var states = [String]()
    var pids = [Int32]()
    client.onSnapshot = { snapshot in
      snapshots += 1
      if snapshots == 1,
        let raw = snapshot.providers.first(where: { $0.id == "claude" })?.payload["actions"].array
          .first(where: { $0["op"].string == "pause" && $0["eligible"].bool == true })
      {
        client.send(BridgeOffer(raw: raw))
      }
    }
    client.onState = { state, _ in states.append(state) }
    client.onDiagnostic = { event, fields in
      if event == "child_started", let pid = fields["pid"] as? Int32 { pids.append(pid) }
    }
    client.start()
    defer { client.stopAndWait() }
    try wait(seconds: 6) { snapshots >= 2 }
    spin(seconds: 1.2)
    client.stopAndWait()
    let lines = (try String(contentsOf: commandLog, encoding: .utf8)).split(separator: "\n")
    try check(
      lines.count == 1 && states.contains(where: { $0.hasPrefix("Result uncertain") }),
      "actual dropped pipe reconnects without replaying uncertain mutation")
    try check(
      pids.count >= 2 && pids.allSatisfy { kill($0, 0) != 0 && errno == ESRCH },
      "owned children terminated and reaped across reconnect/stop")
    let launchesBefore = try String(contentsOf: launchLog, encoding: .utf8)
    spin(seconds: 1.2)
    try check(
      try String(contentsOf: launchLog, encoding: .utf8) == launchesBefore,
      "stop cancels scheduled reconnect")
    try check(
      rejects {
        _ = try BridgeClient(
          configuration: BridgeConfiguration(
            node: "/missing/native-node", cli: original.cli, environment: original.environment,
            fakeCodex: original.fakeCodex))
      }, "missing absolute Node launch rejected")
    let badFile = fakeDirectory.appendingPathComponent("invalid-protocol.mjs")
    try Data(
      "process.stdout.write('private prefix before hello\\n');process.stderr.write('/private/SECRET-SHOULD-NOT-REACH-UI');setInterval(()=>{},1000);"
        .utf8
    ).write(to: badFile)
    let badClient = try BridgeClient(
      configuration: BridgeConfiguration(
        node: original.node, cli: badFile.path, environment: original.environment,
        fakeCodex: original.fakeCodex))
    var badEvents = [String]()
    var badStates = [String]()
    var badPids = [Int32]()
    badClient.onState = { state, _ in badStates.append(state) }
    badClient.onDiagnostic = { event, fields in
      badEvents.append(event)
      if event == "child_started", let pid = fields["pid"] as? Int32 { badPids.append(pid) }
    }
    defer { badClient.stopAndWait() }
    badClient.start()
    try wait(seconds: 4) { badEvents.contains("invalid_frame") }
    let cleanupWatchdog = DispatchWorkItem {
      fputs("Invalid-protocol owned-child cleanup exceeded 5 seconds\n", stderr)
      _exit(76)
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + 5, execute: cleanupWatchdog)
    let cleanupStart = ProcessInfo.processInfo.systemUptime
    badClient.stopAndWait()
    cleanupWatchdog.cancel()
    try check(
      ProcessInfo.processInfo.systemUptime - cleanupStart < 3,
      "invalid-protocol cleanup completes within its bounded stop budget")
    try check(
      !badStates.joined().contains("SECRET")
        && badPids.allSatisfy { kill($0, 0) != 0 && errno == ESRCH },
      "non-JSON before hello rejected; private stderr suppressed; invalid child reaped")
    let closedInputFile = fakeDirectory.appendingPathComponent("closed-input.mjs")
    try Data(
      ("import fs from 'node:fs';fs.closeSync(0);console.log(JSON.stringify(" + String(
        data: try hello(identity), encoding: .utf8)! + "));console.log(JSON.stringify(" + String(
          data: source, encoding: .utf8)! + "));setInterval(()=>{},1000);").utf8
    ).write(to: closedInputFile)
    let closedInput = try BridgeClient(
      configuration: BridgeConfiguration(
        node: original.node, cli: closedInputFile.path, environment: original.environment,
        fakeCodex: original.fakeCodex))
    var pipeFailed = false
    var pipePids = [Int32]()
    closedInput.onDiagnostic = { event, fields in
      if event == "write_failed" { pipeFailed = true }
      if event == "child_started", let pid = fields["pid"] as? Int32 { pipePids.append(pid) }
    }
    closedInput.onSnapshot = { snapshot in
      if let raw = snapshot.providers[0].payload["actions"].array.first(where: {
        $0["eligible"].bool == true
      }) {
        closedInput.send(BridgeOffer(raw: raw))
      }
    }
    defer { closedInput.stopAndWait() }
    closedInput.start()
    try wait(seconds: 4) { pipeFailed }
    closedInput.stopAndWait()
    try check(
      pipeFailed && pipePids.allSatisfy { kill($0, 0) != 0 && errno == ESRCH },
      "closed child stdin becomes quiet uncertain reconnect rather than SIGPIPE; child reaped")
    let invalidExecutable = fakeDirectory.appendingPathComponent("invalid-node")
    try Data("not an executable image\n".utf8).write(to: invalidExecutable)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700], ofItemAtPath: invalidExecutable.path)
    let launchFailure = try BridgeClient(
      configuration: BridgeConfiguration(
        node: invalidExecutable.path, cli: fakeFile.path, environment: original.environment,
        fakeCodex: original.fakeCodex))
    var launchFailed = false
    launchFailure.onDiagnostic = { event, _ in if event == "launch_failed" { launchFailed = true } }
    defer { launchFailure.stopAndWait() }
    launchFailure.start()
    try wait(seconds: 4) { launchFailed }
    launchFailure.stopAndWait()
    try check(
      launchFailed,
      "actual executable launch error cleans up without waiting on an unlaunched Process")
    // A refresh during a command may have lost its result. One fresh connection,
    // with a new hello/token scope, must replace the owned child without replay.
    let refreshFile = fakeDirectory.appendingPathComponent("refresh.mjs")
    let refreshLaunchLog = fakeDirectory.appendingPathComponent("refresh-launches.jsonl")
    let refreshCommandLog = fakeDirectory.appendingPathComponent("refresh-commands.jsonl")
    let refreshScript = """
      import fs from 'node:fs'; import readline from 'node:readline';
      const launches=\(try literal(refreshLaunchLog.path)), commands=\(try literal(refreshCommandLog.path));
      const count=fs.existsSync(launches)?fs.readFileSync(launches,'utf8').trim().split('\\n').length:0;
      fs.appendFileSync(launches,JSON.stringify({pid:process.pid})+'\\n');
      const identity='refresh-'+count, snapshot=\(String(data: source, encoding: .utf8)!);
      snapshot.bridgeInstance=identity;
      console.log(JSON.stringify({type:'hello',protocol:1,bridgeInstance:identity,runtimeVersion:'test',environmentId:'env_test'}));
      console.log(JSON.stringify(snapshot));
      readline.createInterface({input:process.stdin}).on('line',line=>fs.appendFileSync(commands,line+'\\n'));
      """
    try Data(refreshScript.utf8).write(to: refreshFile)
    let refreshing = try BridgeClient(configuration: BridgeConfiguration(
      node: original.node, cli: refreshFile.path, environment: original.environment, fakeCodex: original.fakeCodex))
    defer { refreshing.stopAndWait() }
    var refreshSnapshots = 0
    var refreshPids = [Int32]()
    var refreshStates = [String]()
    refreshing.onDiagnostic = { event, fields in
      if event == "child_started", let pid = fields["pid"] as? Int32 { refreshPids.append(pid) }
    }
    refreshing.onState = { state, _ in refreshStates.append(state) }
    refreshing.onSnapshot = { snapshot in
      refreshSnapshots += 1
      if refreshSnapshots == 1,
        let raw = snapshot.providers[0].payload["actions"].array.first(where: { $0["op"].string == "pause" && $0["eligible"].bool == true }) {
        refreshing.send(BridgeOffer(raw: raw))
      }
    }
    refreshing.start()
    try wait(seconds: 4) { FileManager.default.fileExists(atPath: refreshCommandLog.path) }
    refreshing.refresh()
    refreshing.refresh()
    try wait(seconds: 4) { refreshSnapshots == 2 }
    spin(seconds: 0.3)
    refreshing.stopAndWait()
    try check(refreshPids.count == 2 && refreshSnapshots == 2
      && (try String(contentsOf: refreshLaunchLog, encoding: .utf8)).split(separator: "\n").count == 2,
      "coalesced refresh replaces exactly one owned connection")
    try check((try String(contentsOf: refreshCommandLog, encoding: .utf8)).split(separator: "\n").count == 1
      && refreshStates.contains(where: { $0.hasPrefix("Result uncertain") }),
      "refresh during pending command marks uncertainty and never replays mutation")
    try check(refreshPids.allSatisfy { kill($0, 0) != 0 && errno == ESRCH }, "refresh and stop reap both owned children")

    // Real Node engine, with independently isolated records and mandatory fake account reader.
    let liveRoot = output.appendingPathComponent("real-engine")
    let bootstrap = URL(fileURLWithPath: original.cli).deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("native/scripts/scratch-runtime.mjs")
    let setup = Process()
    setup.executableURL = URL(fileURLWithPath: original.node)
    setup.arguments = [bootstrap.path, liveRoot.path, "daily-exhausted"]
    setup.environment = original.environment
    setup.standardOutput = FileHandle.nullDevice
    setup.standardError = FileHandle.nullDevice
    try setup.run()
    setup.waitUntilExit()
    try check(setup.terminationStatus == 0, "fresh real-engine bootstrap stays scratch-only")
    let liveConfig = try JSONDecoder().decode(
      BridgeConfiguration.self,
      from: Data(contentsOf: liveRoot.appendingPathComponent("bridge-config.json")))
    let live = try BridgeClient(configuration: liveConfig)
    defer { live.stopAndWait() }
    var stage = 0
    var resultCount = 0
    var manualResumeReviewed = false
    var livePids = [Int32]()
    var liveStates = [String]()
    live.onState = { state, _ in liveStates.append(state) }
    live.onResult = { _, ok, _ in if ok { resultCount += 1 } }
    live.onDiagnostic = { event, fields in
      if event == "child_started", let pid = fields["pid"] as? Int32 { livePids.append(pid) }
    }
    live.onSnapshot = { snapshot in
      guard let claude = snapshot.providers.first(where: { $0.id == "claude" }),
        let codex = snapshot.providers.first(where: { $0.id == "codex" }), !codex.paused
      else { return }
      if stage == 0, claude.paused,
        let extra = claude.payload["actions"].array.first(where: {
          $0["op"].string == "extra.daily" && $0["eligible"].bool == true
        })
      {
        stage = 1
        live.send(BridgeOffer(raw: extra))
      } else if stage == 1, !claude.paused,
        let pause = claude.payload["actions"].array.first(where: {
          $0["op"].string == "pause" && $0["eligible"].bool == true
            && $0["params"]["duration"].string == "1h"
        })
      {
        stage = 2
        live.send(BridgeOffer(raw: pause))
      } else if stage == 2, claude.paused,
        let resume = claude.payload["actions"].array.first(where: {
          $0["op"].string == "resume" && $0["eligible"].bool == true
        }), let manualID = claude.payload["reasons"].array.first(where: { $0["kind"].string == "manual" })?["id"].string {
        manualResumeReviewed = resume["lifts"].array.contains(.string(manualID))
        if manualResumeReviewed {
          stage = 3
          live.send(BridgeOffer(raw: resume))
        }
      } else if stage == 3, !claude.paused { stage = 4 }

    }
    live.start()
    try wait(seconds: 12) { stage == 4 && resultCount == 3 && manualResumeReviewed }
    live.stopAndWait()
    try check(
      stage == 4 && resultCount == 3 && manualResumeReviewed,
      "real Node Extra, Claude-only Pause and signed manual-lift Resume apply through authoritative snapshots; Codex unchanged")
    let execution = try String(
      contentsOf: URL(fileURLWithPath: liveConfig.environment["PERAS_NATIVE_FAKE_CODEX_LOG"]!),
      encoding: .utf8)
    let records = try execution.split(separator: "\n").map {
      try JSONDecoder().decode(JSONValue.self, from: Data($0.utf8))
    }
    try check(
      !records.isEmpty && records.allSatisfy { $0["executable"].string == liveConfig.fakeCodex },
      "actual account-reader executable path is the mandatory fake Codex")
    try check(
      livePids.allSatisfy { kill($0, 0) != 0 && errno == ESRCH }, "real Node bridge reaped on stop")
    try Probe(directory: output).write(
      [
        "checks": passed, "mockChildPids": pids, "liveChildPids": livePids,
        "fakeCodex": liveConfig.fakeCodex,
        "fakeExecutionLog": liveConfig.environment["PERAS_NATIVE_FAKE_CODEX_LOG"]!,
        "liveStates": liveStates,
      ], name: "results")
    print("Native bridge checks passed: \(passed.count)")
  }
  private static func wait(seconds: Double, until condition: () -> Bool) throws {
    let deadline = Date().addingTimeInterval(seconds)
    while !condition() && Date() < deadline {
      _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
    }
    guard condition() else {
      throw SnapshotError.invalid("Timed out waiting for native bridge check")
    }
  }
  private static func spin(seconds: Double) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
      _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
    }
  }
}
