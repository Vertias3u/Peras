import CryptoKit
import Darwin
import Foundation

// A process-owned advisory lock, never a stale PID sentinel. realpath also resolves aliases
// when the last component does not exist yet (walk to the nearest existing ancestor).
final class InstanceLock {
  let root: URL
  let key: String
  private var fd: Int32 = -1
  init(path: String) throws {
    let expanded = (path as NSString).expandingTildeInPath
    var candidate = URL(fileURLWithPath: expanded, isDirectory: true).standardizedFileURL
    var missing = [String]()
    while !FileManager.default.fileExists(atPath: candidate.path), candidate.path != "/" {
      missing.append(candidate.lastPathComponent)
      candidate.deleteLastPathComponent()
    }
    var resolved = candidate.resolvingSymlinksInPath()
    for component in missing.reversed() {
      resolved.appendPathComponent(component, isDirectory: true)
    }
    root = resolved
    key = SHA256.hash(data: Data(root.path.utf8)).map { String(format: "%02x", $0) }.joined()
  }
  func acquire() throws -> Bool {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    fd = Darwin.open(
      root.appendingPathComponent("native-fixture.lock").path,
      O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    if flock(fd, LOCK_EX | LOCK_NB) != 0 {
      let failure = errno
      Darwin.close(fd)
      fd = -1
      if failure == EWOULDBLOCK || failure == EAGAIN { return false }
      throw POSIXError(POSIXErrorCode(rawValue: failure) ?? .EIO)
    }
    return true
  }
  deinit { if fd >= 0 { Darwin.close(fd) } }
}
