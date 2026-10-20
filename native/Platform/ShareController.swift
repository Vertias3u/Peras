import AppKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor final class ShareController: NSObject, ObservableObject, NSWindowDelegate {
  // Retain only sanitized candidate models, never the source snapshot or a closure returning it.
  private let privateModel: ShareModel
  private let readingsModel: ShareModel
  private let recapPrivate: RecapShareModel?
  private let recapReadings: RecapShareModel?
  var selectedRecapModel: RecapShareModel? { includeReadings ? recapReadings : recapPrivate }
  @Published private(set) var includeReadings = false
  @Published private(set) var image: NSImage?
  @Published private(set) var status: String?
  private(set) var pngData: Data?
  var selectedModel: ShareModel { includeReadings ? readingsModel : privateModel }
  private var window: NSWindow?
  init(snapshot: Snapshot?) {
    recapPrivate = nil; recapReadings = nil
    privateModel = ShareModel.build(nil, includeReadings: false)
    readingsModel = ShareModel.build(snapshot, includeReadings: true)
    super.init()
    rebuild()
  }
  init(recaps: [WeeklyRecap]) {
    privateModel = ShareModel.build(nil, includeReadings: false)
    readingsModel = ShareModel.build(nil, includeReadings: false)
    recapPrivate = RecapShareModel.build([], includeReadings: false)
    recapReadings = RecapShareModel.build(recaps, includeReadings: true)
    super.init(); rebuild()
  }
  func show() {
    // Each new presentation starts private, including reuse after a previous opt-in.
    includeReadings = false
    rebuild()
    if let window {
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }
    let panel = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 470, height: 570), styleMask: [.titled, .closable],
      backing: .buffered, defer: false)
    panel.title = recapPrivate == nil ? "Preview share image" : "Preview recap image"
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = PerasWindow.behavior
    panel.delegate = self
    panel.contentView = NSHostingView(rootView: SharePreview(controller: self))
    panel.center()
    panel.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    window = panel
  }
  func close() { window?.close() }
  func setIncludeReadings(_ value: Bool) {
    includeReadings = value
    rebuild()
  }
  private func rebuild() {
    do {
      let data = try selectedRecapModel.map { try RecapShareRenderer.png($0) } ?? ShareRenderer.png(selectedModel)
      pngData = data
      image = NSImage(data: data)
      status = nil
    } catch {
      pngData = nil
      image = nil
      status = "The image could not be rendered."
    }
  }
  func copy() {
    guard let pngData, image != nil else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setData(pngData, forType: .png)
    status = "PNG copied"
  }
  func save() {
    guard let window, let pngData, image != nil else { return }
    let panel = NSSavePanel()
    panel.allowedContentTypes = [.png]
    panel.nameFieldStringValue = "Peras.png"
    panel.beginSheetModal(for: window) { response in
      guard response == .OK, let url = panel.url else { return }
      do {
        try pngData.write(to: url, options: .atomic)
        self.status = "PNG saved"
      } catch { self.status = "The image could not be saved." }
    }
  }
  func windowWillClose(_ notification: Notification) {
    includeReadings = false
    rebuild()
    window = nil
    // Closing/previewing never changes the clipboard.
  }
}
struct SharePreview: View {
  @ObservedObject var controller: ShareController
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Preview before sharing").font(.headline)
      if let image = controller.image {
        Image(nsImage: image).resizable().scaledToFit()
          .accessibilityLabel(
            controller.includeReadings
              ? "Share image with provider readings" : "Private share image with no readings")
      }
      Toggle(
        "Include readings",
        isOn: Binding(
          get: { controller.includeReadings }, set: { controller.setIncludeReadings($0) }))
      Text("Account, profile, project, path and time details stay hidden.").font(.caption)
        .foregroundStyle(.secondary)
      HStack {
        if let status = controller.status {
          Text(status).font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        Button("Save PNG…") { controller.save() }.disabled(controller.image == nil)
          .keyboardShortcut("s", modifiers: .command)
        Button("Copy PNG") { controller.copy() }.disabled(controller.image == nil)
          .keyboardShortcut("c", modifiers: .command)
      }
    }.padding(20).frame(width: 470, height: 570)
  }
}
