import Darwin
import Foundation
import ServiceManagement

/// Open at Login. Only a production build changes the person's login items.
enum LoginItem {
  enum State { case on, off, needsApproval, unavailable }
  static var state: State {
    #if PERAS_PRODUCTION
    switch SMAppService.mainApp.status {
    case .enabled: return .on
    case .requiresApproval: return .needsApproval
    default: return .off
    }
    #else
    return .unavailable
    #endif
  }
  @discardableResult static func set(_ on: Bool) -> Bool {
    #if PERAS_PRODUCTION
    do {
      if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
      return true
    } catch { return false }
    #else
    return false
    #endif
  }
  /// After a rollback the installed runtime is older than this app's (0.3 under a 0.4 app):
  /// a login launch would only show a broken second pear next to SwiftBar's.
  static func runtimeIsOlder(_ installed: String, than expected: String) -> Bool {
    guard let have = RuntimeLine.parts(installed), let want = RuntimeLine.parts(expected) else { return false }
    return have.lexicographicallyPrecedes(want)
  }
  static func installedRuntime(cli: String) -> String? {
    let package = URL(fileURLWithPath: cli).resolvingSymlinksInPath().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("package.json")
    guard let data = try? LaunchRecord.regularData(package),
      let metadata = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return metadata["version"] as? String
  }
}

// An app runs any runtime from its own major.minor line: `peras update` to a patch release keeps the
// downloaded app working; the bridge's protocol number is the wire contract.
enum RuntimeLine {
  static func parts(_ text: String) -> [Int]? {
    let numbers = text.split(separator: "-").first.map { $0.split(separator: ".").prefix(2).map { Int($0) } } ?? []
    return numbers.count == 2 && numbers.allSatisfy { $0 != nil } ? numbers.map { $0! } : nil
  }
  static func same(_ a: String, _ b: String) -> Bool {
    guard let left = parts(a), let right = parts(b) else { return false }
    return left == right
  }
}

