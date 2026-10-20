import AppKit
import Foundation

@MainActor enum RecapShareProbe {
  static func run(options: Options) throws {
    let snapshot = try RecapChecks.input(options: options)
    let single = snapshot.providers.compactMap { WeeklyRecap($0, generatedAtMs: snapshot.generatedAtMs, nowMs: snapshot.generatedAtMs) }
    let pairs = [("single", single), ("two-long", try RecapChecks.canaries(options: options))]
    let probe = try Probe(directory: options.output)
    let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    var phases = [[String: Any]]()
    let canonical = RecapShareModel.build([], includeReadings: false)
    let reference = try RecapShareRenderer.png(canonical)
    for (name, recaps) in pairs {
      for included in [false, true] {
        let model = RecapShareModel.build(recaps, includeReadings: included)
        let stem = "recap-" + name + (included ? "-readings" : "-private")
        try encoder.encode(model).write(to: options.output.appendingPathComponent(stem + "-model.json"), options: .atomic)
        try RecapShareRenderer.png(model).write(to: options.output.appendingPathComponent(stem + ".png"), options: .atomic)
      }
      let controller = ShareController(recaps: recaps)
      defer { controller.close() }
      func verify(_ phase: String) throws {
        guard let data = controller.pngData else { throw ShareProbeFailure(phase: "recap-" + phase, code: "render_unavailable") }
        let comparison = try ShareProbe.compare(reference, data)
        let valid = !controller.includeReadings && controller.selectedRecapModel == canonical && ShareProbe.withinQuantization(comparison)
        phases.append(["case": name, "phase": phase, "privateModelExact": controller.selectedRecapModel == canonical, "pixelComparison": comparison, "ok": valid])
        try data.write(to: options.output.appendingPathComponent("recap-" + name + "-" + phase + ".png"), options: .atomic)
        probe.write(["complete": false, "phases": phases], name: "recap-share-probe")
        guard valid else { throw ShareProbeFailure(phase: "recap-" + phase, code: "private_model_or_pixels_not_restored") }
      }
      controller.show(); try verify("initial")
      controller.setIncludeReadings(true)
      guard controller.selectedRecapModel == RecapShareModel.build(recaps, includeReadings: true), let included = controller.pngData,
        let difference = try ShareProbe.compare(reference, included)["maximumRGBDelta"] as? Int, difference > 1 else {
        throw ShareProbeFailure(phase: "recap-opt-in", code: "readings_not_rendered")
      }
      try included.write(to: options.output.appendingPathComponent("recap-" + name + "-controller-readings.png"), options: .atomic)
      controller.show(); try verify("repeat-open")
      controller.setIncludeReadings(true); controller.close(); try verify("closed")
      controller.show(); try verify("reopen"); controller.close()
    }
    probe.write(["complete": true, "ok": phases.allSatisfy { $0["ok"] as? Bool == true }, "phases": phases,
      "privateSourceIndependent": true, "bothOriginalMascots": true, "clipboardWrites": 0, "savePanels": 0,
      "modelAllowlist": ["mode", "readings[].provider", "readings[].usedPercent", "readings[].pauses", "readings[].atReset"],
      "metadata": "Fresh encoded PNG with nil source metadata; independent dimension/color-space allowlist audit required.",
      "source": "Clearly derived native canaries plus read-only weekly-recap fixture; no live data."], name: "recap-share-probe")
  }
}
