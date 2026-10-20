import SwiftUI

struct CompactProviderRow: View {
  let provider: ProviderSnapshot
  @ObservedObject var store: FixtureStore
  var showHealthAttention = true
  var railImage: CGImage?
  var observesVisibility = true
  var model: CompactProvider { CompactProvider(provider: provider, generatedAtMs: store.snapshot?.generatedAtMs ?? 0) }
  var style: WeeklyStyle { MenuSettings(raw: store.snapshot?.raw["settings"] ?? .null).weeklyStyle }
  var trackLabel: String {
    provider.label + ", five-hour usage " + model.window.valueText + ", " + model.window.freshnessText + ". "
      + (model.fiveHourReset().map { "Five-hour window " + $0 + ". " } ?? "")
      + ConfiguredThreshold.rows(provider, window: "five_hour").map(\.label).joined(separator: ". ")
  }
  var stopped: Bool { ["pause", "ask"].contains(model.presentation.verdict) }
  var pauseOffers: [BridgeOffer] { stopped ? [] : model.presentation.offers.filter { $0.raw["op"].string == "pause" } }
  // A reading older than five minutes (backend "stale") fades with the rail, so a lagging number looks it.
  var numberOpacity: Double { model.window.freshness == "stale" ? 0.5 : 1 }
  var headerColor: Color { model.window.used == nil ? .secondary : model.fillTone == "indigo" ? .indigo : model.fillTone == "orange" ? .orange : .primary }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      track
      if style != .off { CompactWeekly(model: model, style: style).padding(.top, style == .bar ? 6 : 3) }
      if let recap = store.recap(provider) { RecapCaption(recap: recap, store: store, observesVisibility: observesVisibility).padding(.top, 6) }
      if ["pause", "ask"].contains(model.presentation.verdict) || (model.needsHealth && showHealthAttention) {
        CompactAttention(model: model, store: store).padding(.top, 9).transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
      .animation(store.reduced ? nil : .spring(response: 0.35, dampingFraction: 0.85), value: model.hasAttention)
      .animation(store.reduced ? nil : .spring(response: 0.35, dampingFraction: 0.85), value: style)
  }
  private var header: some View {
    HStack(alignment: .firstTextBaseline) {
      Text(provider.label).font(.system(size: 13))
      Spacer(minLength: 4)
      // The five-hour reset sits beside the % it belongs to; it gives way before the number does.
      if let reset = model.fiveHourReset() {
        Text(reset).font(.system(size: 11)).foregroundStyle(.secondary).monospacedDigit().lineLimit(1).layoutPriority(-1)
      }
      if !pauseOffers.isEmpty { pauseMenu }
      UsageNumber(text: model.window.used == nil ? "—" : model.window.valueText, value: model.window.used, animated: store.visible && !store.reduced).foregroundStyle(headerColor).opacity(numberOpacity)
        .accessibilityLabel(model.window.used == nil ? "No reading" : model.window.valueText + (model.window.freshness == "stale" ? ", older reading" : ""))
    }.frame(height: 18)
    // The long details and the right-click menu belong to the header and rail, not to every child.
    .help(model.fullDetails).contextMenu { contextControls }
  }
  // 0.3's menu had Pause as a visible item; a running agent keeps one, a stopped one has its card.
  // Click: pause until resumed. Right-click: pause for 1 hour. With only one offer, a click sends that one.
  private var untilResumed: BridgeOffer? { pauseOffers.first { $0.raw["params"]["duration"] == .null } }
  private var forOneHour: BridgeOffer? { pauseOffers.first { $0.raw["params"]["duration"].string == "1h" } }
  private var clickPause: BridgeOffer? { untilResumed ?? pauseOffers.first }
  private var menuPause: BridgeOffer? { untilResumed == nil ? nil : forOneHour }
  private func usable(_ offer: BridgeOffer) -> Bool { !store.fixtureMode && offer.eligible && !store.blockedProviders.contains(offer.key) }
  private var pauseMenu: some View {
    let title = clickPause.map { PresentationText.action($0, stopped: false) } ?? "Pause"
    return Button { if let clickPause { store.sendCurrent(clickPause) } } label: {
      Image(systemName: "pause.circle").font(.system(size: 13)).foregroundStyle(.secondary).frame(width: 18, height: 18).contentShape(Rectangle())
    }.buttonStyle(.plain).perasKeyboardButton()
      .disabled(clickPause.map(usable) != true)
      .contextMenu {
        if let menuPause {
          Button(PresentationText.action(menuPause, stopped: false)) { store.sendCurrent(menuPause) }.disabled(!usable(menuPause))
        }
      }
      .help(title.replacingOccurrences(of: "Pause", with: "Pause " + provider.label) + (menuPause == nil ? "." : ". Right-click to pause for 1 hour."))
      .accessibilityLabel(title.replacingOccurrences(of: "Pause", with: "Pause " + provider.label))
      .accessibilityAction(named: "Pause for 1 Hour") { if let menuPause, usable(menuPause) { store.sendCurrent(menuPause) } }
      .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 4 }
  }
  private var track: some View {
    Group {
      if let railImage { Image(decorative: railImage, scale: 2).interpolation(.none).resizable() }
      else { SpriteRail(store: store, providerID: provider.id) }
    }.frame(width: 288, height: 28).accessibilityElement(children: .ignore).accessibilityLabel(trackLabel).accessibilityAddTraits(.isImage)
      .help(model.fullDetails).contextMenu { contextControls }
  }
  @ViewBuilder private var contextControls: some View {
    ForEach(model.presentation.offers.filter { ["pause", "profile.use", "extra.daily"].contains($0.raw["op"].string ?? "") }) { offer in
      Button(PresentationText.action(offer, stopped: stopped)) { store.sendCurrent(offer) }
        .disabled(store.fixtureMode || !offer.eligible || store.blockedProviders.contains(offer.key))
        .help(offerNote(offer)).accessibilityHint(offerNote(offer))
    }
    Divider()
    Button("Set Up Peras…") { store.onOpenSetup?() }
  }
  private func offerNote(_ offer: BridgeOffer) -> String {
    let reason: String = PresentationText.disabled(offer.disabledReason) ?? ""
    let impact: String = model.presentation.impact(offer).joined(separator: ". ")
    return reason + " " + impact
  }
}