enum LaunchPresentation {
  static func label(fixture: Bool, development: Bool) -> String? {
    fixture ? "Preview" : development ? "Demo" : nil
  }
}
// Machine-specific launch data stays outside the immutable bundle.
enum LaunchFailure: Error {
  case install, node
  case runtime(String)
  var message: String {
    switch self {
    case .install: return "Peras needs its launch configuration. Run peras menubar install --native, then reopen Peras."
    case .runtime(let version): return "Peras \(version) needs the matching Peras app. Download it again from your purchase (peras.vertias.eu/app) or build it yourself, then run peras menubar install --native --app ~/Downloads/Peras.app."
    case .node: return "Node.js is required; install the current LTS from nodejs.org/en/download, then reopen Peras."
    }
  }
}
enum LaunchRoot {
  static func resolve(bundle: URL, explicit: String?, environment: [String: String], development: Bool) -> String {
    let installed = bundle.resolvingSymlinksInPath().standardizedFileURL
    if !development, installed.lastPathComponent == "Peras.app",
      installed.deletingLastPathComponent().lastPathComponent == "native" {
      return installed.deletingLastPathComponent().deletingLastPathComponent().path
    }
    let home = environment["HOME"].flatMap { LaunchRecord.absolute($0) ? $0 : nil } ?? NSHomeDirectory()
    let fallback = development ? NSTemporaryDirectory() + "peras-native-preview-\(getuid())" : home + "/.peras"
    let path = explicit ?? environment["PERAS_HOME"] ?? fallback
    // Invalid relative roots must not resolve against an arbitrary Finder working directory.
    guard LaunchRecord.absolute(path) else { return fallback }
    return (try? InstanceLock(path: path).root.path) ?? path
  }
}
struct LaunchRecord: Decodable {
  let schema: Int
  let runtimeVersion: String
  let node: String
  let nodeVersion: String
  let nodeMin: Int
  let cli: String
  let fallbackNodes: [String]
  let nodeFix: String
  let environment: [String: String]
  static func absolute(_ value: String) -> Bool {
    value.hasPrefix("/") && !value.utf8.contains(0) && !value.contains("\n") && !value.contains("\r")
  }
  static func version(_ text: String, prefix: Bool = true) -> Int? {
    let pattern = prefix ? "^v[0-9]+\\.[0-9]+\\.[0-9]+\\n?\\z" : "^[0-9]+\\.[0-9]+\\.[0-9]+\\z"
    guard text.range(of: pattern, options: .regularExpression) != nil else { return nil }
    return Int(text.dropFirst(prefix ? 1 : 0).split(separator: ".")[0])
  }
  static func load(root: String) throws -> LaunchRecord {
    do {
      let file = URL(fileURLWithPath: root).appendingPathComponent("native/launch.json")
      let data = try regularData(file)
      return try JSONDecoder().decode(LaunchRecord.self, from: data).validated()
    } catch { throw LaunchFailure.install }
  }
  static func regularData(_ file: URL) throws -> Data {
    let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
    guard attributes[.type] as? FileAttributeType == .typeRegular,
      let size = attributes[.size] as? NSNumber, size.intValue <= 65_536
    else { throw LaunchFailure.install }
    let handle = try FileHandle(forReadingFrom: file)
    defer { try? handle.close() }
    let data = try handle.read(upToCount: 65_537) ?? Data()
    guard data.count <= 65_536 else { throw LaunchFailure.install }
    return data
  }
  static func regularCLI(_ path: String) -> Bool {
    var directory: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &directory) && !directory.boolValue && FileManager.default.isReadableFile(atPath: path)
  }
  func validated() throws -> LaunchRecord {
    guard schema == 1, nodeMin == 18, Self.absolute(node), Self.absolute(cli),
      Self.version(nodeVersion, prefix: false).map({ $0 >= nodeMin }) == true,
      runtimeVersion.range(of: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?\\z", options: .regularExpression) != nil,
      fallbackNodes.count <= 16, fallbackNodes.allSatisfy(Self.absolute),
      nodeFix == LaunchFailure.node.message,
      Set(environment.keys).isSubset(of: ["PERAS_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PATH"]),
      environment.allSatisfy({ key, value in
        key == "PATH" || Self.absolute(value)
      }), Self.regularCLI(cli)
    else { throw LaunchFailure.install }
    return self
  }
  // Up to 17 candidates, each given the first-run allowance below, within one total budget.
  func configuration(root: String, home: String, expectedRuntime: String?,
    probeTimeout: Double = NodeVersionProbe.timeout, budget: Double = NodeVersionProbe.budget) throws -> BridgeConfiguration {
    _ = try validated()
    guard Self.absolute(root), Self.absolute(home) else { throw LaunchFailure.install }
    let canonical = try InstanceLock(path: root).root.path
    if let recorded = environment["PERAS_HOME"] {
      guard try InstanceLock(path: recorded).root.path == canonical else { throw LaunchFailure.install }
    }
    guard let expectedRuntime, RuntimeLine.same(expectedRuntime, runtimeVersion) else {
      throw expectedRuntime.map { RuntimeLine.parts($0) != nil && RuntimeLine.parts(runtimeVersion) != nil } == true ? LaunchFailure.runtime(runtimeVersion) : LaunchFailure.install
    }
    do {
      let package = URL(fileURLWithPath: cli).resolvingSymlinksInPath().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("package.json")
      let metadata = try JSONSerialization.jsonObject(with: Self.regularData(package)) as? [String: Any]
      guard metadata?["version"] as? String == runtimeVersion else { throw LaunchFailure.install }
    } catch { throw LaunchFailure.install }
    var env = environment
    env["HOME"] = home
    env["PERAS_HOME"] = canonical
    let entries = (env["PATH"] ?? "").split(separator: ":").map(String.init).filter(Self.absolute)
    env["PATH"] = entries.isEmpty ? "/usr/bin:/bin" : entries.joined(separator: ":")
    var tried = Set<String>()
    let end = ProcessInfo.processInfo.systemUptime + budget
    for candidate in [node] + fallbackNodes where tried.insert(candidate).inserted {
      let left = end - ProcessInfo.processInfo.systemUptime
      guard left > 0 else { break }
      if NodeVersionProbe.supported(candidate, environment: env, timeout: min(probeTimeout, left)) {
        return try BridgeConfiguration.installed(node: candidate, cli: cli, environment: env, runtimeVersion: runtimeVersion).validated()
      }
    }
    throw LaunchFailure.node
  }
}
enum NodeVersionProbe {
  // macOS checks a newly written executable before its first run: a freshly installed or
  // upgraded Node measured 3.0–5.9 s before printing anything (0.02 s on later runs), and a
  // new script up to a second under load. A 1 s deadline refused a working Node after
  // every upgrade. A hung candidate still costs at most this, and all of them `budget`.
  static let timeout = 15.0
  static let budget = 30.0
  private static let lock = NSLock()
  private static var cancelled = false
  private static var active = [Process]()
  static func cancelAll() {
    lock.lock(); cancelled = true; let children = active; lock.unlock()
    for child in children where child.isRunning { child.terminate() }
    let end = ProcessInfo.processInfo.systemUptime + 0.2
    while children.contains(where: { $0.isRunning }) && ProcessInfo.processInfo.systemUptime < end { Thread.sleep(forTimeInterval: 0.005) }
    for child in children where child.isRunning { kill(child.processIdentifier, SIGKILL) }
  }

