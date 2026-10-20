import AppKit
import Combine
import QuartzCore

final class FixtureStore: ObservableObject {
  @Published var snapshot: Snapshot?
  @Published private(set) var cachedSnapshot: Snapshot?
  @Published private(set) var bridgeRecovery: BridgeRecovery?
  @Published var fixtureName = ""
  @Published var error: String?
  @Published var reducedOverride = false
  @Published var connection = "Fixture preview"
  @Published private(set) var resumingProviders = Set<String>()
  @Published var blockedProviders = Set<String>()
  @Published var actionMessage: String?
  @Published var settingsSelectedTab = "general"
  @Published var settingsExpanded = false
  @Published var debugExpanded = false
  @Published var desktopPinned = false
  @Published var desktopMessage: String?
  @Published var shortcutEnabled = true
  @Published var shortcutChoice = 0
  @Published var shortcutMessage = ""
  @Published var openAtLogin = false
  @Published var loginItemNote: String?
  @Published var retryIntents = [String: String]()
  private var sentOperations = [String: String]()
  var renderObservers = [UUID: () -> Void]()
  var onOpenSettings: (() -> Void)?
  var onOpenSetup: (() -> Void)?
  var onOpenDiagnostics: (() -> Void)?
  var onMenuHeight: ((CGFloat) -> Void)?
  @Published var previewReduceTransparency = false
  @Published var previewHighContrast = false
  @Published var menuContentHeight: CGFloat = 350
  @Published var menuViewportHeight: CGFloat = 350
  private var sentOffers = [String: String]()
  private var retryCommands = Set<String>()
  private var busyAwaitingSnapshot = Set<String>()
  var onPin: (() -> Void)?
  var onShortcutChange: (() -> Void)?
  var onOpenAtLoginChange: ((Bool) -> Void)?
  var onRefreshLoginItem: (() -> Void)?
  let recapCoordinator: RecapCoordinator
  let fixtureMode: Bool
  let developmentMode: Bool
  // The site's picture of the menu (menu probe --site-image) is the fixture menu without its "Preview" badge.
  var previewLabelHidden = false
  var previewLabel: String? { previewLabelHidden ? nil : LaunchPresentation.label(fixture: fixtureMode, development: developmentMode) }
  var bridge: BridgeClient?
  var onStateInvalidated: (() -> Void)?
  var onAppliedSnapshot: ((Snapshot) -> Void)?
  private(set) var activityTransitions = 0
  private var resetTracker = WindowResetTracker()
  let actors = [Actor("claude", 1350), Actor("codex", 6400)]
  let resources: SpriteResources
  let fixtureDirectory: URL
  var fixtures: [URL] {
    ((try? FileManager.default.contentsOfDirectory(
      at: fixtureDirectory, includingPropertiesForKeys: nil)) ?? []).filter {
        $0.pathExtension == "json"
      }.sorted { $0.lastPathComponent < $1.lastPathComponent }
  }
  var mascotsEnabled: Bool { snapshot?.raw["settings"]["preferences"]["mascots"].bool ?? true }
  var weeklyEnabled: Bool { SettingsPresentation(raw: snapshot?.raw["settings"] ?? .null).weekly }
  var reduced: Bool { reducedOverride || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
  private(set) var visible = false
  private(set) var visibilityTransitions = 0
  private(set) var timer: Timer?
  private(set) var ticks = 0
  private(set) var logicalNow = 0.0
  private var previous = 0.0
  private var fiveHourUsage = [String: Double]()
  var render: (() -> Void)?
  init(resources: SpriteResources, fixtureDirectory: URL, fixtureMode: Bool = true, developmentMode: Bool = false, presentationRoot: URL? = nil) {
    recapCoordinator = RecapCoordinator(root: presentationRoot, fixture: fixtureMode)
    self.fixtureMode = fixtureMode
    self.developmentMode = developmentMode
    self.resources = resources
    self.fixtureDirectory = fixtureDirectory
    if fixtureMode, let first = fixtures.first { load(first) }
    NSWorkspace.shared.notificationCenter.addObserver(
      self, selector: #selector(accessibilityChanged),
      name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
  }
  func load(_ url: URL) {
    do {
      let decoded = try Snapshot.decode(Data(contentsOf: url))
      guard fixtureMode else { return }
      fixtureName = url.deletingPathExtension().lastPathComponent
      apply(decoded)
    } catch { self.error = "Fixture could not be decoded" }
  }
  var currentOffers: [BridgeOffer] {
    guard let snapshot else { return [] }
    return snapshot.providers.flatMap { $0.payload["actions"].array }.map { BridgeOffer(raw: $0) }
      + snapshot.raw["settings"]["actions"].array.map { BridgeOffer(raw: $0) }
      + (snapshot.raw["discovery"]["suggestion"]["dismiss"] == .null ? [] : [BridgeOffer(raw: snapshot.raw["discovery"]["suggestion"]["dismiss"])])
  }
  func apply(_ decoded: Snapshot) {
    if actionMessage == "Saved. Waiting for the refreshed state." || actionMessage == "Test completed. Waiting for the refreshed result."
      || actionMessage == "The stop changed. Review it again."
    {
      actionMessage = nil
    }
    if !busyAwaitingSnapshot.isEmpty {
      busyAwaitingSnapshot.removeAll()
      actionMessage = retryIntents.isEmpty
        ? "Fresh state received. Another change was being saved; review the current offers."
        : "Another change was being saved. Review the refreshed state before retrying once."
    } else if actionMessage?.hasPrefix("Result uncertain") == true {
      actionMessage = "Fresh state received. Review the current offers before making another change."
    }
    let previouslyEnabled = mascotsEnabled
    if let previous = snapshot {
      let changedKeys = Set(decoded.providers.filter { current in
        previous.providers.first { $0.id == current.id }?.payload["accountContextId"]
          != current.payload["accountContextId"]
      }.map(\.id))
      if !changedKeys.isEmpty { recapCoordinator.clearSession() }
      retryIntents = retryIntents.filter { !changedKeys.contains($0.key) && ($0.key != "global" || changedKeys.isEmpty) }
    }
    // Scalar frame inputs are derived once per authoritative snapshot. The 60Hz
    // readiness and layer paths never construct display models or format dates.
    fiveHourUsage = Dictionary(uniqueKeysWithValues: decoded.providers.compactMap { provider in
      let row = provider.windows.first { $0["window"].string == "five_hour" } ?? .null
      return WindowPresentation.readingValue(row).map { (provider.id, $0) }
    })
    cachedSnapshot = nil
    bridgeRecovery = nil
    snapshot = decoded
    let availableIDs = Set(currentOffers.map(\.id))
    retryIntents = retryIntents.filter { availableIDs.contains($0.value) }
    if previouslyEnabled != mascotsEnabled { activityTransitions += 1 }
    if !mascotsEnabled {
      resetTracker.hidden()
      actors.forEach { $0.reaction = nil }
    }
    error = nil
    for actor in actors {
      let paused = decoded.providers.first { $0.id == actor.provider }?.paused ?? false
      if actor.paused != paused {
        activityTransitions += 1
        actor.trigger(paused ? "pause" : "resume", logicalNow, reduced || !mascotsEnabled)
      }
    }
    if !fixtureMode {
      let greetings = resetTracker.consume(decoded, visible: visible && mascotsEnabled)
      if !reduced && mascotsEnabled {
        for actor in actors where actor.reaction == nil {
          if let identity = greetings[actor.provider] {
            if actor.trigger("greet", logicalNow, false, identity) { activityTransitions += 1 }
          }
        }
      }
    }
    refresh()
    onAppliedSnapshot?(decoded)
  }
  func recap(_ provider: ProviderSnapshot) -> WeeklyRecap? {
    recapCoordinator.candidate(provider, generatedAtMs: snapshot?.generatedAtMs ?? 0)
  }
  func markRecapVisible(_ recap: WeeklyRecap) {
    guard visible, let provider = snapshot?.providers.first(where: { $0.id == recap.provider.rawValue }),
      let current = self.recap(provider), current.ledgerKey == recap.ledgerKey else { return }
    if recapCoordinator.consume(current, visible: true) {
      if let failure = recapCoordinator.persistenceError { actionMessage = failure }
      objectWillChange.send()
    }
  }
  func connect(_ client: BridgeClient) {
    guard !fixtureMode else { return }
    bridge = client
    client.onRecovery = { [weak self] recovery in self?.bridgeRecovery = recovery }
    client.onSnapshot = { [weak self] snapshot in self?.apply(snapshot) }
    client.onState = { [weak self] state, blocked in self?.receiveState(state, blocked: blocked) }
    client.onResult = { [weak self] key, ok, code in
      let operation = self?.sentOperations.removeValue(forKey: key)
      if !ok { self?.resumingProviders.remove(key) }
      self?.recordResult(key: key, code: code)
      self?.actionMessage = ok && operation == "protection.test" ? "Test completed. Waiting for the refreshed result." : ok && ["link.open", "status.open", "settings.open"].contains(operation ?? "") ? "Opened." : ok
        ? "Saved. Waiting for the refreshed state."
        : PresentationText.result(code)
    }
    client.start()
  }
  func retryConnection() {
    guard !fixtureMode, bridgeRecovery != nil else { return }
    bridge?.retry()
  }
  func refreshAtTimeBoundary() {
    recapCoordinator.clearSession()
    resetTracker = WindowResetTracker()
    actors.filter { $0.reaction?.kind == "greet" }.forEach { $0.reaction = nil }
    objectWillChange.send()
    bridge?.refresh()
    refresh()
  }
  func receiveState(_ state: String, blocked: Set<String>) {
    connection = state
    blockedProviders = blocked
    resumingProviders.formIntersection(blocked)
    if state.hasPrefix("Offer changed") || state.hasPrefix("Link changed") { actionMessage = state }
    if state == "Connecting" || state.hasPrefix("Refreshing") || state.hasPrefix("Disconnected") || state.hasPrefix("Result uncertain") {
      retryIntents.removeAll()
      sentOffers.removeAll()
      sentOperations.removeAll()
      recapCoordinator.clearSession()
      resumingProviders.removeAll()
      retryCommands.removeAll()
      busyAwaitingSnapshot.removeAll()
      if state.hasPrefix("Result uncertain") { actionMessage = state }
      fiveHourUsage.removeAll()
      if let snapshot { cachedSnapshot = snapshot.cachedPresentation() }
      snapshot = nil
      blockedProviders.formUnion(["claude", "codex", "global"])
      onStateInvalidated?()
      refresh()
      resetTracker = WindowResetTracker()
    }
  }
  // A menu can stay open across snapshots, and every token rolls (timed offers' expiry too). Once the
  // queued snapshots apply, send the offer as it is now, only if everything shown about it is unchanged.
  static func reviewed(_ offer: BridgeOffer) -> JSONValue {
    guard case .object(var fields) = offer.raw else { return offer.raw }
    fields["actionToken"] = nil; fields["expiresAtMs"] = nil
    return .object(fields)
  }
  func sendCurrent(_ offer: BridgeOffer) {
    DispatchQueue.main.async { [self] in
      guard let current = currentOffers.first(where: { Self.reviewed($0) == Self.reviewed(offer) }) else {
        actionMessage = "Offer changed. Review it again."; return
      }
      send(current)
    }
  }
  func send(_ offer: BridgeOffer) {
    guard !fixtureMode, offer.eligible, offer.raw["op"].string != "failurePolicy.set", !blockedProviders.contains(offer.key) else { return }
    if retryIntents[offer.key] == offer.id { retryCommands.insert(offer.key) }
    sentOperations[offer.key] = offer.raw["op"].string
    if offer.raw["op"].string == "resume" { resumingProviders.insert(offer.key) }
    sentOffers[offer.key] = offer.id
    retryIntents.removeValue(forKey: offer.key)
    blockedProviders.insert(offer.key)
    actionMessage = "Waiting for Peras…"
    bridge?.send(offer)
  }
  func recordResult(key: String, code: String?) {
    let id = sentOffers.removeValue(forKey: key)
    let wasRetry = retryCommands.remove(key) != nil
    if code == "busy" { busyAwaitingSnapshot.insert(key) }
    if code == "busy", !wasRetry, let id { retryIntents[key] = id }
    else { retryIntents.removeValue(forKey: key) }
  }
  var retryOffers: [BridgeOffer] {
    guard snapshot != nil else { return [] }
    return currentOffers.filter {
      retryIntents[$0.key] == $0.id && !busyAwaitingSnapshot.contains($0.key)
        && $0.eligible && !blockedProviders.contains($0.key)
    }
  }
  func retryOnce(_ offer: BridgeOffer) {
    guard retryOffers.contains(offer) else { return }
    send(offer)
    retryCommands.insert(offer.key)
  }
  func openLink(_ link: DiscoveryLink) {
    guard !fixtureMode, !blockedProviders.contains("global"), DiscoveryLink.rows(snapshot).contains(link) else { return }
    blockedProviders.insert("global")
    sentOperations["global"] = "link.open"
    bridge?.openLink(link.id)
  }
  func fiveHourUsed(for provider: String) -> Double? { fiveHourUsage[provider] }
  func hasReading(_ actor: Actor) -> Bool { fiveHourUsage[actor.provider] != nil }

  // Visual simulations never dispatch a command or claim guard success.
  func simulate(_ kind: String, provider: String) {
    guard fixtureMode, mascotsEnabled else { return }
    actors.first { $0.provider == provider }?.trigger(
      kind, logicalNow, reduced, kind == "greet" ? UUID().uuidString : nil)
    refresh()
  }
  func setVisible(_ value: Bool) {
    if visible != value { visibilityTransitions += 1 }
    if !value { resetTracker.hidden(); recapCoordinator.clearSession() }
    visible = value
    refresh()
  }
  @objc func accessibilityChanged() {
    if reduced { actors.forEach { $0.reaction = nil } }
    refresh()
  }
  func refresh() {
    let moving =
      visible && mascotsEnabled && !reduced && actors.contains { hasReading($0) && (!$0.paused || $0.reaction != nil) }
    if moving && timer == nil {
      previous = CACurrentMediaTime()
      let timer = Timer(timeInterval: 1 / 60, repeats: true) { [weak self] _ in self?.advance() }
      timer.tolerance = 0.002
      self.timer = timer
      RunLoop.main.add(timer, forMode: .common)
    } else if !moving {
      timer?.invalidate()
      timer = nil
    }
    render?()
    for callback in Array(renderObservers.values) { callback() }
  }
  private func advance() {
    let now = CACurrentMediaTime()
    let delta = max(0, (now - previous) * 1000)
    previous = now
    logicalNow += delta
    ticks += 1
    actors.filter { hasReading($0) }.forEach { $0.tick(delta, logicalNow, reduced) }
    refresh()
  }
  deinit {
    timer?.invalidate()
    NSWorkspace.shared.notificationCenter.removeObserver(self)
  }
}
