import AppKit
import Darwin

// Compiled by run.mjs without App lifecycle, windows, existing Tests or the owner runtime.
enum RecoveryChecks {
  static func run(root: URL) throws {
    let original = try JSONDecoder().decode(BridgeConfiguration.self, from: Data(contentsOf: root.appendingPathComponent("bridge-config.json"))).validated()
    let fixtures = root.appendingPathComponent("fixtures")
    let source = try Data(contentsOf: fixtures.appendingPathComponent("normal-usage.json"))
    let base = try JSONDecoder().decode(JSONValue.self, from: source)
    var checks = [String]()
    func check(_ value: Bool, _ name: String) throws { guard value else { throw SnapshotError.invalid("Recovery check failed: " + name) }; checks.append(name) }
    func wait(_ predicate: () -> Bool, seconds: Double = 3) -> Bool {
      let until = Date().addingTimeInterval(seconds)
      while Date() < until { if predicate() { return true }; RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
      return predicate()
    }
    func settle(_ seconds: Double = 0.15) { _ = wait({ false }, seconds: seconds) }
    func replacing(_ value: JSONValue, _ key: String, _ next: JSONValue) -> JSONValue {
      guard case .object(var fields) = value else { return value }; fields[key] = next; return .object(fields)
    }
    func literal(_ value: String) -> String { String(data: try! JSONEncoder().encode(value), encoding: .utf8)! }
    func rows(_ file: URL) -> [String] { ((try? String(contentsOf: file, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init) }
    func childScript(_ directory: URL, mode: String) throws -> URL {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let script = directory.appendingPathComponent("bridge.mjs")
      let js = """
      import fs from 'node:fs'; import readline from 'node:readline';
      const dir=\(literal(directory.path)), mode=\(literal(mode));
      fs.appendFileSync(dir+'/launches',JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\\n');
      process.on('SIGTERM',()=>process.exit(0)); setTimeout(()=>process.exit(0),20000);
      const snapshot=\(String(data: source, encoding: .utf8)!);
      const emit=v=>console.log(JSON.stringify(v));
      const identity='owned-'+process.pid; snapshot.bridgeInstance=identity;
      if(mode==='malformed'){console.log('{PRIVATE_INVALID');}
      else if(mode==='oversized'){console.log('x'.repeat(1048577));}
      else {
        emit({type:'hello',protocol:mode==='protocol'?2:1,bridgeInstance:identity,runtimeVersion:'0.4.0-preview.1',environmentId:'test'});
        if(mode==='enum'){snapshot.providers[0].verdict.action='future_core';}
        emit(snapshot);
      }
      if(mode==='crash')setTimeout(()=>process.exit(0),10);
      readline.createInterface({input:process.stdin}).on('line',line=>{
        fs.appendFileSync(dir+'/commands',line+'\\n');
        if(mode==='pending'){emit({type:'hello',protocol:99});snapshot.revision=999;emit(snapshot);}
      });
      """
      try Data(js.utf8).write(to: script); return script
    }
    var ownedPIDs = [Int32]()
    var clients = [BridgeClient]()
    defer { clients.forEach { $0.stopAndWait() } }
    func client(_ file: URL, production: BridgeConfiguration? = nil) throws -> BridgeClient {
      let config = production ?? BridgeConfiguration(node: original.node, cli: file.path, environment: original.environment, fakeCodex: original.fakeCodex)
      let client = try BridgeClient(configuration: config)
      client.onDiagnostic = { event, fields in if event == "child_started", let pid = fields["pid"] as? Int32 { ownedPIDs.append(pid) } }
      clients.append(client); return client
    }
    for fixture in try FileManager.default.contentsOfDirectory(at: fixtures, includingPropertiesForKeys: nil) {
      _ = try Snapshot.decode(Data(contentsOf: fixture))
    }
    try check(true, "all supported fixtures still decode")
    let originalProvider = try Snapshot.decode(source).providers[0]
    try check(!ProviderSnapshot(id: originalProvider.id, payload: replacing(originalProvider.payload, "readError", .null)).readError, "missing readError remains compatible")
    let unreadable = ProviderSnapshot(id: originalProvider.id, payload: replacing(originalProvider.payload, "readError", .bool(true)))
    try check(unreadable.readError && unreadable.windows == originalProvider.windows && unreadable.payload["actions"] == originalProvider.payload["actions"], "provider readError preserves authoritative readings and offered actions")
    try check(!ProviderSnapshot(id: originalProvider.id, payload: replacing(originalProvider.payload, "readError", .string("PRIVATE_PATH"))).readError, "readError never parses arbitrary diagnostic prose")
    let slowVersion = root.appendingPathComponent("slow-supported-node")
    try Data("#!/bin/sh\n/bin/sleep 0.6\nprintf 'v22.0.0\\n'\n".utf8).write(to: slowVersion)
    try FileManager.default.setAttributes([.posixPermissions:0o700], ofItemAtPath: slowVersion.path)
    try check(NodeVersionProbe.supported(slowVersion.path, environment: original.environment), "bounded default probe tolerates supported Node startup under load")
    let timeoutNode = root.appendingPathComponent("timeout-node")
    try Data("#!/bin/sh\nexec /bin/sleep 3\n".utf8).write(to: timeoutNode)
    try FileManager.default.setAttributes([.posixPermissions:0o700], ofItemAtPath: timeoutNode.path)
    let timeoutStarted = Date()
    try check(!NodeVersionProbe.supported(timeoutNode.path, environment: original.environment, timeout: 0.05) && Date().timeIntervalSince(timeoutStarted) < 1, "explicit short probe timeout remains bounded and reaps its child")
    // The case behind the old 1 s flake: a Node that has never run before (an upgrade) waits on
    // macOS's first-run check for seconds. A fresh copy of the real one must still be accepted.
    let freshNode = root.appendingPathComponent("fresh-node-" + UUID().uuidString)
    try FileManager.default.copyItem(at: URL(fileURLWithPath: original.node).resolvingSymlinksInPath(), to: freshNode)
    let freshAccepted = NodeVersionProbe.supported(freshNode.path, environment: original.environment)
    let freshProbe = NodeVersionProbe.last
    try? FileManager.default.removeItem(at: freshNode)
    try check(freshAccepted && freshProbe.milliseconds < NodeVersionProbe.timeout * 1000, "never-run Node copy accepted by the default probe (\(freshProbe.outcome), first run \(Int(freshProbe.milliseconds)) ms)")
    let decoded = try Snapshot.decode(source), cached = decoded.cachedPresentation()
    try check(cached.providers.allSatisfy { $0.payload["actions"].array.isEmpty } && cached.raw["settings"]["actions"].array.isEmpty && cached.raw["discovery"] == .null, "cache strips every provider/global/discovery offer and link declaration")
    for freshness in ["current", "stale", "expired", "missing"] {
      var p = base["providers"].array
      var windows = p[0]["windows"].array
      windows[0] = replacing(windows[0], "freshness", .string(freshness))
      if freshness == "missing" { windows[0] = replacing(windows[0], "used", .null) }
      p[0] = replacing(p[0], "windows", .array(windows))
      let snapshot = try Snapshot.decode(JSONEncoder().encode(replacing(base, "providers", .array(p))))
      try check(snapshot.cachedPresentation().providers[0].windows[0]["freshness"].string == (freshness == "current" ? "stale" : freshness), "cache preserves \(freshness) semantics without inventing freshness")
    }
    let resources = try SpriteResources(directory: root.appendingPathComponent("resources"))
    let store = FixtureStore(resources: resources, fixtureDirectory: fixtures, fixtureMode: false, presentationRoot: root.appendingPathComponent("presentation"))
    store.apply(decoded)
    store.receiveState("Disconnected", blocked: [])
    try check(store.snapshot == nil && store.cachedSnapshot != nil && store.currentOffers.isEmpty && store.blockedProviders == ["claude", "codex", "global"], "store separates immutable cache from authoritative state and blocks all changes")
    try check(store.actors.allSatisfy { !store.hasReading($0) } && store.timer == nil, "cached rows cannot animate or report fresh activity")
    let offer = decoded.providers.flatMap { $0.payload["actions"].array.map { BridgeOffer(raw: $0) } }.first { $0.eligible && $0.raw["op"].string == "pause" }!
    store.sendCurrent(offer); settle()
    try check(store.currentOffers.isEmpty && store.resumingProviders.isEmpty, "old cached token cannot be dispatched via sendCurrent")
    for mode in ["protocol", "enum"] {
      let dir = root.appendingPathComponent(mode), file = try childScript(dir, mode: mode), c = try client(file)
      var recovery: BridgeRecovery?
      c.onRecovery = { recovery = $0 }; c.start()
      try check(wait({ recovery == .compatibility }), "\(mode) failure enters actionable compatibility recovery")
      for _ in 0..<5 { c.refresh() }
      settle(0.3)
      try check(rows(dir.appendingPathComponent("launches")).count == 1, "\(mode) terminal wake/clock refresh never respawns child")
      c.stopAndWait()
    }
    let dir = root.appendingPathComponent("pending"), file = try childScript(dir, mode: "pending"), c = try client(file)
    var recovery: BridgeRecovery?, latest: Snapshot?, states = [String](), observedRevisions = [Double]()
    c.onRecovery = { recovery = $0 }; c.onSnapshot = { latest = $0; observedRevisions.append($0.revision) }; c.onState = { state, _ in states.append(state) }; c.start()
    try check(wait({ latest != nil }), "pending test receives authoritative state")
    let currentOffer = latest!.providers.flatMap { $0.payload["actions"].array.map { BridgeOffer(raw: $0) } }.first { $0.eligible && $0.raw["op"].string == "pause" }!
    c.send(currentOffer)
    try check(wait({ recovery == .compatibility }), "invalid protocol while command pending stops rather than replaying")
    try check(states.contains { $0.hasPrefix("Result uncertain") } && rows(dir.appendingPathComponent("commands")).count == 1, "pending outcome remains uncertain and command sent exactly once")
    c.send(currentOffer); c.refresh(); settle(0.2)
    try check(rows(dir.appendingPathComponent("commands")).count == 1, "old generation token cannot resend in terminal state")
    _ = try childScript(dir, mode: "valid")
    latest = nil
    for _ in 0..<3 { c.retry() }
    try check(wait({ latest != nil }), "explicit retry establishes fresh supported connection")
    settle(0.2)
    try check(rows(dir.appendingPathComponent("launches")).count == 2 && rows(dir.appendingPathComponent("commands")).count == 1, "rapid explicit retries coalesce and never replay command")
    try check(recovery == nil && latest!.bridgeInstance != decoded.bridgeInstance, "only new authoritative context leaves recovery")
    c.stopAndWait(); let stoppedSnapshots = latest!.bridgeInstance; settle(0.2)
    try check(latest!.bridgeInstance == stoppedSnapshots && !observedRevisions.contains(999) && observedRevisions.count == 2, "late old-generation snapshot and termination callbacks cannot replace recovered context")
    for mode in ["malformed", "oversized", "crash"] {
      let d = root.appendingPathComponent(mode), f = try childScript(d, mode: mode), client = try client(f)
      var terminal: BridgeRecovery?
      client.onRecovery = { terminal = $0 }; client.start()
      try check(wait({ terminal == .unavailable }, seconds: 12), "\(mode) input exhausts a bounded reconnect budget")
      try check(rows(d.appendingPathComponent("launches")).count == 4, "\(mode) performs only three automatic retries")
      client.refresh(); settle(0.2)
      try check(rows(d.appendingPathComponent("launches")).count == 4, "\(mode) quiet state cannot become wake retry storm")
      client.stopAndWait()
    }
    // Real executable path switches between supported and unsupported; external record repair
    // must be re-read against the original expected production runtime, not its new value.
    let prod = root.appendingPathComponent("production"), runtime = prod.appendingPathComponent("runtime/bin")
    try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
    let productionScript = try childScript(runtime, mode: "valid")
    let cli = runtime.appendingPathComponent("peras.mjs")
    try FileManager.default.copyItem(at: productionScript, to: cli)
    let package = runtime.deletingLastPathComponent().appendingPathComponent("package.json")
    try Data("{\"version\":\"0.4.0-preview.1\"}".utf8).write(to: package)
    let node = prod.appendingPathComponent("node"), marker = prod.appendingPathComponent("unsupported")
    let shell = "#!/bin/sh\nif [ \"$1\" = --version ]; then if [ -f " + "'" + marker.path + "'" + " ]; then printf 'v16.0.0\\n'; else printf 'v22.0.0\\n'; fi; exit; fi\nexec '" + original.node + "' \"$@\"\n"
    try Data(shell.utf8).write(to: node); try FileManager.default.setAttributes([.posixPermissions:0o700], ofItemAtPath: node.path)
    let state = prod.appendingPathComponent("state")
    try FileManager.default.createDirectory(at: state.appendingPathComponent("native"), withIntermediateDirectories: true)
    var record: [String: Any] = ["schema":1, "runtimeVersion":"0.4.0-preview.1", "node":node.path, "nodeVersion":"22.0.0", "nodeMin":18, "cli":cli.path, "fallbackNodes":[String](), "nodeFix":LaunchFailure.node.message, "environment":["PERAS_HOME":state.path,"CLAUDE_CONFIG_DIR":original.environment["CLAUDE_CONFIG_DIR"]!,"CODEX_HOME":original.environment["CODEX_HOME"]!,"PATH":original.environment["PATH"]!]]
    let recordFile = state.appendingPathComponent("native/launch.json")
    try JSONSerialization.data(withJSONObject: record).write(to: recordFile)
    let configuration = try LaunchRecord.load(root: state.path).configuration(root: state.path, home: original.environment["HOME"]!, expectedRuntime:"0.4.0-preview.1")
    let production = try client(cli, production: configuration)
    var productionState: BridgeRecovery?, productionSnapshot: Snapshot?
    production.onRecovery = { productionState = $0 }; production.onSnapshot = { productionSnapshot = $0 }; production.start()
    try check(wait({ productionSnapshot != nil }), "production fake executable starts an actual bridge")
    try Data().write(to: marker)
    let first = ownedPIDs.last!; kill(first, SIGTERM)
    try check(wait({ productionState == .dependency }), "unsupported Node after established launch becomes exact actionable dependency state")
    let launchCount = rows(runtime.appendingPathComponent("launches")).count
    for _ in 0..<5 { production.refresh() }; settle(0.2)
    try check(rows(runtime.appendingPathComponent("launches")).count == launchCount, "unavailable production Node does not repeatedly spawn bridge")
    try FileManager.default.removeItem(at: marker)
    record["node"] = prod.appendingPathComponent("moved-node").path; record["fallbackNodes"] = [node.path]
    try JSONSerialization.data(withJSONObject: record).write(to: recordFile)
    productionSnapshot = nil
    for _ in 0..<3 { production.retry() }
    try check(wait({ productionSnapshot != nil }), "manual repair rereads current record and permitted Node fallback")
    try check(rows(runtime.appendingPathComponent("launches")).count == launchCount + 1, "production rapid retry retains exactly one new connection")
    record["runtimeVersion"] = "0.3.2"
    try Data("{\"version\":\"0.3.2\"}".utf8).write(to: package)
    try JSONSerialization.data(withJSONObject: record).write(to: recordFile)
    kill(ownedPIDs.last!, SIGTERM)
    try check(wait({ productionState == .installation }), "replacement record cannot redefine original bundled runtime compatibility")
    production.stopAndWait()
    settle(0.2)
    try check(ownedPIDs.allSatisfy { kill($0,0) != 0 }, "all owned bridge children cleaned up")
    let output: [String: Any] = ["checks":checks,"count":checks.count,"ownedChildPIDs":ownedPIDs]
    try JSONSerialization.data(withJSONObject: output, options:[.prettyPrinted,.sortedKeys]).write(to: root.appendingPathComponent("recovery-results.json"))
    print("Native recovery checks passed: \(checks.count)")
  }
}
