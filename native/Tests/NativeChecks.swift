import Foundation

// Runs as a CLI mode without creating NSApplication or a status item.
enum NativeChecks {
  static func run(resources: SpriteResources, fixtures: URL, output: URL) throws {
    var checks = [String]()
    func expect(_ condition: @autoclosure () -> Bool, _ name: String) throws {
      guard condition() else { throw SnapshotError.invalid("CHECK FAILED: \(name)") }
      checks.append(name)
    }
    let actor = Actor("claude", 1350)
    let x = actor.pose(resources.atlas, 0, false, 640).x
    actor.trigger("pause", 0, false)
    actor.tick(400, 400, false)
    try expect(
      actor.travel == 1350 && actor.pose(resources.atlas, 400, false, 640).x == x,
      "pause freezes actual position and phase")
    actor.trigger("resume", 400, false)
    actor.tick(100, 500, false)
    try expect(actor.travel == 1350, "resume holds phase through anticipation")
    actor.tick(200, 700, false)
    try expect(actor.travel == 1450, "resume advances only after 200 ms beat")
    actor.trigger("greet", 700, false, "confirmed-window")
    try expect(
      !actor.trigger("greet", 701, false, "confirmed-window"),
      "duplicate reset identity cannot queue a greeting")
    actor.tick(500, 1200, true)
    try expect(actor.travel == 1450, "reduced motion holds phase")
    let base = output.appendingPathComponent("alias-test")
    try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    let real = base.appendingPathComponent("real")
    let alias = base.appendingPathComponent("alias")
    try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: alias.path) {
      try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: real)
    }
    let first = try InstanceLock(path: real.appendingPathComponent("new-root").path)
    let second = try InstanceLock(path: alias.appendingPathComponent("new-root").path)
    try expect(
      first.key == second.key, "canonical symlink aliases share identity even for missing leaf")
    try expect(tryAcquire(first), "first root lock acquired")
    try expect(!tryAcquire(second), "second alias lock excluded")
    var decoded = [[String: Any]]()
    let names = Set(try FileManager.default.contentsOfDirectory(atPath: fixtures.path))
    try expect(
      Set([
        "missing-setup.json", "normal-usage.json", "manual-pause.json", "scoped-stop.json",
        "daily-exhausted.json", "suggestion-pause.json", "pacing-text.json",
      ]).isSubset(of: names), "all seven Contract A fixtures available")
    for file in try FileManager.default.contentsOfDirectory(
      at: fixtures, includingPropertiesForKeys: nil
    ).filter({ $0.pathExtension == "json" }).sorted(by: { $0.path < $1.path }) {
      let snapshot = try Snapshot.decode(Data(contentsOf: file))
      decoded.append([
        "file": file.lastPathComponent, "providers": snapshot.providers.map(\.id),
        "revision": snapshot.revision,
      ])
      if file.lastPathComponent == "manual-pause.json"
        || file.lastPathComponent == "scoped-stop.json"
        || file.lastPathComponent == "daily-exhausted.json"
      {
        try expect(
          snapshot.providers.first { $0.id == "claude" }?.paused == true,
          file.lastPathComponent + " stops Claude")
        try expect(
          snapshot.providers.first { $0.id == "codex" }?.paused == false,
          file.lastPathComponent + " leaves Codex moving")
      }
      if file.lastPathComponent == "normal-usage.json" {
        let object =
          try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        for mutation in ["protocol", "duplicate", "window", "usage", "freshness"] {
          var invalid = object
          var providers = object["providers"] as! [[String: Any]]
          switch mutation {
          case "protocol": invalid["protocol"] = 2
          case "duplicate": providers.append(providers[0])
          default:
            var windows = providers[0]["windows"] as! [[String: Any]]
            if mutation == "window" { windows[0]["window"] = "unknown" }
            if mutation == "usage" { windows[0]["used"] = 101 }
            if mutation == "freshness" { windows[0]["freshness"] = "maybe" }
            providers[0]["windows"] = windows
          }
          invalid["providers"] = providers
          let rejected =
            (try? Snapshot.decode(JSONSerialization.data(withJSONObject: invalid))) == nil
          try expect(rejected, "reject malformed " + mutation)
        }
      }
    }
    try expect(!decoded.isEmpty, "at least one fixture decoded")
    // Exhaustive original patrol frame selection samples, consumed by verify.mjs.
    var samples = [[String: Any]]()
    for provider in ["claude", "codex"] {
      let pet = Actor(provider, 0)
      for time in stride(from: 0.0, through: 20000.0, by: 17.0) {
        pet.travel = time
        let pose = pet.pose(resources.atlas, time, false, 640)
        samples.append([
          "provider": provider, "time": time, "x": pose.x, "flip": pose.flip, "file": pose.file,
        ])
      }
    }
    let probe = try Probe(directory: output)
    probe.write(
      [
        "checks": checks, "fixtures": decoded, "atlasSourceSha256": resources.atlas.sourceSha256,
        "sampleCount": samples.count,
      ], name: "headless-checks")
    probe.write(["samples": samples], name: "patrol-samples")
    print(
      "Native headless checks passed: \(checks.count); fixtures: \(decoded.count); samples: \(samples.count)"
    )
  }
  private static func tryAcquire(_ lock: InstanceLock) -> Bool { (try? lock.acquire()) ?? false }
}