struct CompactWeekly: View {
  let model: CompactProvider
  let style: WeeklyStyle
  var details: String { (model.allowances + [model.weeklyCaption, model.weeklyReset ?? ""]).joined(separator: ". ") }
  var accessibilityText: String {
    details + (model.paceTarget.map { ". Plan by tonight " + PresentationText.number($0) + "%" } ?? "")
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      if style == .bar { CompactWeeklyBar(model: model) }
      caption
      if let extra = model.shortAllowance { Text(extra).font(.system(size: 10)).foregroundStyle(.secondary) }
    }.help(details).accessibilityElement(children: .combine).accessibilityLabel(accessibilityText)
  }
  private var caption: some View {
    Group {
      if style == .text {
        Text(model.weeklyCaption + (model.weeklyReset.map { " · " + $0 } ?? "")).lineLimit(1)
      } else {
        HStack(spacing: 3) {
          Text(model.weeklyCaption).lineLimit(1)
          Spacer(minLength: 2)
          if let reset = model.weeklyReset { Text(reset).lineLimit(1) }
        }
      }
    }.font(.system(size: 11)).foregroundStyle(.secondary).monospacedDigit()
  }
}
private struct CompactWeeklyBar: View {
  let model: CompactProvider
  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .leading) {
        if model.weekly.used != nil {
          Capsule().fill(Color.primary.opacity(0.08))
          // Lighter than the five-hour fill, so indigo keeps meaning "paused".
          Capsule().fill(Color.primary.opacity(0.24)).frame(width: geometry.size.width * model.weekly.fraction)
        } else {
          Path { path in path.move(to: CGPoint(x: 0, y: 1.5)); path.addLine(to: CGPoint(x: geometry.size.width, y: 1.5)) }
            .stroke(Color.primary.opacity(0.1), style: StrokeStyle(lineWidth: 3, dash: [6, 4]))
        }
        if let target = model.paceTarget {
          Rectangle().fill(Color.indigo).frame(width: 1.5, height: 7)
            .offset(x: max(0, min(geometry.size.width - 1.5, geometry.size.width * target / 100)))
            .accessibilityLabel("Plan by tonight: " + PresentationText.number(target) + "%")
        }
      }
    }.frame(height: 3)
  }
}

struct CompactAttention: View {
  let model: CompactProvider
  @ObservedObject var store: FixtureStore
  var color: Color { model.tone == "indigo" ? .indigo : model.tone == "blue" ? .blue : .orange }
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(model.title).font(.system(size: 12, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
      Text(model.detail).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      if ["pause", "ask"].contains(model.presentation.verdict) {
        HStack(spacing: 5) {
          if let resume = model.resume {
            Button { store.send(resume) } label: {
              HStack(spacing: 5) {
                if store.visible && store.resumingProviders.contains(resume.key) { ProgressView().controlSize(.small).tint(PearPalette.buttonLabelColor) }
                Text(store.resumingProviders.contains(resume.key) ? "Resuming…" : model.manualOnly ? "Resume" : "Resume for 1 Hour")
              }
            }.buttonStyle(PearButtonStyle())
              .disabled(store.fixtureMode || !resume.eligible || store.blockedProviders.contains(resume.key))
              .help((model.presentation.impact(resume) + [PresentationText.disabled(resume.disabledReason) ?? ""]).joined(separator: ". "))
              .accessibilityHint((model.presentation.impact(resume) + [PresentationText.disabled(resume.disabledReason) ?? ""]).filter { !$0.isEmpty }.joined(separator: ". "))
              .perasKeyboardButton()
          }
          // Approval asks before each prompt; this button would turn that into a full pause, so it says so.
          if let pause = model.pauseIndefinitely {
            let asking = model.presentation.verdict == "ask"
            Button(asking ? "Pause Until Resumed" : "Keep Paused") { store.send(pause) }
              .disabled(store.fixtureMode || !pause.eligible || store.blockedProviders.contains(pause.key))
              .help(PresentationText.disabled(pause.disabledReason) ?? (asking ? "Stops every prompt instead of asking, until you resume." : "Stays paused after the line lifts, until you resume."))
              .accessibilityHint(PresentationText.disabled(pause.disabledReason) ?? (asking ? "Stops every prompt instead of asking, until you resume." : "Stays paused after the line lifts, until you resume."))
              .perasKeyboardButton()
          }
        }.controlSize(.small).font(.system(size: 11)).padding(.top, 3)
        if model.resume == nil && model.pauseIndefinitely == nil {
          Text("To resume now, run " + (model.provider.id == "codex" ? "peras codex resume" : "peras resume") + " in your terminal.")
            .font(.system(size: 10)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        Text("Other stops stay in effect; usage is not erased.").font(.system(size: 10)).foregroundStyle(.secondary)
      } else {
        Button("Finish Setup…") { store.onOpenSetup?() }.controlSize(.small).perasKeyboardButton()
      }
    }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
      .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 9))
      .overlay(RoundedRectangle(cornerRadius: 9).stroke(color.opacity(0.22), lineWidth: 0.5))
      .help(model.fullDetails).accessibilityElement(children: .contain)
  }
}

