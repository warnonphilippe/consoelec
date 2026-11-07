import Foundation
import Network
import SmaKit

/// Cherche des appareils sur le réseau local par Bonjour et en déduit leur nom réseau.
/// - onduleurs SMA : `_http._tcp`, « Website for SMA-Inverter: SMA<numéro de série>[-N] » → `SMA<n°>[-N].local` ;
/// - lecteurs P1 HomeWizard : `_hwenergy._tcp`, `p1meter-<6 caractères>[-N]` → `p1meter-xxxxxx[-N].local`.
/// Le suffixe `-N` (ajouté par l'appareil après un conflit de nom) est gardé : il fait partie du nom réseau.
@MainActor
final class BonjourDiscovery: ObservableObject {
  @Published private(set) var hosts: [String] = []
  @Published private(set) var searching = false
  private var browser: NWBrowser?
  private let serviceType: String
  private let hostFromName: @Sendable (String) -> String?

  init(serviceType: String, hostFromName: @escaping @Sendable (String) -> String?) {
    self.serviceType = serviceType
    self.hostFromName = hostFromName
  }

  static func inverters() -> BonjourDiscovery { BonjourDiscovery(serviceType: "_http._tcp", hostFromName: inverterHost) }
  static func p1Meters() -> BonjourDiscovery { BonjourDiscovery(serviceType: "_hwenergy._tcp", hostFromName: p1Host) }

  nonisolated static func inverterHost(fromServiceName name: String) -> String? {
    DeviceNames.inverterHost(fromServiceName: name)
  }

  nonisolated static func p1Host(fromServiceName name: String) -> String? {
    DeviceNames.p1Host(fromServiceName: name)
  }

  func search(seconds: Double = 4) async -> [String] {
    browser?.cancel()
    hosts = []
    searching = true
    let browser = NWBrowser(for: .bonjour(type: serviceType, domain: "local."), using: .tcp)
    self.browser = browser
    let hostFromName = self.hostFromName
    browser.browseResultsChangedHandler = { [weak self] results, _ in
      let found = results.compactMap { result -> String? in
        if case let .service(name, _, _, _) = result.endpoint { return hostFromName(name) }
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
