import Foundation

/// Mesures lues sur l'onduleur.
public struct Measurements: Codable, Equatable, Sendable {
  /// Puissance AC instantanée (W) ; `nil` la nuit.
  public var powerW: Double?
  /// Production du jour (Wh).
  public var dayWh: Double?
  /// Production totale cumulée (Wh).
  public var totalWh: Double?

  public init(powerW: Double?, dayWh: Double?, totalWh: Double?) {
    self.powerW = powerW
    self.dayWh = dayWh
    self.totalWh = totalWh
  }
}

public enum MeasurementKey {
  public static let powerW = "6100_40263F00"
  public static let totalWh = "6400_00260100"
  public static let dayWh = "6400_00262200"
  public static let all = [powerW, totalWh, dayWh]
}

public enum InverterError: LocalizedError, Equatable {
  case missingKey
  case missingHost
  case wrongKey
  case loginDisabled
  case locked
  case busy
  case certificateChanged
  case unreachable(String)
  case unexpected(String)

  public var errorDescription: String? {
    switch self {
    case .missingKey: return "Clé de l'onduleur absente : saisissez-la dans l'app ConsoElec Widget."
    case .missingHost: return "Adresse de l'onduleur non renseignée."
    case .wrongKey: return "Clé refusée par l'onduleur : vérifiez la clé WPA2-PSK de la plaque."
    case .loginDisabled: return "Connexion désactivée sur l'onduleur pour ce profil."
    case .locked: return "Profil bloqué sur l'onduleur : réessayez dans quelques minutes."
    case .busy: return "L'onduleur n'accepte plus de session pour l'instant."
    case .certificateChanged: return "Le certificat de l'onduleur a changé : connexion refusée."
    case .unreachable(let host): return "Onduleur injoignable (\(host))."
    case .unexpected(let detail): return "Réponse inattendue de l'onduleur (\(detail))."
    }
  }
}

enum Parsing {
  /// Erreur d'une réponse de l'onduleur, d'après son code HTTP et le champ `result.res`.
  static func error(status: Int, json: [String: Any]?) -> InverterError {
    let res = (json?["result"] as? [String: Any])?["res"] as? Int
    if res == -28607 { return .wrongKey }
    if res == -28603 { return .loginDisabled }
    switch status {
    case 401: return .wrongKey
    case 403: return .locked
    case 503: return .busy
    default: return .unexpected("HTTP \(status)")
    }
  }

  /// Décode `/dyn/getValues.json` : `result → appareil → clé → { "1": [ { "val": … } ] }`.
  /// La réponse peut lister plusieurs appareils : chaque mesure est prise dans le premier qui en donne une valeur
  /// (l'ordre d'un dictionnaire Swift n'est pas fixe, on ne peut pas se fier au « premier » appareil).
  static func measurements(_ json: [String: Any]?) throws -> Measurements {
    guard let result = json?["result"] as? [String: Any] else {
      throw InverterError.unexpected("mesures")
    }
    let devices = result.values.compactMap { $0 as? [String: Any] }
    guard !devices.isEmpty else {
      throw InverterError.unexpected("mesures")
    }
    func read(_ key: String) -> Double? {
      for device in devices {
        guard let entry = device[key] as? [String: Any] else { continue }
        for case let values as [[String: Any]] in entry.values {
          if let value = (values.first?["val"] as? NSNumber)?.doubleValue {
            return value
          }
        }
      }
      return nil
    }
    return Measurements(powerW: read(MeasurementKey.powerW), dayWh: read(MeasurementKey.dayWh), totalWh: read(MeasurementKey.totalWh))
  }

  static func sessionExpired(status: Int, json: [String: Any]?) -> Bool {
    status == 401 || (json?["err"] as? Int) == 401
  }
}
