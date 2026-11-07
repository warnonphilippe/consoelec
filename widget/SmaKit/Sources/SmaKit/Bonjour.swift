import Foundation
import Network

/// Noms réseau (Bonjour) des appareils de la maison. En cas de conflit de nom sur le réseau, un appareil se renomme
/// avec un suffixe `-2`, `-3`… : le suffixe fait partie du nom à utiliser, mais pas de l'identité de l'appareil.
public enum DeviceNames {
  /// Onduleur SMA : « Website for SMA-Inverter: SMA<numéro de série>[-N] » → `SMA<n°>[-N].local`.
  public static func inverterHost(fromServiceName name: String) -> String? {
    guard let range = name.range(of: #"SMA\d{6,}(-\d+)?"#, options: .regularExpression) else { return nil }
    return "\(name[range].uppercased()).local"
  }

  /// Lecteur P1 HomeWizard : `p1meter-<6 caractères>[-N]` → `p1meter-xxxxxx[-N].local`.
  public static func p1Host(fromServiceName name: String) -> String? {
    guard let range = name.range(of: #"p1meter-[0-9A-Za-z]{6}(-\d+)?"#, options: [.regularExpression, .caseInsensitive])
    else { return nil }
    return "\(name[range].lowercased()).local"
  }

  /// Numéro de série d'un onduleur d'après son nom réseau, sans suffixe ; `nil` pour une adresse IP ou un autre nom.
  public static func smaSerial(_ host: String) -> String? {
    identity(host, pattern: #"^(SMA\d{6,})(-\d+)?(\.local\.?)?$"#)?.uppercased()
  }

  /// Identifiant d'un lecteur P1 d'après son nom réseau, sans suffixe ; `nil` pour une adresse IP ou un autre nom.
  public static func p1Identity(_ host: String) -> String? {
    identity(host, pattern: #"^(p1meter-[0-9A-Za-z]{6})(-\d+)?(\.local\.?)?$"#)?.lowercased()
  }

  private static func identity(_ host: String, pattern: String) -> String? {
    let trimmed = host.trimmingCharacters(in: .whitespaces)
    guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive),
          let match = regex.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
          let range = Range(match.range(at: 1), in: trimmed)
    else { return nil }
    return String(trimmed[range])
  }

  /// Nouveau nom du même appareil (même identifiant) parmi ceux trouvés, ou `nil`.
  public static func relocated(_ current: String, found: [String], identity: (String) -> String?) -> String? {
    guard let id = identity(current) else { return nil }
    return found.first { $0.caseInsensitiveCompare(current) != .orderedSame && identity($0) == id }
  }
}

/// Recherche Bonjour de quelques secondes sur le réseau local ; renvoie les noms de service annoncés.
public enum BonjourBrowser {
  public static func serviceNames(type: String, seconds: Double = 3) async -> [String] {
    let browser = NWBrowser(for: .bonjour(type: type, domain: "local."), using: .tcp)
    let queue = DispatchQueue(label: "consoelec.bonjour")
    let names = NamesBox()
    browser.browseResultsChangedHandler = { results, _ in
      names.set(results.compactMap { result in
        if case let .service(name, _, _, _) = result.endpoint { return name }
        return nil
      })
    }
    browser.start(queue: queue)
    try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    browser.cancel()
    return names.get()
  }

  /// Noms réseau des onduleurs SMA annoncés.
  public static func inverters(seconds: Double = 3) async -> [String] {
    Array(Set(await serviceNames(type: "_http._tcp", seconds: seconds).compactMap(DeviceNames.inverterHost))).sorted()
  }

  /// Noms réseau des lecteurs P1 HomeWizard annoncés.
  public static func p1Meters(seconds: Double = 3) async -> [String] {
    Array(Set(await serviceNames(type: "_hwenergy._tcp", seconds: seconds).compactMap(DeviceNames.p1Host))).sorted()
  }

  private final class NamesBox: @unchecked Sendable {
    private let lock = NSLock()
    private var names: [String] = []
    func set(_ value: [String]) { lock.lock(); names = value; lock.unlock() }
    func get() -> [String] { lock.lock(); defer { lock.unlock() }; return names }
  }
}

/// Reprise automatique quand un appareil ne répond plus sous son nom : recherche Bonjour au plus toutes les 10 minutes
/// (le widget est relancé toutes les 5 minutes environ), l'heure de la dernière recherche étant gardée dans le groupe d'apps.
enum Relocation {
  static let minInterval: TimeInterval = 10 * 60

  static func shouldSearch(lastSearch: Date?, now: Date) -> Bool {
    guard let lastSearch else { return true }
    return now.timeIntervalSince(lastSearch) >= minInterval || now < lastSearch
  }
}
