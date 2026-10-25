import BigInt
import CryptoKit
import Foundation

/// Connexion SRP « YAP » des onduleurs SMA, telle que l'implémente leur interface web :
/// groupe de 8192 bits (RFC 5054), g = 19, SHA-1 pour x, k et u, SHA-256 pour K, M1 et M2 (variante RFC 2945).
/// Port de `electron/sma-core.ts` (ConsoElec), vérifié par des vecteurs croisés.
public enum SRP {
  static let nHex = [
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD",
  "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED",
  "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F",
  "83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B",
  "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA0510",
  "15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7",
  "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C",
  "BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D7",
  "88719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6",
  "287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA9",
  "93B4EA988D8FDDC186FFB7DC90A6C08F4DF435C93402849236C3FAB4D27C7026C1D4DCB2602646DEC9751E763DBA37BD",
  "F8FF9406AD9E530EE5DB382F413001AEB06A53ED9027D831179727B0865A8918DA3EDBEBCF9B14ED44CE6CBACED4BB1B",
  "DB7F1447E6CC254B332051512BD7AF426FB8F401378CD2BF5983CA01C64B92ECF032EA15D1721D03F482D7CE6E74FEF6",
  "D55E702F46980C82B5A84031900B1C9E59E7C97FBEC7E8F323A97A7E36CC88BE0F1D45B7FF585AC54BD407B22B4154AA",
  "CC8F6D7EBF48E1D814CC5ED20F8037E0A79715EEF29BE32806A1D58BB7C5DA76F550AA3D8A1FBFF0EB19CCB1A313D55C",
  "DA56C9EC2EF29632387FE8D76E3C0468043E8F663F4860EE12BF2D5B0B7474D6E694F91E6DBE115974A3926F12FEE5E4",
  "38777CB6A932DF8CD8BEC4D073B931BA3BC832B68D9DD300741FA7BF8AFC47ED2576F6936BA424663AAB639C5AE4F568",
  "3423B4742BF1C978238F16CBE39D652DE3FDB8BEFC848AD922222E04A4037C0713EB57A81A23F0C73473FC646CEA306B",
  "4BCBC8862F8385DDFA9D4B7FA2C087E879683303ED5BDD3A062B3CF5B3A278A66D2A13F83F44F82DDF310EE074AB6A36",
  "4597E899A0255DC164F31CC50846851DF9AB48195DED7EA1B1D510BD7EE74D73FAF36BC31ECFA268359046F4EB879F92",
  "4009438B481C6CD7889A002ED5EE382BC9190DA6FC026E479558E4475677E9AA9E3050E2765694DFC81F56E880B96E71",
  "60C980DD98EDD3DFFFFFFFFFFFFFFFFF"
  ].joined()

  public static let N = BigUInt(nHex, radix: 16)!
  public static let g = BigUInt(19)
  static let nBytes = 1024

  static func bytes(_ n: BigUInt) -> Data {
    let d = n.serialize()
    return d.isEmpty ? Data([0]) : d
  }

  static func pad(_ d: Data) -> Data {
    d.count >= nBytes ? d : Data(repeating: 0, count: nBytes - d.count) + d
  }

  static func strip(_ d: Data) -> Data {
    var i = d.startIndex
    while i < d.endIndex - 1 && d[i] == 0 { i += 1 }
    return d[i...]
  }

  static func sha1(_ parts: Data...) -> Data {
    var h = Insecure.SHA1()
    for p in parts { h.update(data: p) }
    return Data(h.finalize())
  }

  static func sha256(_ parts: Data...) -> Data {
    var h = SHA256()
    for p in parts { h.update(data: p) }
    return Data(h.finalize())
  }

  public struct Start {
    public let a: BigUInt
    public let A: Data
    /// Corps de `/dyn/authYAPStart.json`.
    public var body: [String: String] { ["username": role, "A": A.hexString] }
    let role: String
  }

  public struct Finish {
    public let M1: Data
    public let expectedM2: Data
  }

  public static func start(role: String, randomA: Data? = nil) -> Start {
    let random = randomA ?? Data((0..<48).map { _ in UInt8.random(in: 0...255) })
    let a = BigUInt(random)
    return Start(a: a, A: pad(bytes(g.power(a, modulus: N))), role: role)
  }

  public enum SRPError: Error { case invalidServerValue }

  public static func finish(_ start: Start, secret: String, B Bhex: String, salt saltHex: String) throws -> Finish {
    let I = Data(start.role.utf8)
    let salt = strip(Data(hex: saltHex))
    let Bbuf = pad(Data(hex: Bhex))
    let B = BigUInt(Bbuf)
    guard B % N != 0 else { throw SRPError.invalidServerValue }
    let k = BigUInt(sha1(pad(bytes(N)), pad(bytes(g))))
    let x = BigUInt(sha1(salt, sha1(I + Data(":".utf8) + Data(secret.utf8))))
    let u = BigUInt(sha1(start.A, Bbuf))
    let kv = (k * g.power(x, modulus: N)) % N
    let base = (B + N - kv) % N
    let S = base.power(start.a + u * x, modulus: N)
    let K = sha256(bytes(S))
    var hN = [UInt8](sha256(bytes(N)))
    let hG = [UInt8](sha256(bytes(g)))
    for i in 0..<hN.count { hN[i] ^= hG[i] }
    let M1 = sha256(Data(hN), sha256(I), salt, strip(start.A), strip(Bbuf), K)
    let M2 = sha256(strip(start.A), M1, K)
    return Finish(M1: M1, expectedM2: M2)
  }
}

extension Data {
  public init(hex: String) {
    var data = Data(capacity: hex.count / 2)
    var index = hex.startIndex
    if hex.count % 2 == 1 {
      data.append(UInt8(String(hex[index]), radix: 16) ?? 0)
      index = hex.index(after: index)
    }
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      data.append(UInt8(hex[index..<next], radix: 16) ?? 0)
      index = next
    }
    self = data
  }

  public var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
