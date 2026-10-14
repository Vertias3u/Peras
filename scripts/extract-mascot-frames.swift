// Development-only: extracts the downloaded official animations into tiny RGBA frames.
// swift scripts/extract-mascot-frames.swift research/mascots src/mascot-atlas.json
import Foundation
import CoreGraphics
import ImageIO

let folder = CommandLine.arguments[1]
let width = 40, height = 28
func source(_ name: String) -> CGImageSource {
    CGImageSourceCreateWithURL(URL(fileURLWithPath: folder).appendingPathComponent(name) as CFURL, nil)!
}
func bounds(_ image: CGImage) -> CGRect {
    let ctx = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
        bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    let data = ctx.data!.assumingMemoryBound(to: UInt8.self)
    var x0 = image.width, y0 = image.height, x1 = 0, y1 = 0
    for y in 0..<image.height { for x in 0..<image.width {
        if data[(y * image.width + x) * 4 + 3] > 16 {
            x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
        }
    } }
    return CGRect(x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1)
}
func frame(_ image: CGImage, crop: CGRect, ms: Int) -> [String: Any] {
    let cropped = image.cropping(to: crop)!
    let scale = min(38.0 / crop.width, 26.0 / crop.height)
    let w = Int((crop.width * scale).rounded()), h = Int((crop.height * scale).rounded())
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .none
    ctx.draw(cropped, in: CGRect(x: (width - w) / 2, y: 0, width: w, height: h))
    var rgba = Array(UnsafeBufferPointer(start: ctx.data!.assumingMemoryBound(to: UInt8.self), count: width * height * 4))
    for i in stride(from: 0, to: rgba.count, by: 4) {
        let a = Int(rgba[i + 3])
        if a > 0 { for c in 0..<3 { rgba[i+c] = UInt8(min(255, Int(rgba[i+c]) * 255 / a)) } }
    }
    var a: UInt32 = 1, b: UInt32 = 0
    for byte in rgba { a = (a + UInt32(byte)) % 65521; b = (b + a) % 65521 }
    var compressed = Data([0x78, 0x9c])
    compressed.append(try! (Data(rgba) as NSData).compressed(using: .zlib) as Data)
    withUnsafeBytes(of: ((b << 16) | a).bigEndian) { compressed.append(contentsOf: $0) }
    return ["ms": ms, "data": compressed.base64EncodedString()]
}
let clawd = source("claude-crab-walking.gif")
var images: [CGImage] = [], timings: [Int] = [], crop = CGRect.null
for i in 0..<CGImageSourceGetCount(clawd) {
    let image = CGImageSourceCreateImageAtIndex(clawd, i, nil)!
    images.append(image); crop = crop.union(bounds(image))
    let props = CGImageSourceCopyPropertiesAtIndex(clawd, i, nil) as! [String: Any]
    let gif = props[kCGImagePropertyGIFDictionary as String] as? [String: Any] ?? [:]
    let delay = gif[kCGImagePropertyGIFUnclampedDelayTime as String] as? Double ?? gif[kCGImagePropertyGIFDelayTime as String] as? Double ?? 0.083
    timings.append(max(20, Int((delay * 1000).rounded())))
}
let claudeFrames = images.enumerated().map { frame($0.element, crop: crop, ms: timings[$0.offset]) }
let still = CGImageSourceCreateImageAtIndex(source("claude-still.png"), 0, nil)!
let sheet = CGImageSourceCreateImageAtIndex(source("codex-spritesheet.webp"), 0, nil)!
func codexFrames(row: Int, count: Int) -> [[String: Any]] {
    let cells = (0..<count).map { sheet.cropping(to: CGRect(x: $0 * 192, y: row * 208, width: 192, height: 208))! }
    let crop = cells.reduce(CGRect.null) { $0.union(bounds($1)) }
    return cells.enumerated().map { frame($0.element, crop: crop, ms: $0.offset == count - 1 ? 220 : 120) }
}
let output: [String: Any] = ["width": width, "height": height, "claude": ["right": claudeFrames, "mirrorLeft": true, "idle": frame(still, crop: bounds(still), ms: 1000)],
    "codex": ["right": codexFrames(row: 1, count: 8), "left": codexFrames(row: 2, count: 8), "idle": codexFrames(row: 0, count: 6)[0]]]
try JSONSerialization.data(withJSONObject: output).write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
print("Extracted \(images.count) Claude frames and 8 frames per Codex direction")
