import Foundation
import SmaKit

// Vérifie le port Swift contre les vecteurs produits par l'implémentation TypeScript de ConsoElec.
let path = CommandLine.arguments.dropFirst().first ?? "Tests/SmaKitTests/srp-vectors.json"
let data = try Data(contentsOf: URL(fileURLWithPath: path))
let vectors = try JSONSerialization.jsonObject(with: data) as! [[String: String]]
var failures = 0
let clock = Date()
for (i, v) in vectors.enumerated() {
  let start = SRP.start(role: v["role"]!, randomA: Data(hex: v["randomA"]!))
  let finish = try SRP.finish(start, secret: v["secret"]!, B: v["B"]!, salt: v["salt"]!)
  let ok = start.A.hexString == v["A"]! && finish.M1.hexString == v["M1"]! && finish.expectedM2.hexString == v["M2"]!
  print("vecteur \(i): \(ok ? "OK" : "ÉCHEC")")
  if !ok { failures += 1 }
}
print(String(format: "durée moyenne : %.0f ms par connexion", Date().timeIntervalSince(clock) * 1000 / Double(vectors.count)))
exit(failures == 0 ? 0 : 1)
