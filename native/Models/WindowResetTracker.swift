import Foundation

// A new reported current window plus a post-old-end reading confirms a reset.
// No predicted countdown, initial attach, reconnect or hidden/wake backlog can greet.
struct WindowResetTracker {
  private struct Reading {
    let reset: Double
    let seen: Double
  }
  private var bridge: String?
  private var contexts = [String: String]()
  private var previous = [String: Reading]()
  private var skipNextVisible = true
  mutating func hidden() { skipNextVisible = true }
  mutating func consume(_ snapshot: Snapshot, visible: Bool) -> [String: String] {
    let newBridge = bridge != snapshot.bridgeInstance
    if newBridge {
      previous.removeAll()
      contexts.removeAll()
      bridge = snapshot.bridgeInstance
      skipNextVisible = true
    }
    let mayGreet = visible && !skipNextVisible && !newBridge
    var greetings = [String: String]()
    for provider in snapshot.providers {
      let context = provider.payload["accountContextId"].string ?? ""
      let newContext = contexts[provider.id] != context
      if newContext {
        previous = previous.filter { !$0.key.hasPrefix(provider.id + ":") }
        contexts[provider.id] = context
      }
      for row in provider.windows {
        guard row["freshness"].string == "current", let window = row["window"].string,
          let reset = row["resetsAtMs"].number, let seen = row["seenAtMs"].number,
          reset.isFinite, seen.isFinite, reset > seen
        else { continue }
        let key = provider.id + ":" + context + ":" + window
        if mayGreet, !newContext, let prior = previous[key], reset > prior.reset,
          seen >= prior.reset, prior.seen < prior.reset, greetings[provider.id] == nil
        {
          greetings[provider.id] = key + ":" + String(format: "%.0f", reset)
        }
        previous[key] = Reading(reset: reset, seen: seen)
      }
    }
    if visible { skipNextVisible = false }
    return greetings
  }
}
