import Foundation

func ease(_ t: Double, _ strength: Double) -> Double {
  let p = max(0, min(1, t))
  let s = strength / 100
  return p * (1 - s) + (1 - pow(1 - p, 3)) * s
}
func positiveMod(_ value: Double, _ modulus: Double) -> Double {
  value - floor(value / modulus) * modulus
}

struct Frame: Decodable {
  let file: String
  let ms: Double
  let sha256: String
}
struct Pet: Decodable {
  let mirrorLeft: Bool
  let right: [Frame]
  let left: [Frame]?
  let idle: Frame
  let cup: String
}
struct Atlas: Decodable {
  let width: Int
  let height: Int
  let sourceSha256: String
  let providers: [String: Pet]
}
struct Reaction {
  let kind: String
  let started: Double
  var duration: Double { kind == "pause" ? 320 : kind == "resume" ? 200 : 420 }
}
struct Pose {
  var file: String
  var index: Int
  var x: Double
  var flip: Bool
  var cup: Double
  var cupLift: Double
  var dy: Double
  var stretch: Double
}

final class Actor {
  let provider: String
  var travel: Double
  var paused = false
  var reaction: Reaction?
  var window: String?
  init(_ provider: String, _ travel: Double) {
    self.provider = provider
    self.travel = travel
  }
  @discardableResult func trigger(
    _ kind: String, _ now: Double, _ reduced: Bool, _ id: String? = nil
  ) -> Bool {
    if kind == "greet" {
      if id == window { return false }
      window = id
      if reaction != nil { return false }
    }
    if kind == "pause" { paused = true }
    if kind == "resume" {
      if !paused { return false }
      paused = false
    }
    reaction = reduced ? nil : Reaction(kind: kind, started: now)
    return true
  }
  func tick(_ dt: Double, _ now: Double, _ reduced: Bool) {
    var active = max(0, dt)
    if let r = reaction {
      let end = r.started + r.duration
      if now >= end {
        active = max(0, now - max(now - dt, end))
        reaction = nil
      } else {
        active = 0
      }
    }
    if !reduced && !paused && reaction == nil { travel += active }
  }
  func pose(_ atlas: Atlas, _ now: Double, _ reduced: Bool, _ trackWidth: Double) -> Pose {
    let pet = atlas.providers[provider]!
    let phase = positiveMod(travel, 10000) / 5000
    let left = phase >= 1
    let frames = left ? (pet.left ?? pet.right) : pet.right
    var t = positiveMod(travel, frames.reduce(0) { $0 + $1.ms })
    var index = frames.count - 1
    for (i, f) in frames.enumerated() {
      if t < f.ms {
        index = i
        break
      }
      t -= f.ms
    }
    let r = reduced ? nil : reaction
    let idle = reduced || paused || r != nil
    var p = Pose(
      file: idle ? pet.idle.file : frames[index].file, index: index,
      x: floor((trackWidth - Double(atlas.width)) * (left ? 2 - phase : phase) + 0.5),
      flip: !idle && left && pet.mirrorLeft, cup: paused ? 1 : 0, cupLift: 0, dy: 0, stretch: 0)
    if let r = r {
      let elapsed = now - r.started
      if r.kind == "pause" {
        p.dy = floor(sin(.pi * ease(elapsed / 120, 75)) + 0.5)
        p.cup = ease((elapsed - 160) / 160, 75)
        p.cupLift = floor(3 * (1 - p.cup) + 0.5)
      } else if r.kind == "resume" {
        p.cup = 1 - ease(elapsed / 80, 70)
        p.dy = floor(sin(.pi * ease((elapsed - 80) / 120, 70)) + 0.5)
      } else {
        p.stretch = floor(2 * sin(.pi * ease(elapsed / 420, 70)) + 0.5)
        p.dy = -p.stretch
      }
    }
    return p
  }
}
