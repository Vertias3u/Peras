import Foundation

struct LineFramer {
  static let maximumBytes = 1_048_576
  private(set) var buffer = Data()
  mutating func append(_ bytes: Data) throws -> [Data] {
    var lines = [Data]()
    for byte in bytes {
      if byte == 10 {
        var line = buffer
        buffer.removeAll(keepingCapacity: true)
        if line.last == 13 { line.removeLast() }
        guard String(data: line, encoding: .utf8) != nil else { throw BridgeError.invalidFrame }
        if !line.isEmpty { lines.append(line) }
      } else {
        guard buffer.count < Self.maximumBytes else { throw BridgeError.oversize }
        buffer.append(byte)
      }
    }
    return lines
  }
}
enum BridgeError: Error {
  case invalidFrame, oversize, protocolViolation, unavailable, ineligible, busy
}
struct RetrySchedule {
  private(set) var failures = 0
  mutating func next() -> Double {
    let seconds = min(30, pow(2, Double(min(failures, 5))))
    failures = min(6, failures + 1)
    return seconds
  }
  mutating func reset() { failures = 0 }
}
