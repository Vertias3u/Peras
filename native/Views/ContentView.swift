import SwiftUI

private struct MenuHeightKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
struct ContentView: View {
  @ObservedObject var store: FixtureStore
  var railImages = [String: CGImage]()
  var measuresLayout = true
  @State private var shareController: ShareController?
  var setup: SetupPresentation { SetupPresentation(providers: store.snapshot?.providers ?? []) }
  var discovery: JSONValue { store.snapshot?.raw["discovery"]["suggestion"] ?? .null }
  var link: DiscoveryLink? {
    let id = discovery["link"].string ?? "passcontrol"
    return DiscoveryLink.rows(store.snapshot).first { $0.id == id }
  }
  var body: some View {
    ScrollView(.vertical) {
      menu.fixedSize(horizontal: false, vertical: true)
        .background(GeometryReader { geometry in Color.clear.preference(key: MenuHeightKey.self, value: geometry.size.height) })
    }
    .scrollDisabled(store.menuViewportHeight >= store.menuContentHeight - 1)
    .frame(width: 320)
    .background(store.previewReduceTransparency ? Color(nsColor: .windowBackgroundColor) : Color.clear)
    .tint(PearPalette.color)
    .environment(\.menuHighContrastOverride, store.previewHighContrast)
    .onPreferenceChange(MenuHeightKey.self) { height in
      guard measuresLayout, height.isFinite, height > 0, abs(height - store.menuContentHeight) > 0.5 else { return }
      store.menuContentHeight = height
      store.onMenuHeight?(height)
    }
  }
  var menu: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        Text("Peras").font(.system(size: 13, weight: .bold))
        if let label = store.previewLabel {
          Text(label).font(.system(size: 9, weight: .medium)).foregroundStyle(.secondary)
            .accessibilityLabel(store.fixtureMode ? "Read-only fixture preview" : "Isolated synthetic demo readings")
        }
        Spacer()
        Button { store.onPin?() } label: {
          FiniteSymbol(name: store.desktopPinned ? "pin.fill" : "pin", value: store.desktopPinned, animate: store.visible && !store.reduced).font(.system(size: 12)).frame(width: 22, height: 22)
        }.buttonStyle(.plain).help(store.desktopPinned ? "Unpin Peras" : "Keep Peras open")
          .accessibilityLabel(store.desktopPinned ? "Unpin Peras" : "Keep Peras open").perasKeyboardButton()
      }.frame(height: 22)
      Text("spend the last of your week on purpose").font(.system(size: 11)).foregroundStyle(.secondary).padding(.top, 1)
      if !setup.unfinished.isEmpty {
        HStack(spacing: 8) {
          VStack(alignment: .leading, spacing: 2) {
            SetupProgress(steps: setup.steps)
            Text(setup.caption).font(.system(size: 11)).foregroundStyle(.secondary)
          }
          Button("Finish Setup…") { store.onOpenSetup?() }.buttonStyle(PearButtonStyle()).perasKeyboardButton()
        }.padding(9).background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
          .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.orange.opacity(0.3), lineWidth: 0.5)).padding(.top, 9)
      }
      MenuHairline().padding(.top, 10).padding(.bottom, 10)
      VStack(alignment: .leading, spacing: 12) {
        ForEach(store.snapshot?.providers ?? []) { provider in CompactProviderRow(provider: provider, store: store, showHealthAttention: setup.unfinished.isEmpty, railImage: railImages[provider.id], observesVisibility: measuresLayout) }
        if store.snapshot == nil {
          VStack(alignment: .leading, spacing: 6) {
            Text(store.connection).font(.system(size: 11)).foregroundStyle(.secondary)
            if let cached = store.cachedSnapshot {
              if cached.generatedAtMs > Date().timeIntervalSince1970 * 1000 {
                Text("Last confirmed state · snapshot time is ahead of this clock. Changes unavailable.").font(.system(size: 10)).foregroundStyle(.secondary)
              } else {
                (Text("Last confirmed state · ") + Text(Date(timeIntervalSince1970: cached.generatedAtMs / 1000), style: .relative) + Text(" ago. Changes unavailable."))
                  .font(.system(size: 10)).foregroundStyle(.secondary)
              }
              ForEach(cached.providers) { provider in
                VStack(alignment: .leading, spacing: 2) {
                  Text(provider.label).font(.system(size: 12, weight: .medium))
                  ForEach(provider.windows.indices, id: \.self) { index in
                    let row = provider.windows[index]
                    let label = row["window"].string == "five_hour" ? "5-hour" : "Weekly"
                    if let used = row["used"].number, ["stale", "current"].contains(row["freshness"].string ?? "") {
                      Text("\(label): \(used, specifier: "%.0f")% · cached").font(.system(size: 11)).foregroundStyle(.secondary)
                    } else { Text("\(label): no usable cached reading").font(.system(size: 11)).foregroundStyle(.secondary) }
                  }
                }
              }
            }
          }.frame(minHeight: 100)
        }
      }
      if store.snapshot?.providers.contains(where: { $0.readError }) == true {
        Text("Peras couldn’t read settings or refresh usage.").font(.system(size: 11)).foregroundStyle(.secondary).padding(.top, 5)
      }
      if let message = store.actionMessage { Text(message).font(.system(size: 10)).foregroundStyle(.secondary).padding(.top, 5).fixedSize(horizontal: false, vertical: true) }
      ForEach(store.retryOffers) { offer in
        Button("Retry once · " + PresentationText.action(offer)) { store.retryOnce(offer) }.controlSize(.small).perasKeyboardButton().padding(.top, 4)
      }
      if let recovery = store.bridgeRecovery {
        Text(recovery.message).font(.system(size: 11)).foregroundStyle(.secondary).padding(.top, 5).fixedSize(horizontal: false, vertical: true)
        Button("Retry Connection") { store.retryConnection() }.controlSize(.small).perasKeyboardButton().padding(.top, 4)
      }
      if let error = store.error { Text(error).font(.system(size: 10)).foregroundStyle(.secondary).padding(.top, 4) }
      if let message = store.desktopMessage { Text(message).font(.system(size: 10)).foregroundStyle(.secondary).padding(.top, 4) }
      MenuHairline().padding(.top, 12).padding(.bottom, 5)
      MenuLine("Settings…", shortcut: "⌘,") { store.onOpenSettings?() }
        .keyboardShortcut(",", modifiers: .command)
      MenuLine("Share Image…") {
        shareController?.close(); shareController = ShareController(snapshot: store.snapshot); shareController?.show()
      }
      if let link {
        MenuLine(discovery["id"].string == nil || discovery["id"].string == "intro" ? "More from the maker of Peras…" : link.title + "…") { store.openLink(link) }
          .disabled(store.fixtureMode || store.blockedProviders.contains("global"))
          .help(link.title + ". " + link.detail)
          .contextMenu {
            if discovery["dismiss"] != .null {
              let offer = BridgeOffer(raw: discovery["dismiss"])
              Button("Hide Suggestion") { store.send(offer) }.disabled(store.fixtureMode || !offer.eligible || store.blockedProviders.contains(offer.key))
            }
          }
      }
      MenuHairline().padding(.vertical, 5)
      MenuLine("Quit Peras", shortcut: "⌘Q") { NSApp.terminate(nil) }.keyboardShortcut("q", modifiers: .command)
    }.padding(.top, 12).padding(.horizontal, 16).padding(.bottom, 8).frame(width: 320)
      .contextMenu {
        Button("Set Up Peras…") { store.onOpenSetup?() }
        #if !PERAS_PRODUCTION
        Button("Preview & Diagnostics…") { store.onOpenDiagnostics?() }
        #endif
      }
  }
}
private struct MenuContrastOverrideKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues { var menuHighContrastOverride: Bool { get { self[MenuContrastOverrideKey.self] } set { self[MenuContrastOverrideKey.self] = newValue } } }
struct MenuHairline: View {
  @Environment(\.menuHighContrastOverride) var simulatedContrast
  @Environment(\.colorSchemeContrast) var contrast
  var body: some View { Rectangle().fill(Color.primary.opacity(contrast == .increased || simulatedContrast ? 0.3 : 0.14)).frame(height: 0.5).accessibilityHidden(true) }
}
struct MenuLine: View {
  let title: String
  var shortcut: String? = nil
  let action: () -> Void
  @State private var hovering = false
  @Environment(\.isEnabled) var enabled
  @Environment(\.colorScheme) var colorScheme
  var highlightText: Color { colorScheme == .dark ? .black : .white }
  init(_ title: String, shortcut: String? = nil, action: @escaping () -> Void) { self.title = title; self.shortcut = shortcut; self.action = action }
  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Text(title).lineLimit(1)
        Spacer(minLength: 3)
        if let shortcut { Text(shortcut).font(.system(size: 12)).foregroundStyle(hovering && enabled ? highlightText.opacity(0.8) : Color.secondary) }
      }.font(.system(size: 13)).foregroundStyle(hovering && enabled ? highlightText : Color.primary)
        .padding(.horizontal, 8).frame(height: 24).contentShape(Rectangle())
        .background(hovering && enabled ? PearPalette.color : Color.clear, in: RoundedRectangle(cornerRadius: 6))
    }.buttonStyle(.plain).padding(.horizontal, -8).onHover { hovering = $0 }.perasKeyboardButton()
      .accessibilityLabel(title)
  }
}
private struct PerasKeyboardButton: ViewModifier {
  @FocusState private var focused: Bool
  func body(content: Content) -> some View {
    content.focused($focused).keyboardShortcut(focused ? KeyboardShortcut(.return, modifiers: []) : nil)
  }
}
extension View { func perasKeyboardButton() -> some View { modifier(PerasKeyboardButton()) } }
