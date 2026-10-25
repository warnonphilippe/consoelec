import SwiftUI

@main
struct ConsoElecWidgetApp: App {
  var body: some Scene {
    WindowGroup("ConsoElec Widget") {
      SettingsView()
        .frame(minWidth: 520, minHeight: 560)
    }
    .windowResizability(.contentSize)
  }
}
