import SmaKit
import XCTest

final class SmaKitTests: XCTestCase {
  /// Vecteurs produits par l'implémentation TypeScript de ConsoElec (scripts/srp-vectors.mjs).
  func testSrpMatchesTypeScriptVectors() throws {
    let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "srp-vectors", withExtension: "json"))
    let vectors = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: String]])
    XCTAssertFalse(vectors.isEmpty)
    for v in vectors {
      let start = SRP.start(role: v["role"]!, randomA: Data(hex: v["randomA"]!))
      XCTAssertEqual(start.A.hexString, v["A"])
      let finish = try SRP.finish(start, secret: v["secret"]!, B: v["B"]!, salt: v["salt"]!)
      XCTAssertEqual(finish.M1.hexString, v["M1"])
      XCTAssertEqual(finish.expectedM2.hexString, v["M2"])
    }
  }

  func testDayCurveResetsEachDay() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Europe/Brussels")!
    let day1 = calendar.date(from: DateComponents(year: 2026, month: 10, day: 25, hour: 12))!
    var curve = DayCurve()
    curve.add(powerW: 2400, at: day1, calendar: calendar)
    curve.add(powerW: nil, at: day1.addingTimeInterval(3600), calendar: calendar)
    XCTAssertEqual(curve.points.map(\.powerW), [2400, 0])
    XCTAssertEqual(curve.peakW, 2400)
    curve.add(powerW: 100, at: day1.addingTimeInterval(24 * 3600), calendar: calendar)
    XCTAssertEqual(curve.points.count, 1)
    XCTAssertEqual(curve.day, "2026-10-26")
  }

  func testFingerprintFormat() {
    let f = InverterClient.fingerprint(Data("abc".utf8))
    XCTAssertEqual(f.split(separator: ":").count, 32)
    XCTAssertEqual(f, f.uppercased())
  }
}
