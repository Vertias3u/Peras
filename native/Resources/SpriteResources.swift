import AppKit
import ImageIO

final class SpriteResources {
  let atlas: Atlas
  let images: [String: CGImage]
  init(directory: URL) throws {
    atlas = try JSONDecoder().decode(
      Atlas.self, from: Data(contentsOf: directory.appendingPathComponent("atlas.json")))
    guard atlas.width == 40, atlas.height == 28 else {
      throw SnapshotError.invalid("Original atlas must be 40 × 28 pixels")
    }
    var decoded = [String: CGImage]()
    for pet in atlas.providers.values {
      for name in (pet.right + (pet.left ?? []) + [pet.idle]).map(\.file) + [pet.cup] {
        guard
          let source = CGImageSourceCreateWithURL(
            directory.appendingPathComponent(name) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(
            source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        else { throw SnapshotError.invalid("Missing sprite resource: \(name)") }
        decoded[name] = image
      }
    }
    images = decoded
  }
}
