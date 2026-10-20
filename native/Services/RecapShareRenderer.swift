import AppKit
import ImageIO
import SwiftUI

@MainActor enum RecapShareRenderer {
  private static let art: [ShareModel.Provider: CGImage] = {
    guard let directory = Bundle.main.resourceURL, let resources = try? SpriteResources(directory: directory) else { return [:] }
    var result = [ShareModel.Provider: CGImage]()
    for provider in [ShareModel.Provider.claude, .codex] {
      if let file = resources.atlas.providers[provider.rawValue]?.idle.file { result[provider] = resources.images[file] }
    }
    return result
  }()
  static func png(_ model: RecapShareModel) throws -> Data {
    guard art.count == 2 else { throw SnapshotError.invalid("Recap art unavailable") }
    let renderer = ImageRenderer(content: RecapShareCard(model: model, art: art).environment(\.displayScale, 2))
    renderer.scale = 2; renderer.isOpaque = true
    guard let image = renderer.cgImage else { throw SnapshotError.invalid("Recap rendering unavailable") }
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, "public.png" as CFString, 1, nil) else { throw SnapshotError.invalid("PNG creation unavailable") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw SnapshotError.invalid("PNG creation failed") }
    return output as Data
  }
}
