import SwiftUI

struct DebugDisclosure: View {
  @ObservedObject var store: FixtureStore
  var body: some View {
    DisclosureGroup("Preview & diagnostics", isExpanded: $store.debugExpanded) {
      if store.debugExpanded {
      VStack(alignment: .leading, spacing: 8) {
        Text(store.fixtureMode ? "Offline fixture. Main controls are read-only." : store.connection)
          .font(.caption).foregroundStyle(.secondary)
        if store.fixtureMode {
          Picker(
            "Fixture",
            selection: Binding(
              get: { store.fixtureName },
              set: { name in
                if let url = store.fixtures.first(where: {
                  $0.deletingPathExtension().lastPathComponent == name
                }) {
                  store.load(url)
                }
              })
          ) {
            ForEach(store.fixtures, id: \.path) { url in
              Text(url.deletingPathExtension().lastPathComponent).tag(
                url.deletingPathExtension().lastPathComponent)
            }
          }
          Text("Visual simulations only").font(.caption.weight(.semibold))
          ForEach(["claude", "codex"], id: \.self) { provider in
            HStack {
              Text(PresentationText.provider(provider)).font(.caption).frame(
                width: 78, alignment: .leading)
              Button("Pause") { store.simulate("pause", provider: provider) }
              Button("Resume") { store.simulate("resume", provider: provider) }
              Button("Greet") { store.simulate("greet", provider: provider) }
            }.controlSize(.mini)
          }
        }
        Toggle("Reduce Motion preview", isOn: $store.reducedOverride)
          .onChange(of: store.reducedOverride) { _ in store.accessibilityChanged() }
          .font(.caption)
      }.padding(.top, 6)
      }
    }.font(.caption).foregroundStyle(.secondary)
  }
}
