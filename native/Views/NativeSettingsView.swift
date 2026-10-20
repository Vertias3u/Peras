import SwiftUI

struct NativeSettingsView: View {
  @ObservedObject var store: FixtureStore
  var settings: SettingsPresentation { SettingsPresentation(raw: store.snapshot?.raw["settings"] ?? .null) }
  var menuSettings: MenuSettings { MenuSettings(raw: store.snapshot?.raw["settings"] ?? .null) }
  // One page when Peras's own Settings window hosts each tab (AuxiliaryWindows); all three in a TabView otherwise.
  var tab: String? = nil
  static let size = CGSize(width: 520, height: 460)
  var body: some View {
    Group {
      if let tab { page(tab) } else {
        TabView(selection: $store.settingsSelectedTab) {
          general.tabItem { Label("General", systemImage: "gearshape") }.tag("general")
          notifications.tabItem { Label("Notifications", systemImage: "bell") }.tag("notifications")
          more.tabItem { Label("More", systemImage: "sparkles") }.tag("more")
        }
      }
    }.frame(width: Self.size.width, height: Self.size.height)
      .font(.system(size: 13))
      .accessibilityIdentifier("peras-settings").tint(PearPalette.color)
      .onAppear { SettingsSceneEvidence.store = store }
  }
  @ViewBuilder func page(_ tab: String) -> some View {
    switch tab {
    case "notifications": notifications
    case "more": more
    default: general
    }
  }
  private var general: some View {
Form {
      Section("Menu bar") {
        HStack {
          Text("Show in the menu bar")
          Spacer()
          Picker("Show in the menu bar", selection: Binding(get: { DisplayPresentation(raw: store.snapshot?.raw["settings"] ?? .null).style.rawValue }, set: { value in
            let model = DisplayPresentation(raw: store.snapshot?.raw["settings"] ?? .null)
            if let style = DisplayStyle(rawValue: value), let offer = model.offer(style), offer.eligible { store.send(offer) }
          })) {
            ForEach(DisplayStyle.allCases, id: \.self) { style in
              Text(style == .pear ? "Pear" : style == .usage ? "Pear + usage" : "Filling pear").tag(style.rawValue)
                .disabled(style != DisplayPresentation(raw: store.snapshot?.raw["settings"] ?? .null).style && DisplayPresentation(raw: store.snapshot?.raw["settings"] ?? .null).offer(style)?.eligible != true)
            }
          }
            .labelsHidden().pickerStyle(.segmented).tint(PearPalette.segmentedColor).fixedSize()
            .disabled(store.fixtureMode || DisplayPresentation(raw: store.snapshot?.raw["settings"] ?? .null).unknown || store.blockedProviders.contains("global"))
            .help("Choose a pear, usage text, or a pear that fills with the busiest agent’s five-hour usage. Unavailable styles require a Peras update.")
        }
        HStack {
          VStack(alignment: .leading, spacing: 2) { Text("Weekly usage"); Text("Under each agent’s five-hour track").font(.caption).foregroundStyle(.secondary) }
          Spacer()
          Picker("Weekly usage", selection: Binding(get: { menuSettings.weeklyStyle.rawValue }, set: { value in
            if let style = WeeklyStyle(rawValue: value), let offer = menuSettings.offer(style: style), offer.eligible { store.send(offer) }
          })) {
            ForEach(WeeklyStyle.allCases, id: \.self) { style in
              Text(style.rawValue.capitalized).tag(style.rawValue)
                .disabled(style != menuSettings.weeklyStyle && menuSettings.offer(style: style)?.eligible != true)
            }
          }.labelsHidden().pickerStyle(.segmented).tint(PearPalette.segmentedColor).frame(width: 180)
            .disabled(store.fixtureMode || menuSettings.unknownStyle || store.blockedProviders.contains("global"))
            .help(menuSettings.unknownStyle ? "Weekly display is unavailable with this version. Your existing display is kept." : "Choose a weekly bar, text only, or hide weekly usage. Unavailable styles require a Peras update.")
        }
        BackendPreferenceRow(store: store, name: "mascots", title: "Show mascots", detail: "Claude and Codex patrol freely; the bar shows their usage")
        Toggle(isOn: Binding(get: { store.openAtLogin }, set: { store.onOpenAtLoginChange?($0) })) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Open at login")
            Text(store.loginItemNote ?? "Peras starts when you log in, so the menu and reminders are back after a restart.").font(.caption).foregroundStyle(.secondary)
          }
        }.toggleStyle(.switch).disabled(store.fixtureMode || store.loginItemNote == "Development builds never change your login items.")
          .accessibilityLabel("Open at login").accessibilityHint(store.loginItemNote ?? "Peras starts when you log in.")
          .onAppear { store.onRefreshLoginItem?() }
      }
      Section("Agents") { BackendPreferenceRow(store: store, name: "agents", title: "Show usage to agents", detail: "Claude Code and Codex see one line with their own and each other's usage when it changes. Peras still does the pausing.") }
      Section("Keyboard") {
        Picker("Open Peras", selection: Binding(get: { store.shortcutEnabled ? store.shortcutChoice : 2 }, set: { value in
          store.shortcutEnabled = value != 2
          if value != 2 { store.shortcutChoice = value }
          store.onShortcutChange?()
        })) {
          Text("⌃⌥P").accessibilityLabel("Control-Option-P").tag(0)
          Text("⌃⌥⇧P").accessibilityLabel("Control-Option-Shift-P").tag(1)
          Text("Off").tag(2)
        }.accessibilityLabel("Open Peras shortcut")
        Text(store.shortcutMessage).font(.caption).foregroundStyle(.secondary)
      }
      Section {
        Button("Set Up Peras…") { store.onOpenSetup?() }
        #if !PERAS_PRODUCTION
        Button("Preview & Diagnostics…") { store.onOpenDiagnostics?() }
        #endif
      }
    }.formStyle(.grouped)
  }
  private var notifications: some View {
Form {
      Section("Notify me when") {
        BackendPreferenceRow(store: store, name: "warnings", title: "Usage crosses a warning line", detail: "At the warning lines you configured")
        BackendPreferenceRow(store: store, name: "pauses", title: "Peras pauses an agent", detail: "Or asks for your OK before it continues")
        BackendPreferenceRow(store: store, name: "resets", title: "A usage window resets", detail: "Five-hour and weekly")
        BackendPreferenceRow(store: store, name: "unused", title: "Allowance is going unused", detail: "Near the weekly reset")
      }
      Text("Peras uses macOS notifications; Focus modes apply.").font(.caption).foregroundStyle(.secondary)
    }.formStyle(.grouped)
  }
  private var more: some View {
Form {
      Section("PassControl, by the maker of Peras") {
        ForEach(DiscoveryLink.rows(store.snapshot)) { link in
          Button { store.openLink(link) } label: {
            HStack {
              VStack(alignment: .leading, spacing: 2) { Text(link.title).foregroundStyle(.primary); Text(link.detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
              Spacer(); Image(systemName: "arrow.up.right").foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
          }.buttonStyle(.plain).disabled(store.fixtureMode || store.blockedProviders.contains("global"))
            .accessibilityLabel(link.title + ". " + link.detail).help("Open in browser. " + link.detail)
        }
      }
    }.formStyle(.grouped)
  }
}
struct BackendPreferenceRow: View {
  @ObservedObject var store: FixtureStore
  let name: String
  let title: String
  let detail: String
  var offer: BridgeOffer? { store.snapshot?.raw["settings"]["actions"].array.map { BridgeOffer(raw: $0) }.first { $0.raw["op"].string == "preference.set" && $0.raw["params"]["name"].string == name } }
  var body: some View {
    Toggle(isOn: Binding(get: { store.snapshot?.raw["settings"]["preferences"][name].bool ?? false }, set: { _ in if let offer { store.send(offer) } })) {
      VStack(alignment: .leading, spacing: 2) { Text(title); Text(detail).font(.caption).foregroundStyle(.secondary) }
    }.toggleStyle(.switch).disabled(store.fixtureMode || offer?.eligible != true || store.blockedProviders.contains("global"))
      .accessibilityLabel(title).accessibilityHint(PresentationText.disabled(offer?.disabledReason) ?? detail)
      .help(PresentationText.disabled(offer?.disabledReason) ?? detail)
  }
}
