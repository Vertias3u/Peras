import SwiftUI

struct SettingsDisclosure: View {
  @ObservedObject var store: FixtureStore
  var settings: SettingsPresentation {
    SettingsPresentation(raw: store.snapshot?.raw["settings"] ?? .null)
  }
  var body: some View {
    Group {
      DisclosureGroup("Settings", isExpanded: $store.settingsExpanded) {
        if store.settingsExpanded {
        VStack(alignment: .leading, spacing: 8) {
          Toggle("Open/focus shortcut", isOn: $store.shortcutEnabled)
            .onChange(of: store.shortcutEnabled) { _ in store.onShortcutChange?() }
          Picker("Shortcut", selection: $store.shortcutChoice) {
            Text("Control–Option–P").tag(0)
            Text("Control–Option–Shift–P").tag(1)
          }.onChange(of: store.shortcutChoice) { _ in store.onShortcutChange?() }
          Text(store.shortcutMessage).font(.caption2).foregroundStyle(.secondary)
          ForEach(settings.offers) { offer in
            OfferedActionView(offer: offer, impact: [], title: settings.label(offer), store: store)
          }
        }.padding(.top, 6)
      }
      }.font(.caption)
    }
  }
}
