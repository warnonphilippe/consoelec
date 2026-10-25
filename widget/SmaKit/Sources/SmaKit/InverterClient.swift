import CryptoKit
import Foundation

/// Client local de l'onduleur (WebConnect) : connexion SRP avec la clé de la plaque, lecture des mesures, déconnexion.
/// Le certificat auto-signé de l'onduleur est épinglé : la première empreinte vue est mémorisée par l'appelant ; toute
/// empreinte différente ensuite est refusée avant qu'aucune donnée ne soit envoyée.
public final class InverterClient: NSObject, URLSessionDelegate, @unchecked Sendable {
  public let host: String
  public let role: String
  private let pinnedFingerprint: String?
  private let lock = NSLock()
  private var _seenFingerprint: String?
  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 15
    config.waitsForConnectivity = false
    return URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }()

  /// Empreinte SHA-256 du certificat présenté par l'onduleur (format `AA:BB:…`), à épingler la première fois.
  public var seenFingerprint: String? {
    lock.lock(); defer { lock.unlock() }
    return _seenFingerprint
  }

  public init(host: String, role: String = "usr", pinnedFingerprint: String?) {
    self.host = host
    self.role = role
    self.pinnedFingerprint = pinnedFingerprint
  }

  /// Se connecte, lit les mesures et se déconnecte (l'onduleur limite le nombre de sessions).
  public func read(secret: String) async throws -> Measurements {
    guard !host.isEmpty else { throw InverterError.missingHost }
    let sid = try await login(secret: secret)
    defer { Task { [session, host] in _ = try? await Self.post(session, host: host, path: "/dyn/logout.json?sid=\(sid)", body: [:]) } }
    let (status, json) = try await Self.post(session, host: host, path: "/dyn/getValues.json?sid=\(sid)", body: ["destDev": [], "keys": MeasurementKey.all])
    if Parsing.sessionExpired(status: status, json: json) {
      throw InverterError.unexpected("session expirée")
    }
    return try Parsing.measurements(json)
  }

  private func login(secret: String) async throws -> String {
    let start = SRP.start(role: role)
    let (s1, first) = try await Self.post(session, host: host, path: "/dyn/authYAPStart.json", body: start.body)
    guard let B = first?["B"] as? String, let salt = first?["salt"] as? String else {
      throw Parsing.error(status: s1, json: first)
    }
    let finish = try SRP.finish(start, secret: secret, B: B, salt: salt)
    var body: [String: Any] = ["M1": finish.M1.hexString]
    if let id = first?["id"] { body["id"] = id }
    let (s2, second) = try await Self.post(session, host: host, path: "/dyn/authYAPFinish.json", body: body)
    guard let M2 = second?["M2"] as? String else { throw Parsing.error(status: s2, json: second) }
    guard M2.lowercased() == finish.expectedM2.hexString else {
      throw InverterError.unexpected("authentification de l'onduleur")
    }
    let sid = ((second?["result"] as? [String: Any])?["sid"] as? String) ?? (second?["sid"] as? String)
    guard let sid else { throw InverterError.unexpected("pas de session") }
    return sid
  }

  static func post(_ session: URLSession, host: String, path: String, body: [String: Any]) async throws -> (Int, [String: Any]?) {
    guard let url = URL(string: "https://\(host)\(path)") else { throw InverterError.missingHost }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    do {
      let (data, response) = try await session.data(for: request)
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      return (status, try? JSONSerialization.jsonObject(with: data) as? [String: Any])
    } catch let error as InverterError {
      throw error
    } catch {
      if (error as NSError).code == NSURLErrorCancelled { throw InverterError.certificateChanged }
      throw InverterError.unreachable(host)
    }
  }

  // MARK: - Épinglage du certificat

  public func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let trust = challenge.protectionSpace.serverTrust,
          let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
          let leaf = chain.first
    else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    let fingerprint = Self.fingerprint(SecCertificateCopyData(leaf) as Data)
    lock.lock(); _seenFingerprint = fingerprint; lock.unlock()
    if let pinned = pinnedFingerprint, Self.normalize(pinned) != Self.normalize(fingerprint) {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  public static func fingerprint(_ der: Data) -> String {
    SHA256.hash(data: der).map { String(format: "%02X", $0) }.joined(separator: ":")
  }

  static func normalize(_ f: String) -> String { f.replacingOccurrences(of: ":", with: "").uppercased() }
}