  #if !PERAS_PRODUCTION
  // What the last probe saw and how long it took, so a failed check says why. Development only.
  static var last: (outcome: String, milliseconds: Double) { lock.lock(); defer { lock.unlock() }; return lastProbe }
  private static var lastProbe = (outcome: "none", milliseconds: 0.0)
  #endif
  // Never called on the main thread by the application. No shell, search or raw child diagnostics.
  static func supported(_ path: String, environment: [String: String], timeout: Double = timeout) -> Bool {
    guard LaunchRecord.absolute(path), FileManager.default.isExecutableFile(atPath: path) else { return false }
    let child = Process(), output = Pipe()
    child.executableURL = URL(fileURLWithPath: path)
    child.arguments = ["--version"]
    child.environment = environment
    child.currentDirectoryURL = URL(fileURLWithPath: environment["HOME"] ?? "/")
    child.standardInput = FileHandle.nullDevice
    child.standardOutput = output
    child.standardError = FileHandle.nullDevice
    let fd = output.fileHandleForReading.fileDescriptor
    _ = fcntl(fd, F_SETFL, O_NONBLOCK)
    lock.lock()
    guard !cancelled else { lock.unlock(); return false }
    do { try child.run(); active.append(child); lock.unlock() }
    catch { lock.unlock(); return false }
    defer { lock.lock(); active.removeAll { $0 === child }; lock.unlock() }

    try? output.fileHandleForWriting.close()
    let started = ProcessInfo.processInfo.systemUptime, deadline = started + timeout
    var data = Data(), noisy = false
    func drain() {
      var buffer = [UInt8](repeating: 0, count: 1024)
      while true {
        let count = Darwin.read(fd, &buffer, buffer.count)
        if count <= 0 { break }
        if data.count + count > 4096 { noisy = true; break }
        data.append(contentsOf: buffer.prefix(count))
      }
    }
    while child.isRunning && ProcessInfo.processInfo.systemUptime < deadline && !noisy {
      drain(); Thread.sleep(forTimeInterval: 0.005)
    }
    let expired = child.isRunning
    if expired { child.terminate() }
    let grace = ProcessInfo.processInfo.systemUptime + 0.1
    while child.isRunning && ProcessInfo.processInfo.systemUptime < grace { Thread.sleep(forTimeInterval: 0.005) }
    if child.isRunning { kill(child.processIdentifier, SIGKILL) }
    let reap = ProcessInfo.processInfo.systemUptime + 0.2
    while child.isRunning && ProcessInfo.processInfo.systemUptime < reap { Thread.sleep(forTimeInterval: 0.005) }
    drain()
    try? output.fileHandleForReading.close()
    let running = child.isRunning
    let text = String(data: data, encoding: .utf8)
    let major = text.flatMap { LaunchRecord.version($0) }
    #if !PERAS_PRODUCTION
    let outcome = expired ? "expired after \(data.count) bytes" : noisy ? "noisy" : running ? "unreaped"
      : child.terminationStatus != 0 ? "status \(child.terminationStatus)" : major == nil ? "unparsed" : major! < 18 ? "unsupported" : "supported"
    lock.lock(); lastProbe = (outcome, (ProcessInfo.processInfo.systemUptime - started) * 1000); lock.unlock()
    #endif
    guard !expired, !noisy, !running, child.terminationStatus == 0, let major, major >= 18 else { return false }
    return true
  }
}
