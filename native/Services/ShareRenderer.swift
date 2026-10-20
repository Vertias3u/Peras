import AppKit
import ImageIO
import SwiftUI

@MainActor enum ShareRenderer {
  static func png(_ model: ShareModel) throws -> Data {
    // Only our own allowlisted card is rendered. Never a screen, window or app view.
    // Output bitmap scale alone does not pin SwiftUI's text/layout environment.
    // Keep that environment identical before and after an AppKit preview exists.
    let renderer = ImageRenderer(content: ShareCard(model: model).environment(\.displayScale, 2))
    renderer.scale = 2
    renderer.isOpaque = true
    guard let image = renderer.cgImage else {
      throw SnapshotError.invalid("Share rendering unavailable")
    }
    let output = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(output, "public.png" as CFString, 1, nil)
    else { throw SnapshotError.invalid("PNG creation unavailable") }
    // Fresh pixels, nil source metadata: no labels, timestamps, paths or tokens can hitchhike.
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
      throw SnapshotError.invalid("PNG creation failed")
    }
    return output as Data
  }
}
