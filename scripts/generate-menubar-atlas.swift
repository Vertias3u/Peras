// Development-only atlas generator; the shipped CLI needs only Node.
// swift scripts/generate-menubar-atlas.swift <claude-tray.png> <codex-tray.png> src/menubar-atlas.json
// The pear is not in the atlas: src/menubar-image.mjs draws the pixel pear itself.
import CoreGraphics
import CoreText
import ImageIO
import Foundation

let width = 48, height = 40
var sprites: [String: Any] = [:]
func sprite(_ name: String, advance: Int, draw: (CGContext) -> Void) {
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    draw(ctx)
    var pixels = Array(UnsafeBufferPointer(start: ctx.data!.assumingMemoryBound(to: UInt8.self), count: width * height * 4))
    for i in stride(from: 0, to: pixels.count, by: 4) {
        let a = Int(pixels[i + 3])
        if a > 0 { for c in 0..<3 { pixels[i+c] = UInt8(min(255, Int(pixels[i+c]) * 255 / a)) } }
    }
    sprites[name] = ["advance": advance, "data": zlib(pixels).base64EncodedString()]
}
// Node's inflateSync wants a zlib stream; Apple's .zlib is raw deflate, so wrap it.
func zlib(_ raw: [UInt8]) -> Data {
    var a: UInt32 = 1, b: UInt32 = 0
    for byte in raw { a = (a + UInt32(byte)) % 65521; b = (b + a) % 65521 }
    var out = Data([0x78, 0x9c])
    out.append(try! (Data(raw) as NSData).compressed(using: .zlib) as Data)
    withUnsafeBytes(of: ((b << 16) | a).bigEndian) { out.append(contentsOf: $0) }
    return out
}
func line(_ text: String, font: CTFont) -> CTLine {
    CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 1, green: 1, blue: 1, alpha: 1)
    ]))
}
let font = CTFontCreateWithName(".AppleSystemUIFont" as CFString, 26, nil)
for char in "0123456789%–Claudeox" {
    let text = line(String(char), font: font)
    sprite(String(char), advance: Int(ceil(CTLineGetTypographicBounds(text, nil, nil, nil)))) {
        $0.textPosition = CGPoint(x: 0, y: 10)
        CTLineDraw(text, $0)
    }
}
for (name, file) in [("claude", CommandLine.arguments[1]), ("codex", CommandLine.arguments[2])] {
    let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: file) as CFURL, nil)!
    let icon = CGImageSourceCreateImageAtIndex(source, 0, nil)!
    // Claude's tray asset has more transparent padding; match the visible marks.
    let size: CGFloat = name == "claude" ? 43 : 32
    sprite(name, advance: 32) { ctx in
        ctx.draw(icon, in: CGRect(x: (32 - size) / 2, y: (CGFloat(height) - size) / 2, width: size, height: size))
        ctx.setBlendMode(.sourceIn)
        ctx.setFillColor(name == "claude" ? CGColor(red: 0.85, green: 0.48, blue: 0.34, alpha: 1) : CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    }
}
try JSONSerialization.data(withJSONObject: ["width": width, "height": height, "sprites": sprites]).write(to: URL(fileURLWithPath: CommandLine.arguments[3]))
