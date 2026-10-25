import Foundation
import Network

/// Cherche les onduleurs SMA sur le réseau local : ils s'annoncent en Bonjour (`_http._tcp`) sous le nom
/// « Website for SMA-Inverter: SMA<numéro de série> ».
@MainActor
final class InverterDiscovery: ObservableObject {
  @Published private(set) var hosts: [String] = []
  @Published private(set) var searching = false
  private var browser: NWBrowser?

  nonisolated static func host(fromServiceName name: String) -> String? {
    guard let range = name.range(of: #"SMA\d{6,}"#, options: .regularExpression) else { return nil }
    return "\(name[range].uppercased()).local"
  }

  func search(seconds: Double = 4) async -> [String] {
    browser?.cancel()
    hosts = []
    searching = true
    let browser = NWBrowser(for: .bonjour(type: "_http._tcp", domain: "local."), using: .tcp)
    self.browser = browser
    browser.browseResultsChangedHandler = { [weak self] results, _ in
      let found = results.compactMap { result -> String? in
        if case let .service(name, _, _, _) = result.endpoint { return InverterDiscovery.host(fromServiceName: name) }
        return nil
      }
      Task { @MainActor in self?.hosts = Array(Set(found)).sorted() }
    }
    browser.start(queue: .main)
    try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    browser.cancel()
    searching = false
    return hosts
  }
}
