import Foundation

/// Lecture du compteur par le lecteur HomeWizard P1 : index cumulés (heures pleines + creuses) et puissances.
public struct MeterReading: Codable, Equatable, Sendable {
  public var at: Date
  /// Index de soutirage, 1.8.1 + 1.8.2 (kWh).
  public var importKwh: Double
  /// Index d'injection, 2.8.1 + 2.8.2 (kWh).
  public var exportKwh: Double
  /// Puissance instantanée (W) : positive en soutirage, négative en injection.
  public var powerW: Double?
  /// Moyenne du quart d'heure en cours (W), donnée par le compteur belge.
  public var quarterHourAvgW: Double?

  public init(at: Date, importKwh: Double, exportKwh: Double, powerW: Double? = nil, quarterHourAvgW: Double? = nil) {
    self.at = at
    self.importKwh = importKwh
    self.exportKwh = exportKwh
    self.powerW = powerW
    self.quarterHourAvgW = quarterHourAvgW
  }

  /// Décode la réponse de `/api/v1/data` (mêmes champs que `electron/p1-core.ts`).
  public static func parse(_ data: Data, at: Date) throws -> MeterReading {
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw MeterError.unexpected("JSON")
    }
    func number(_ key: String) -> Double? { (json[key] as? NSNumber)?.doubleValue }
    guard let i1 = number("total_power_import_t1_kwh"), let i2 = number("total_power_import_t2_kwh"),
          let e1 = number("total_power_export_t1_kwh"), let e2 = number("total_power_export_t2_kwh")
    else {
      throw MeterError.unexpected("index absents")
    }
    return MeterReading(
      at: at, importKwh: i1 + i2, exportKwh: e1 + e2,
      powerW: number("active_power_w"), quarterHourAvgW: number("active_power_average_w"))
  }
}

/// Soutirage et injection moyens entre deux lectures.
public struct MeterAverage: Equatable, Sendable {
  public var importW: Double
  public var exportW: Double
  public var from: Date
  public var to: Date

  public var minutes: Int { Int((to.timeIntervalSince(from) / 60).rounded()) }
}

/// Lectures de la dernière heure, d'où sont tirées les moyennes.
public struct MeterHistory: Codable, Equatable, Sendable {
  public var readings: [MeterReading] = []

  public init() {}

  static let keptSeconds: TimeInterval = 60 * 60

  public mutating func add(_ reading: MeterReading) {
    readings = readings.filter { $0.at < reading.at && reading.at.timeIntervalSince($0.at) <= Self.keptSeconds } + [reading]
  }

  /// Moyenne entre la dernière lecture et la plus récente prise au moins `minMinutes` avant (à 30 s près : un widget
  /// est parfois rafraîchi un peu tôt), et au plus `maxMinutes` avant. Le compteur donne ses index au Wh près.
  public func average(minMinutes: Double = 5, maxMinutes: Double = 30) -> MeterAverage? {
    guard let to = readings.last else { return nil }
    guard let from = readings.last(where: { to.at.timeIntervalSince($0.at) >= minMinutes * 60 - 30 }),
          to.at.timeIntervalSince(from.at) <= maxMinutes * 60
    else { return nil }
    let hours = to.at.timeIntervalSince(from.at) / 3600
    let watts = { (kwh: Double) in max(0, (kwh / hours * 1000).rounded()) }
    return MeterAverage(
      importW: watts(to.importKwh - from.importKwh), exportW: watts(to.exportKwh - from.exportKwh),
      from: from.at, to: to.at)
  }
}

public enum MeterError: LocalizedError, Equatable {
  case missingHost
  case apiDisabled
  case unreachable(String)
  case unexpected(String)

  public var errorDescription: String? {
    switch self {
    case .missingHost: return "Adresse du lecteur P1 non renseignée."
    case .apiDisabled:
      return "L'API locale du lecteur est désactivée : activez-la dans l'application HomeWizard Energy (réglages du compteur P1 → API locale)."
    case .unreachable(let host): return "Lecteur P1 injoignable (\(host))."
    case .unexpected(let detail): return "Réponse inattendue du lecteur P1 (\(detail))."
    }
  }
}

/// API locale v1 du lecteur HomeWizard (HTTP, sans authentification, sur le réseau local).
public enum P1Client {
  public static func read(host: String, now: Date = Date()) async throws -> MeterReading {
    guard !host.isEmpty, let url = URL(string: "http://\(host)/api/v1/data") else { throw MeterError.missingHost }
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 5
    let session = URLSession(configuration: config)
    defer { session.finishTasksAndInvalidate() }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(from: url)
    } catch {
      throw MeterError.unreachable(host)
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status != 200 {
      let code = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
      if status == 403 || code == "api:disabled" || code == "user:unauthorized" { throw MeterError.apiDisabled }
      throw MeterError.unexpected("HTTP \(status)")
    }
    return try MeterReading.parse(data, at: now)
  }
}

/// Lecture complète utilisée par l'app et le widget : lecteur P1, historique partagé, moyenne.
public enum MeterReader {
  public struct Outcome: Sendable {
    public var reading: MeterReading?
    public var average: MeterAverage?
    public var error: String?
    public var live: Bool

    public init(reading: MeterReading?, average: MeterAverage?, error: String?, live: Bool) {
      self.reading = reading
      self.average = average
      self.error = error
      self.live = live
    }
  }

  /// Dernier état connu, sans lire le compteur.
  public static func cached(store: SharedStore) -> Outcome {
    let history = store.meterHistory
    return Outcome(reading: history.readings.last, average: history.average(), error: nil, live: false)
  }

  public static func refresh(store: SharedStore, now: Date = Date()) async -> Outcome {
    do {
      let reading = try await P1Client.read(host: store.p1Host, now: now)
      var history = store.meterHistory
      history.add(reading)
      store.meterHistory = history
      return Outcome(reading: reading, average: history.average(), error: nil, live: true)
    } catch {
      let history = store.meterHistory
      return Outcome(reading: history.readings.last, average: nil, error: error.localizedDescription, live: false)
    }
  }
}
