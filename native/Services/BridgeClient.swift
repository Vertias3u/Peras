import Darwin
import Foundation

struct BridgeConfiguration: Codable {
  let node: String
  let cli: String
  let environment: [String: String]
  let fakeCodex: String
  init(node: String, cli: String, environment: [String: String], fakeCodex: String) {
    self.node = node; self.cli = cli; self.environment = environment; self.fakeCodex = fakeCodex
  }
  private var production = false
  private(set) var installedRuntimeVersion: String?
  var isProduction: Bool { production }
  private enum CodingKeys: String, CodingKey { case node, cli, environment, fakeCodex }
  static func installed(node: String, cli: String, environment: [String: String], runtimeVersion: String? = nil) -> BridgeConfiguration {
    var value = BridgeConfiguration(node: node, cli: cli, environment: environment, fakeCodex: "")
    value.production = true
    value.installedRuntimeVersion = runtimeVersion
    return value
  }
  func validated() throws -> BridgeConfiguration {
    let manager = FileManager.default
    if production {
      guard LaunchRecord.absolute(node), LaunchRecord.absolute(cli),
        manager.isExecutableFile(atPath: node), manager.fileExists(atPath: cli),
        environment["HOME"].map(LaunchRecord.absolute) == true,
        environment["PERAS_HOME"].map(LaunchRecord.absolute) == true,
        Set(environment.keys).isSubset(of: ["HOME", "PERAS_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PATH"])
      else { throw LaunchFailure.install }
      return self
    }
    guard node.hasPrefix("/"), cli.hasPrefix("/"), fakeCodex.hasPrefix("/"),
      manager.isExecutableFile(atPath: node), manager.fileExists(atPath: cli),
      manager.isExecutableFile(atPath: fakeCodex),
      environment["PATH"]?.split(separator: ":").first.map(String.init)
        == URL(fileURLWithPath: fakeCodex).deletingLastPathComponent().path
    else { throw BridgeError.unavailable }
    for name in ["HOME", "PERAS_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PERAS_SWIFTBAR_DIR"] {
      guard environment[name]?.hasPrefix("/") == true else { throw BridgeError.unavailable }
    }
    let allowed: Set<String> = [
      "HOME", "PERAS_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PERAS_SWIFTBAR_DIR", "PATH",
      "PERAS_NO_NOTIFY", "LANG", "TZ", "PERAS_NATIVE_FAKE_CODEX_LOG",
    ]
    guard Set(environment.keys).isSubset(of: allowed) else { throw BridgeError.unavailable }
    return self
  }
}
private final class BridgeEpoch {
  private let lock = NSLock()
  private var active = true
  var valid: Bool {
    lock.lock()
    defer { lock.unlock() }
    return active
  }
  func invalidate() {
    lock.lock()
    active = false
    lock.unlock()
  }
}
enum BridgeRecovery: Equatable {
  case compatibility, dependency, installation, unavailable
  var message: String {
    switch self {
    case .compatibility: return "This Peras app cannot read the installed runtime. Update Peras and reinstall its native app, then retry. Changes are unavailable."
    case .dependency: return LaunchFailure.node.message
    case .installation: return LaunchFailure.install.message
    case .unavailable: return "Peras could not reconnect. Check the installation, then retry. Changes are unavailable."
    }
  }
}
final class BridgeClient {
  private let queue = DispatchQueue(label: "eu.vertias.peras.bridge")
  private var configuration: BridgeConfiguration
  private var recovery: BridgeRecovery?
  private var hasLaunched = false
  private let retryLock = NSLock()
  private var retryRequested = false
  private var process: Process?
  private var input: FileHandle?
  private var output: FileHandle?
  private var diagnostics: FileHandle?
  private var session = BridgeSession()
  private var framer = LineFramer()
  private var watchdog: DispatchSourceTimer?
  private var reconnect: DispatchWorkItem?
  private var refreshRequest: DispatchWorkItem?
  private var uncertainOutcome = false
  private var backoff = RetrySchedule()
  private var stopped = false
  private var epoch = BridgeEpoch()
  private var generation = 0
  private var authoritativeSince: Date?
  private var started = Date()
  private var lastRead = Date()
  private var partialStarted: Date?
  private var stderrBytes = 0
  var onRecovery: ((BridgeRecovery?) -> Void)?
  var onSnapshot: ((Snapshot) -> Void)?
  var onState: ((String, Set<String>) -> Void)?
  var onResult: ((String, Bool, String?) -> Void)?
  var onDiagnostic: ((String, [String: Any]) -> Void)?
  init(configuration: BridgeConfiguration) throws {
    self.configuration = try configuration.validated()
  }
  func start() {
    queue.async {
      self.stopped = false
      self.launch()
    }
  }
  // The protocol has no refresh verb. Replace only our owned connection, never a command.
  // Coalesce wake/clock/timezone notifications while invalidating old tokens immediately.
  func refresh() {
    queue.async {
      guard !self.stopped, self.recovery == nil, self.refreshRequest == nil else { return }
      self.reconnect?.cancel()
      self.reconnect = nil
      if !self.session.disconnect().isEmpty { self.uncertainOutcome = true }
      self.cleanup()
      self.publish(self.uncertainOutcome
        ? "Result uncertain. Review the refreshed state." : "Refreshing · waiting for authoritative state")
      let task = DispatchWorkItem { [weak self] in
        guard let self else { return }
        self.refreshRequest = nil
        self.launch()
      }
      self.refreshRequest = task
      self.queue.asyncAfter(deadline: .now() + 0.1, execute: task)
    }
  }
  // A deliberate retry starts a fresh connection only. Tokens and commands never survive it.
  func retry() {
    retryLock.lock()
    guard !retryRequested else { retryLock.unlock(); return }
    retryRequested = true
    retryLock.unlock()
    queue.async {
      defer {
        DispatchQueue.main.async {
          self.retryLock.lock(); self.retryRequested = false; self.retryLock.unlock()
        }
      }
      guard !self.stopped, self.recovery != nil else { return }
      self.recovery = nil
      self.backoff.reset()
      self.launch()
    }
  }
  // Busy means a command for this key is already in flight; its result settles the menu, so a
  // second click is dropped. Only a failed write to the bridge ends the connection.
  func send(_ offer: BridgeOffer) {
    queue.async {
      let data: Data
      do { data = try self.session.command(offer) }
      catch BridgeError.busy { return }
      catch { self.publish("Offer changed. Review it again."); return }
      do { try self.input?.write(contentsOf: data); self.publish("Connected") }
      catch { self.failed("write_failed") }
    }
  }
  func openLink(_ linkID: String) {
    queue.async {
      let data: Data
      do { data = try self.session.linkCommand(linkID) }
      catch BridgeError.busy { return }
      catch { self.publish("Link changed. Review the current menu."); return }
      do { try self.input?.write(contentsOf: data); self.publish("Connected") }
      catch { self.failed("write_failed") }
    }
  }
  private func launch() {
    guard !stopped, recovery == nil, process == nil else { return }
    if configuration.isProduction && hasLaunched {
      do {
        let root = configuration.environment["PERAS_HOME"]!
        configuration = try LaunchRecord.load(root: root).configuration(root: root,
          home: configuration.environment["HOME"]!, expectedRuntime: configuration.installedRuntimeVersion)
      } catch LaunchFailure.node { suspend(.dependency); return }
      catch { suspend(.installation); return }
    }
    hasLaunched = true
    reconnect = nil
    generation += 1
    epoch.invalidate()
    epoch = BridgeEpoch()
    let current = generation
    authoritativeSince = nil
    session = BridgeSession()
    framer = LineFramer()
    partialStarted = nil
    stderrBytes = 0
    let child = Process()
    let stdin = Pipe()
    let stdout = Pipe()
    let stderr = Pipe()
    child.executableURL = URL(fileURLWithPath: configuration.node)
    child.arguments = [configuration.cli, "menubar", "bridge", "--protocol", "1"]
    child.environment = configuration.environment
    child.currentDirectoryURL = URL(fileURLWithPath: configuration.environment["HOME"]!)
    child.standardInput = stdin
    child.standardOutput = stdout
    child.standardError = stderr
    input = stdin.fileHandleForWriting
    output = stdout.fileHandleForReading
    diagnostics = stderr.fileHandleForReading
    process = child
    started = Date()
    lastRead = started
    stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let bytes = handle.availableData
      self?.queue.async { [weak self] in self?.consume(bytes, generation: current) }
    }
    stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let count = handle.availableData.count
      self?.queue.async { [weak self] in
        guard let self, current == self.generation else { return }
        self.stderrBytes += count
        if self.stderrBytes > 65_536 { self.failed("diagnostic_limit") }
      }
    }
    child.terminationHandler = { [weak self] _ in
      self?.queue.async { [weak self] in
        guard let self, current == self.generation else { return }
        self.failed("child_exit")
      }
    }
    do {
      guard fcntl(stdin.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else {
        throw BridgeError.unavailable
      }
      try child.run()
      diagnostic(
        "child_started",
        [
          "pid": child.processIdentifier, "node": configuration.node, "cli": configuration.cli,
          "fakeCodex": configuration.fakeCodex,
        ])
      publish(uncertainOutcome ? "Result uncertain. Review the refreshed state." : "Connecting")
      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(100))
      timer.setEventHandler { [weak self] in self?.checkDeadline() }
      watchdog = timer
      timer.resume()
    } catch { failed("launch_failed") }
  }
  private func consume(_ bytes: Data, generation current: Int) {
    guard current == generation, !stopped else { return }
    guard !bytes.isEmpty else {
      failed("output_closed")
      return
    }
    lastRead = Date()
    do {
      let lines = try framer.append(bytes)
      for line in lines {
        switch try session.receive(line) {
        case .hello: publish("Connected · waiting for snapshot")
        case .snapshot(let snapshot):
          if authoritativeSince == nil { authoritativeSince = Date() }
          uncertainOutcome = false
          deliver { self.onSnapshot?(snapshot) }
          publish("Connected")
        case .result(let provider, let ok, let code):
          deliver { self.onResult?(provider, ok, code) }
          publish("Connected")
        case .ignored: break
        }
      }
      if framer.buffer.isEmpty {
        partialStarted = nil
      } else if !lines.isEmpty || partialStarted == nil {
        partialStarted = Date()
      }
    } catch SnapshotError.incompatible { suspend(.compatibility) }
    catch { failed("invalid_frame") }
  }
  private func checkDeadline() {
    guard !stopped else { return }
    if session.pending.values.contains(where: { Date().timeIntervalSince($0.sentAt) > 10 }) {
      failed("result_timeout")
    } else if session.bridgeInstance == nil && Date().timeIntervalSince(started) > 5 {
      failed("hello_timeout")
    } else if session.snapshot == nil && Date().timeIntervalSince(started) > 10 {
      failed("snapshot_timeout")
    } else if let partialStarted, Date().timeIntervalSince(partialStarted) > 10 {
      failed("line_timeout")
    } else if Date().timeIntervalSince(lastRead) > 75 {
      failed("read_timeout")
    }
  }
  private func failed(_ reason: String) {
    guard !stopped, process != nil else { return }
    let uncertain = session.disconnect()
    if !uncertain.isEmpty { uncertainOutcome = true }
    if let authoritativeSince, Date().timeIntervalSince(authoritativeSince) >= 30 { backoff.reset() }
    if backoff.failures >= 3 { suspend(.unavailable); return }
    let delay = backoff.next()
    diagnostic(reason, ["uncertainProviders": uncertain, "retrySeconds": delay])
    cleanup()
    publish(
      uncertainOutcome
        ? "Result uncertain. Review the refreshed state." : "Disconnected · retrying")
    let task = DispatchWorkItem { [weak self] in self?.launch() }
    reconnect = task
    queue.asyncAfter(deadline: .now() + delay, execute: task)
  }
  private func suspend(_ reason: BridgeRecovery) {
    if !session.disconnect().isEmpty { uncertainOutcome = true }
    recovery = reason
    reconnect?.cancel(); reconnect = nil
    refreshRequest?.cancel(); refreshRequest = nil
    cleanup()
    diagnostic("recovery_required", [:])
    publish(uncertainOutcome ? "Result uncertain. Changes unavailable." : "Disconnected · changes unavailable")
  }
  private func cleanup() {
    epoch.invalidate()
    epoch = BridgeEpoch()
    generation += 1
    watchdog?.cancel()
    watchdog = nil
    input?.closeFile()
    input = nil
    output?.readabilityHandler = nil
    diagnostics?.readabilityHandler = nil
    output?.closeFile()
    diagnostics?.closeFile()
    output = nil
    diagnostics = nil
    if let process {
      process.terminationHandler = nil
      if process.isRunning {
        process.terminate()
        waitForOwnedExit(process, seconds: 1)
        if process.isRunning {
          // Signal only the still-running Process we launched, never a name or group.
          kill(process.processIdentifier, SIGKILL)
          waitForOwnedExit(process, seconds: 1)
        }
        if process.isRunning { diagnostic("child_cleanup_timeout", [:]) }
      }
      // Foundation reaps its child and updates isRunning. waitUntilExit can enter an
      // unbounded nested CFRunLoop even after that update; never call it here.
    }
    process = nil
  }
  private func waitForOwnedExit(_ child: Process, seconds: TimeInterval) {
    let deadline = ProcessInfo.processInfo.systemUptime + seconds
    while child.isRunning && ProcessInfo.processInfo.systemUptime < deadline {
      Thread.sleep(forTimeInterval: 0.01)
    }
  }
  func stopAndWait() {
    queue.sync {
      stopped = true
      reconnect?.cancel()
      reconnect = nil
      refreshRequest?.cancel()
      refreshRequest = nil
      _ = session.disconnect()
      cleanup()
    }
  }
  private func publish(_ state: String) {
    let blocked = session.snapshot == nil ? Set(["claude", "codex", "global"])
      : Set(session.pending.keys).union(session.waitingForSnapshot)
    let recovery = self.recovery
    deliver {
      self.onRecovery?(recovery)
      self.onState?(state, blocked)
    }
  }
  private func deliver(_ action: @escaping () -> Void) {
    let deliveryEpoch = epoch
    DispatchQueue.main.async { if deliveryEpoch.valid { action() } }
  }
  private func diagnostic(_ event: String, _ fields: [String: Any]) {
    DispatchQueue.main.async { self.onDiagnostic?(event, fields) }
  }
}
