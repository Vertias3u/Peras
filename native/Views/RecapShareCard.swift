import SwiftUI

// Only the canonical export model and original bundled art enter this view.
struct RecapShareCard: View {
  let model: RecapShareModel
  let art: [ShareModel.Provider: CGImage]
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack { PerasPearMark().frame(width: 30, height: 30); Text("PERAS").font(.system(size: 17, weight: .bold, design: .rounded)).tracking(3); Spacer(); Text(model.mode == .privateCard ? "PRIVATE CARD" : "READINGS INCLUDED").font(.system(size: 10, weight: .semibold)) }
      Text("A week spent on purpose.").font(.system(size: 34, weight: .bold, design: .rounded)).fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 22) {
        ForEach([ShareModel.Provider.claude, .codex], id: \.self) { provider in
          if let image = art[provider] { Image(decorative: image, scale: 1).resizable().interpolation(.none).frame(width: 80, height: 56) }
        }
      }.accessibilityHidden(true)
      if model.mode == .privateCard {
        Text("A little room for the rest of your week.").font(.system(size: 17))
        Text("Private by default · readings hidden").font(.system(size: 12))
      } else {
        ForEach(model.readings, id: \.provider) { reading in
          VStack(alignment: .leading, spacing: 5) {
            Text(reading.provider.title).font(.system(size: 16, weight: .semibold))
            Text(reading.caption).font(.system(size: 14)).fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      Spacer(minLength: 4)
      Text(ShareModel.motto).font(.system(size: 14))
      Text(ShareModel.canonicalURL).font(.system(size: 14, weight: .semibold))
    }.padding(36).frame(width: 600, height: 540, alignment: .topLeading)
      .foregroundStyle(Color(red: 0.13, green: 0.16, blue: 0.11)).background(Color(red: 0.96, green: 0.96, blue: 0.92))
      .environment(\.colorScheme, .light)
  }
}
