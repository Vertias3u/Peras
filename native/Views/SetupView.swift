import SwiftUI

struct SetupView: View {
  @ObservedObject var store: FixtureStore
  @State private var ownWindowVisible = false
  var setup: SetupPresentation { SetupPresentation(providers: store.snapshot?.providers ?? []) }
  var testOffer: BridgeOffer? {
    let offers = store.currentOffers.filter { $0.raw["op"].string == "protection.test" }
    return offers.first(where: \.eligible) ?? offers.first
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Set up Peras").font(.system(size: 19, weight: .bold))
      Text("A few steps, then Peras can help protect your usage. Completed steps update as the agents pick up their hooks.").font(.system(size: 12)).foregroundStyle(.secondary)
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(setup.steps) { step in
            HStack(alignment: .top, spacing: 10) {
              FiniteSymbol(name: step.complete ? "checkmark.circle.fill" : "circle", value: step.complete, animate: ownWindowVisible && !store.reduced, bounces: false).foregroundStyle(step.complete ? PearPalette.color : Color.secondary).font(.system(size: 19))
              VStack(alignment: .leading, spacing: 3) { Text(step.title).font(.system(size: 13, weight: .semibold)); Text(step.detail).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
              Spacer(minLength: 0)
            }.padding(10).accessibilityElement(children: .combine).accessibilityLabel(step.title + (step.complete ? ", complete. " : ", needs attention. ") + step.detail)
            MenuHairline()
          }
        }.background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 9))
      }
      HStack(spacing: 10) {
        Button("Test Protection") { if let testOffer { store.send(testOffer) } }
          .disabled(store.fixtureMode || testOffer?.eligible != true || store.blockedProviders.contains(testOffer?.key ?? "global"))
          .help(testOffer.map { PresentationText.disabled($0.disabledReason) ?? "Checks both configured agents in an isolated folder" } ?? "Set up the hooks first. You can also run peras menubar test in your terminal.")
          .accessibilityHint(testOffer.map { PresentationText.disabled($0.disabledReason) ?? "Checks both configured agents in an isolated folder" } ?? "Set up the hooks first. You can also run peras menubar test in your terminal.")
        Text("Checks both configured agents; your agents keep running.").font(.system(size: 11)).foregroundStyle(.secondary)
      }.controlSize(.small)
      if let message = store.actionMessage { Text(message).font(.caption).foregroundStyle(.secondary) }
      Text("To return to SwiftBar, quit the native app before switching back to 0.3, then run peras menubar install. ")
        .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }.padding(20).frame(width: 500, height: 500).accessibilityIdentifier("peras-setup").tint(PearPalette.color)
      .background(OwnedWindowVisibility { ownWindowVisible = $0 })
  }
}
