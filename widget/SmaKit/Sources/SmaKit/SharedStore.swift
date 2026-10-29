import Foundation
import Security

/// Données partagées entre l'app de réglage et les widgets (groupe d'apps) : adresse, certificat épinglé,
/// dernière lecture réussie et courbe de la journée de l'onduleur ; adresse et lectures récentes du lecteur P1.
/// La clé de l'onduleur est dans le Trousseau, pas ici.
public final class SharedStore: @unchecked Sendable {
  public static let appGroupSuffix = "group.io.github.warnonphilippe.consoelec"

  private let defaults: UserDefaults

  public init(appGroup: String?) {
    defaults = appGroup.flatMap { UserDefaults(suiteName: $0) } ?? .standard
  }

  public var host: String {
    get { defaults.string(forKey: "host") ?? "" }
    set { defaults.set(newValue, forKey: "host") }
  }

  public var pinnedFingerprint: String? {
    get { defaults.string(forKey: "certFingerprint") }
    set { defaults.set(newValue, forKey: "certFingerprint") }
  }

  public var last: Snapshot? {
    get { defaults.data(forKey: "last").flatMap { try? JSONDecoder().decode(Snapshot.self, from: $0) } }
    set { defaults.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "last") }
  }

  public var curve: DayCurve {
    get { defaults.data(forKey: "curve").flatMap { try? JSONDecoder().decode(DayCurve.self, from: $0) } ?? DayCurve() }
    set { defaults.set(try? JSONEncoder().encode(newValue), forKey: "curve") }
  }

  /// Adresse du lecteur HomeWizard P1 (`p1meter-XXXXXX.local` ou IP).
  public var p1Host: String {
    get { defaults.string(forKey: "p1Host") ?? "" }
    set { defaults.set(newValue, forKey: "p1Host") }
  }

  /// Lectures du compteur de la dernière heure.
  public var meterHistory: MeterHistory {
    get { defaults.data(forKey: "meterHistory").flatMap { try? JSONDecoder().decode(MeterHistory.self, from: $0) } ?? MeterHistory() }
    set { defaults.set(try? JSONEncoder().encode(newValue), forKey: "meterHistory") }
  }
}

/// Dernière lecture réussie.
public struct Snapshot: Codable, Equatable, Sendable {
  public var measurements: Measurements
  public var at: Date

  public init(measurements: Measurements, at: Date) {
    self.measurements = measurements
    self.at = at
  }
}

/// Puissance au fil de la journée (un point par lecture), remise à zéro chaque jour.
public struct DayCurve: Codable, Equatable, Sendable {
  public struct Point: Codable, Equatable, Sendable {
    public var at: Date
    public var powerW: Double
  }

  public var day: String = ""
  public var points: [Point] = []

  public init() {}

  static let maxPoints = 300

  public static func dayKey(_ date: Date, calendar: Calendar = .current) -> String {
    let c = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
  }

  /// Ajoute une lecture ; la nuit (pas de puissance) compte comme 0 W.
  public mutating func add(powerW: Double?, at date: Date, calendar: Calendar = .current) {
    let key = Self.dayKey(date, calendar: calendar)
    if key != day {
      day = key
      points = []
    }
    points.append(Point(at: date, powerW: max(0, powerW ?? 0)))
    if points.count > Self.maxPoints {
      points.removeFirst(points.count - Self.maxPoints)
    }
  }

  public var peakW: Double { points.map(\.powerW).max() ?? 0 }
}

/// Clé de l'onduleur dans le Trousseau (macOS ou iOS), partagée avec le widget par un groupe d'accès.
public enum InverterKeychain {
  static let service = "io.github.warnonphilippe.consoelec.inverter"
  static let account = "wlan-psk"

  static func query(accessGroup: String?) -> [String: Any] {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecUseDataProtectionKeychain as String: true,
    ]
    if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
    return q
  }

  public static func read(accessGroup: String?) -> String? {
    var q = query(accessGroup: accessGroup)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  @discardableResult
  public static func save(_ value: String, accessGroup: String?) -> Bool {
    let q = query(accessGroup: accessGroup)
    SecItemDelete(q as CFDictionary)
    var add = q
    add[kSecValueData as String] = Data(value.utf8)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
  }

  public static func delete(accessGroup: String?) {
    SecItemDelete(query(accessGroup: accessGroup) as CFDictionary)
  }
}

/// Lecture complète utilisée par l'app et le widget : clé du Trousseau, client épinglé, mémorisation du résultat.
public enum ProductionReader {
  public struct Outcome: Sendable {
    public var snapshot: Snapshot?
    public var curve: DayCurve
    public var error: String?
    public var live: Bool
  }

  public static func refresh(store: SharedStore, keychainGroup: String?, now: Date = Date()) async -> Outcome {
    guard let secret = InverterKeychain.read(accessGroup: keychainGroup), !secret.isEmpty else {
      return Outcome(snapshot: store.last, curve: store.curve, error: InverterError.missingKey.errorDescription, live: false)
    }
    let client = InverterClient(host: store.host, pinnedFingerprint: store.pinnedFingerprint)
    do {
      let m = try await client.read(secret: secret)
      if store.pinnedFingerprint == nil, let seen = client.seenFingerprint {
        store.pinnedFingerprint = seen
      }
      let snapshot = Snapshot(measurements: m, at: now)
      var curve = store.curve
      curve.add(powerW: m.powerW, at: now)
      store.last = snapshot
      store.curve = curve
      return Outcome(snapshot: snapshot, curve: curve, error: nil, live: true)
    } catch {
      return Outcome(snapshot: store.last, curve: store.curve, error: error.localizedDescription, live: false)
    }
  }
}
