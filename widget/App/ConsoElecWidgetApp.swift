import SwiftUI

@main
struct ConsoElecWidgetApp: App {
  var body: some Scene {
    #if os(macOS)
    WindowGroup("ConsoElec Widget") {
      SettingsView()
        .frame(minWidth: 520, minHeight: 560)
    }
    .windowResizability(.contentSize)
    #else
    WindowGroup {
      NavigationStack {
        SettingsView().navigationTitle("ConsoElec")
      }
    }
    #endif
  }
}
