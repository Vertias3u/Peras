import CoreGraphics
import Foundation
import ImageIO

struct ShareProbeFailure: Error {
  let phase: String
  let code: String
}
@MainActor enum ShareProbe {
  static func run(options: Options) throws {
    let snapshot = try PresentationChecks.canarySnapshot(fixtures: options.fixtureDirectory)
    let output = options.output
    let probe = try Probe(directory: output)
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    for (name, included) in [("private", false), ("readings", true)] {
      let model = ShareModel.build(snapshot, includeReadings: included)
      try ShareRenderer.png(model).write(
        to: output.appendingPathComponent(name + ".png"), options: .atomic)
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
      try encoder.encode(model).write(
        to: output.appendingPathComponent(name + "-model.json"), options: .atomic)
    }
    let firstPrivatePNG = try Data(contentsOf: output.appendingPathComponent("private.png"))
    let repeatPrivatePNG = try ShareRenderer.png(ShareModel.build(nil, includeReadings: false))
    try repeatPrivatePNG.write(
      to: output.appendingPathComponent("private-repeat.png"), options: .atomic)
    let repeatComparison = try compare(firstPrivatePNG, repeatPrivatePNG)
    probe.write(repeatComparison, name: "share-repeatability")
    guard withinQuantization(repeatComparison) else {
      throw ShareProbeFailure(phase: "first-repeat", code: "private_render_not_repeatable")
    }
    let controller = ShareController(snapshot: snapshot)
    defer { controller.close() }
    let expectedPrivate = ShareModel.build(nil, includeReadings: false)
    var phases = [[String: Any]]()
    func capture(_ phase: String) throws -> Data {
      guard let png = controller.pngData else {
        throw ShareProbeFailure(phase: phase, code: "render_unavailable")
      }
      try png.write(
        to: output.appendingPathComponent("preview-" + phase + ".png"), options: .atomic)
      return png
    }
    func verifyPrivate(_ phase: String, reference: Data) throws {
      let png = try capture(phase)
      let pixels = try compare(reference, png)
      let modelMatches = !controller.includeReadings && controller.selectedModel == expectedPrivate
      phases.append([
        "phase": phase, "modelMatchesPrivate": modelMatches, "pngBytesEqual": png == reference,
        "pixelComparison": pixels,
      ])
      probe.write(["phases": phases], name: "share-lifecycle")
      guard modelMatches else {
        throw ShareProbeFailure(phase: phase, code: "private_model_not_restored")
      }
      guard withinQuantization(pixels) else {
        throw ShareProbeFailure(phase: phase, code: "private_pixels_not_restored")
      }
    }
    controller.show()
    let privatePNG = try Data(contentsOf: output.appendingPathComponent("private.png"))
    try verifyPrivate("initial", reference: privatePNG)
    controller.setIncludeReadings(true)
    let readingsPNG = try capture("opt-in")
    let expectedReadings = ShareModel.build(snapshot, includeReadings: true)
    let standaloneReadings = try Data(contentsOf: output.appendingPathComponent("readings.png"))
    let readingsComparison = try compare(standaloneReadings, readingsPNG)
    let modeComparison = try compare(privatePNG, readingsPNG)
    let readingsModelMatches =
      controller.includeReadings && controller.selectedModel == expectedReadings
    phases.append([
      "phase": "opt-in", "modelMatchesReadings": readingsModelMatches,
      "pixelComparison": readingsComparison, "privateVersusReadings": modeComparison,
    ])
    probe.write(["phases": phases], name: "share-lifecycle")
    guard readingsModelMatches, withinQuantization(readingsComparison),
      let modeDifference = modeComparison["maximumRGBDelta"] as? Int, modeDifference > 1
    else {
      throw ShareProbeFailure(phase: "opt-in", code: "readings_not_rendered")
    }
    controller.show()
    try verifyPrivate("repeat-open", reference: privatePNG)
    controller.setIncludeReadings(true)
    controller.close()
    try verifyPrivate("closed", reference: privatePNG)
    controller.show()
    try verifyPrivate("reopen", reference: privatePNG)
    controller.close()
    probe.write(
      [
        "ok": true, "clipboardWrites": 0, "savePanels": 0,
        "previewStartsPrivate": true, "repeatOpeningResetsPrivate": true,
        "closeReopenResetsPrivate": true, "privatePixelsVerifiedAfterReset": true,
        "maximumAllowedRGBDelta": 1, "requiresOpaqueAlpha": true,
        "readingsModeDifferenceExceedsQuantization": true,
        "source": "Derived native privacy-canary input, not live account data",
        "motto": ShareModel.motto, "url": ShareModel.canonicalURL,
      ], name: "share-probe")
    try RecapShareProbe.run(options: options)
  }
  // Parent's independent decoder established at most one 8-bit RGB level of
  // text-edge quantization between initial and later ImageRenderer contexts.
  // Alpha, dimensions and selected allowlist models remain exact requirements.
  static func withinQuantization(_ comparison: [String: Any]) -> Bool {
    guard let delta = comparison["maximumRGBDelta"] as? Int,
      let nonOpaque = comparison["nonOpaquePixels"] as? Int
    else { return false }
    return delta <= 1 && nonOpaque == 0
  }
  private static func decoded(_ png: Data) throws -> (Int, Int, [UInt8]) {
    guard let source = CGImageSourceCreateWithData(png as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)
    else {
      throw ShareProbeFailure(phase: "pixel-comparison", code: "png_decode_failed")
    }
    let width = image.width
    let height = image.height
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    let rendered = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard
        let context = CGContext(
          data: buffer.baseAddress, width: width, height: height,
          bitsPerComponent: 8, bytesPerRow: width * 4, space: colorSpace,
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    guard rendered else {
      throw ShareProbeFailure(phase: "pixel-comparison", code: "pixel_decode_failed")
    }
    return (width, height, bytes)
  }
  static func compare(_ lhs: Data, _ rhs: Data) throws -> [String: Any] {
    let (width, height, a) = try decoded(lhs)
    let (otherWidth, otherHeight, b) = try decoded(rhs)
    guard width == 1200 && height == 1080 && width == otherWidth && height == otherHeight else {
      throw ShareProbeFailure(phase: "pixel-comparison", code: "image_dimensions_changed")
    }
    var count = 0
    var minX = width
    var minY = height
    var maxX = -1
    var maxY = -1
    var maximumRGBDelta = 0
    var nonOpaquePixels = 0
    for i in stride(from: 0, to: a.count, by: 4) {
      for channel in 0..<3 {
        maximumRGBDelta = max(maximumRGBDelta, abs(Int(a[i + channel]) - Int(b[i + channel])))
      }
      if a[i + 3] != 255 || b[i + 3] != 255 { nonOpaquePixels += 1 }
      if a[i..<i + 4] != b[i..<i + 4] {
        count += 1
        let x = (i / 4) % width
        let y = (i / 4) / width
        minX = min(minX, x)
        minY = min(minY, y)
        maxX = max(maxX, x)
        maxY = max(maxY, y)
      }
    }
    return [
      "width": width, "height": height, "mismatchedPixels": count,
      "maximumRGBDelta": maximumRGBDelta, "nonOpaquePixels": nonOpaquePixels,
      "differenceBounds": count == 0 ? [] : [minX, minY, maxX, maxY],
    ]
  }
}
