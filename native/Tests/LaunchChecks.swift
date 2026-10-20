import Foundation

enum LaunchChecks {
  static func run(options: Options) throws {
    var passed = [String]()
    func check(_ value: Bool, _ name: String) throws {
      guard value else { throw SnapshotError.invalid("Launch check failed: " + name) }
      passed.append(name)
    }
    try check(LaunchPresentation.label(fixture: false, development: false) == nil, "production has no synthetic Demo label")
    try check(LaunchPresentation.label(fixture: true, development: true) == "Preview" && LaunchPresentation.label(fixture: false, development: true) == "Demo", "fixture and guarded development identification preserved")
    // Open at Login retires after a rollback (older installed runtime), never after an upgrade or on junk.
    try check(LoginItem.runtimeIsOlder("0.3.2", than: "0.4.0-preview.1") && LoginItem.runtimeIsOlder("0.3.10", than: "0.4.0"),
      "a 0.3 runtime under a 0.4 app counts as a rollback")
    try check(!LoginItem.runtimeIsOlder("0.4.0-preview.1", than: "0.4.0-preview.1") && !LoginItem.runtimeIsOlder("0.4.1", than: "0.4.0-preview.1")
      && !LoginItem.runtimeIsOlder("0.10.0", than: "0.4.0") && !LoginItem.runtimeIsOlder("junk", than: "0.4.0"),
      "the same, a newer or an unreadable runtime never retires the app")
    try check(LoginItem.state == .unavailable && !LoginItem.set(true), "a development build never changes login items")
    let oldDesktop = try JSONDecoder().decode(DesktopPreferences.self, from: Data(#"{"frame":[431,74,320,691],"shortcutChoice":0,"shortcutEnabled":true}"#.utf8))
    let roundTrip = try JSONDecoder().decode(DesktopPreferences.self, from: JSONEncoder().encode(DesktopPreferences(openAtLogin: false)))
    try check(oldDesktop.openAtLogin == nil && oldDesktop.shortcutEnabled && roundTrip.openAtLogin == false, "desktop.json without openAtLogin still loads; a choice persists")
    let dir = options.output.appendingPathComponent("launch-check-state")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    func executable(_ name: String, _ body: String) throws -> String {
      let file = dir.appendingPathComponent(name)
      try Data(("#!/bin/sh\n" + body + "\n").utf8).write(to: file)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
      return file.path
    }
    let supported = try executable("supported", "printf 'v22.3.0\\n'")
    let unsupported = try executable("unsupported", "printf 'v16.9.0\\n'")
    let noisy = try executable("noisy", "while :; do printf 'PRIVATE_UNTRUSTED_OUTPUT'; done")
    let timeout = try executable("timeout", "exec /bin/sleep 3")
    let malformed = try executable("malformed", "printf 'v22.3.0 PRIVATE_PATH\\n'")
    try FileManager.default.createDirectory(at: dir.appendingPathComponent("app/bin"), withIntermediateDirectories: true)
    let package = dir.appendingPathComponent("app/package.json")
    try Data("{\"version\":\"0.4.0-preview.1\"}".utf8).write(to: package)
    let cli = dir.appendingPathComponent("app/bin/peras.mjs").path
    try Data().write(to: URL(fileURLWithPath: cli))
    let env = ["HOME": dir.path, "PATH": "/usr/bin:/bin"]
    let accepted = NodeVersionProbe.supported(supported, environment: env)
    try check(accepted, "exact supported version with sparse GUI PATH" + (accepted ? "" : " (\(NodeVersionProbe.last.outcome) after \(Int(NodeVersionProbe.last.milliseconds)) ms)"))
    try check(!NodeVersionProbe.supported(unsupported, environment: env), "unsupported executable refused")
    try check(!NodeVersionProbe.supported(malformed, environment: env), "extra output cannot masquerade as version")
    try check(!NodeVersionProbe.supported(noisy, environment: env), "noisy output bounded and discarded")
    let start = ProcessInfo.processInfo.systemUptime
    try check(!NodeVersionProbe.supported(timeout, environment: env, timeout: 0.05), "timeout child refused and terminated")
    try check(ProcessInfo.processInfo.systemUptime - start < 1, "timeout cleanup bounded")
    func record(node: String, fallback: [String], environment: [String: String] = [:]) -> LaunchRecord {
      LaunchRecord(schema: 1, runtimeVersion: "0.4.0-preview.1", node: node, nodeVersion: "22.3.0", nodeMin: 18,
        cli: cli, fallbackNodes: fallback, nodeFix: LaunchFailure.node.message, environment: environment)
    }
    let custom = ["PERAS_HOME": dir.path, "CLAUDE_CONFIG_DIR": dir.path + "/claude", "CODEX_HOME": dir.path + "/codex", "PATH": "/usr/bin:/bin"]
    let configuration = try record(node: dir.path + "/moved", fallback: [unsupported, supported], environment: custom).configuration(root: dir.path, home: dir.path, expectedRuntime: "0.4.0-preview.1")
    try check(configuration.node == supported, "moved and unsupported recorded nodes advance to allowed fallback")
    try check(configuration.environment["PERAS_HOME"] == (try InstanceLock(path: dir.path).root.path) && configuration.environment["CLAUDE_CONFIG_DIR"] == custom["CLAUDE_CONFIG_DIR"] && configuration.environment["CODEX_HOME"] == custom["CODEX_HOME"], "canonical root and custom provider roots survive")
    do { _ = try record(node: supported, fallback: [], environment: ["PERAS_HOME": "/stale/root"]).configuration(root: dir.path, home: dir.path, expectedRuntime: "0.4.0-preview.1"); try check(false, "mismatched root") }
    catch LaunchFailure.install { try check(true, "mismatched record root rejected rather than mixing provider contexts") }
    let rootAlias = dir.appendingPathComponent("root-alias")
    try FileManager.default.createSymbolicLink(at: rootAlias, withDestinationURL: dir)
    _ = try record(node: supported, fallback: [], environment: ["PERAS_HOME": rootAlias.path]).configuration(root: dir.path, home: dir.path, expectedRuntime: "0.4.0-preview.1")
    try check(true, "canonical symlink record root accepted")
    do { _ = try record(node: supported, fallback: []).configuration(root: dir.path, home: dir.path, expectedRuntime: "0.3.2"); try check(false, "bundle mismatch") }
    catch LaunchFailure.runtime(let version) { try check(version == "0.4.0-preview.1", "a runtime from another line asks for its own app") }
    _ = try record(node: supported, fallback: []).configuration(root: dir.path, home: dir.path, expectedRuntime: "0.4.2")
    try check(true, "a runtime from the app's own major.minor line is accepted: a patch update keeps the app")
    try check(RuntimeLine.same("0.4.0", "0.4.11-preview.2") && !RuntimeLine.same("0.4.0", "0.5.0") && !RuntimeLine.same("0.4.0", "junk") && !RuntimeLine.same("", ""),
      "runtime lines compare major.minor only and never match junk")
    try Data("{\"version\":\"0.3.2\"}".utf8).write(to: package)
    do { _ = try record(node: supported, fallback: []).configuration(root: dir.path, home: dir.path, expectedRuntime: "0.4.0-preview.1"); try check(false, "CLI rollback") }
    catch LaunchFailure.install { try check(true, "replaced CLI runtime rejected before bridge reconnect loop") }
    try Data("{\"version\":\"0.4.0-preview.1\"}".utf8).write(to: package)
    let hung = try (1...3).map { try executable("hung-\($0)", "exec /bin/sleep 3") }
    let budgetStart = ProcessInfo.processInfo.systemUptime
    do { _ = try record(node: hung[0], fallback: Array(hung.dropFirst()) + [supported]).configuration(root: dir.path, home: dir.path, expectedRuntime: "0.4.0-preview.1", probeTimeout: 0.3, budget: 0.5); try check(false, "hung candidates") }
    catch LaunchFailure.node { try check(ProcessInfo.processInfo.systemUptime - budgetStart < 1.5, "hung Node candidates stop at the total probe budget") }
    let pathCleaned = try record(node: supported, fallback: [], environment: ["PATH": ".:/usr/bin::relative:/bin:"]).configuration(root: dir.path, home: dir.path, expectedRuntime: "0.4.0-preview.1")
    try check(pathCleaned.environment["PATH"] == "/usr/bin:/bin", "raw carried PATH sanitizes relative and empty elements")
    try check(Set(configuration.environment.keys) == ["HOME", "PERAS_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PATH"], "production environment explicit allowlist")
    do { _ = try record(node: "/absent", fallback: []).configuration(root: dir.path, home: dir.path, expectedRuntime: "0.4.0-preview.1"); try check(false, "missing node") }
    catch LaunchFailure.node { try check(true, "absent nodes produce exact current-LTS guidance") }
    for invalid in [record(node: "relative", fallback: []), record(node: supported, fallback: ["relative"]), record(node: supported, fallback: [], environment: ["SECRET": "PRIVATE_USERNAME"])] {
      do { _ = try invalid.validated(); try check(false, "invalid record") }
      catch LaunchFailure.install { try check(true, "malformed record rejected with private actionable error") }
    }
    try check(!LaunchFailure.install.message.contains(dir.path) && !LaunchFailure.node.message.contains("PRIVATE"), "display errors contain no child diagnostics or local paths")
    let native = dir.appendingPathComponent("custom/native/Peras.app")
    try FileManager.default.createDirectory(at: native, withIntermediateDirectories: true)
    let alias = dir.appendingPathComponent("alias.app")
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: native)
    try check(LaunchRoot.resolve(bundle: alias, explicit: nil, environment: ["PERAS_HOME": "/stale"], development: false) == (try InstanceLock(path: dir.path + "/custom").root.path), "canonical installed symlink bundle beats inherited root")
    try check(LaunchRoot.resolve(bundle: native, explicit: dir.path, environment: [:], development: true) == (try InstanceLock(path: dir.path).root.path), "explicit development root retained")
    try check(LaunchRoot.resolve(bundle: URL(fileURLWithPath: "/Applications/Other.app"), explicit: nil, environment: ["HOME": dir.path], development: false) == (try InstanceLock(path: dir.path + "/.peras").root.path), "uninstalled fallback uses home not working directory")
    try check(!LaunchRoot.resolve(bundle: native, explicit: nil, environment: ["HOME": dir.path], development: true).hasPrefix(dir.path + "/.peras"), "development without explicit root never defaults to production home state")
    let nativeDir = dir.appendingPathComponent("native")
    try FileManager.default.createDirectory(at: nativeDir, withIntermediateDirectories: true)
    let recordFile = nativeDir.appendingPathComponent("launch.json")
    var raw: [String: Any] = ["schema": 1, "runtimeVersion": "0.4.0-preview.1", "node": supported,
      "nodeVersion": "22.3.0", "nodeMin": 18, "cli": cli, "fallbackNodes": [String](),
      "nodeFix": LaunchFailure.node.message, "environment": ["PATH": "/usr/bin:/bin"]]
    try JSONSerialization.data(withJSONObject: raw).write(to: recordFile)
    try check(try LaunchRecord.load(root: dir.path).node == supported, "schema-one external record loads independently of GUI PATH")
    for key in ["schema", "nodeMin", "runtimeVersion"] {
      let saved = raw[key]
      raw[key] = key == "runtimeVersion" ? "PRIVATE_INVALID_VERSION" : 99
      try JSONSerialization.data(withJSONObject: raw).write(to: recordFile)
      do { _ = try LaunchRecord.load(root: dir.path); try check(false, "invalid metadata") }
      catch LaunchFailure.install { try check(true, "invalid " + key + " gives fixed installation guidance") }
      raw[key] = saved
    }
    try Data("PRIVATE_USERNAME not JSON".utf8).write(to: recordFile)
    do { _ = try LaunchRecord.load(root: dir.path); try check(false, "malformed JSON") }
    catch LaunchFailure.install { try check(true, "malformed JSON cannot leak decoder content") }
    try FileManager.default.removeItem(at: recordFile)
    do { _ = try LaunchRecord.load(root: dir.path); try check(false, "missing record") }
    catch LaunchFailure.install { try check(true, "missing launch record uses actionable installation guidance") }
    try check(LaunchRecord.version("v22.3.0\n\n") == nil && LaunchRecord.version("v22.3.0 trailing") == nil,
      "version parser rejects trailing blank lines and text exactly")
    let a = try InstanceLock(path: dir.path + "/one"), b = try InstanceLock(path: dir.path + "/two")
    try check(a.key != b.key, "independent roots retain different instance identities")
    let development = try options.bridgeConfiguration()
    _ = try development.validated()
    var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(configuration)) as! [String: Any]
    json["production"] = true
    let forged = try JSONDecoder().decode(BridgeConfiguration.self, from: JSONSerialization.data(withJSONObject: json))
    do { _ = try forged.validated(); try check(false, "forged production flag") }
    catch { try check(true, "decoded development configuration cannot bypass executable fake-Codex guard") }
    try Probe(directory: options.output).write(["passed": passed, "count": passed.count], name: "launch-checks")
  }
}
