@testable import SmaKit
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

  func testMeasurementsAcrossSeveralDevices() throws {
    let json: [String: Any] = [
      "result": [
        "0199-xxxxx385": ["6100_40263F00": ["1": [["val": NSNull()]]], "6400_00260100": ["1": [["val": NSNull()]]]],
        "017A-xxxxx00D": [
          "6100_40263F00": ["1": [["val": 762]]],
          "6400_00260100": ["1": [["val": 32_081_733]]],
          "6400_00262200": ["1": [["val": 457]]],
        ],
      ],
    ]
    let m = try Parsing.measurements(json)
    XCTAssertEqual(m.powerW, 762)
    XCTAssertEqual(m.totalWh, 32_081_733)
    XCTAssertEqual(m.dayWh, 457)
  }

  func testFingerprintFormat() {
    let f = InverterClient.fingerprint(Data("abc".utf8))
    XCTAssertEqual(f.split(separator: ":").count, 32)
    XCTAssertEqual(f, f.uppercased())
  }

  func testP1ReadingAddsPeakAndOffPeakIndices() throws {
    let json = #"{"total_power_import_t1_kwh": 1234.5, "total_power_import_t2_kwh": 2000.25, "total_power_export_t1_kwh": 3000, "total_power_export_t2_kwh": 500.5, "active_power_w": -812, "active_power_average_w": 120}"#
    let r = try MeterReading.parse(Data(json.utf8), at: Date(timeIntervalSince1970: 0))
    XCTAssertEqual(r.importKwh, 3234.75)
    XCTAssertEqual(r.exportKwh, 3500.5)
    XCTAssertEqual(r.powerW, -812)
    XCTAssertEqual(r.quarterHourAvgW, 120)
    XCTAssertThrowsError(try MeterReading.parse(Data(#"{"active_power_w": 10}"#.utf8), at: Date()))
  }

  func testMeterAverageOverLastMinutes() {
    let t0 = Date(timeIntervalSince1970: 1_000_000)
    let at = { (minutes: Double) in t0.addingTimeInterval(minutes * 60) }
    var history = MeterHistory()
    history.add(MeterReading(at: at(0), importKwh: 100, exportKwh: 200))
    history.add(MeterReading(at: at(3), importKwh: 100.03, exportKwh: 200))
    XCTAssertNil(history.average(), "moins de 5 minutes de lectures")
    // De 0 à 5 min : 0,05 kWh soutirés = 600 W, 0,1 kWh injectés = 1 200 W.
    history.add(MeterReading(at: at(5), importKwh: 100.05, exportKwh: 200.1))
    XCTAssertEqual(history.average(), MeterAverage(importW: 600, exportW: 1200, from: at(0), to: at(5)))
    // La lecture la plus récente d'au moins 5 min est prise : de 3 à 8 min.
    history.add(MeterReading(at: at(8), importKwh: 100.08, exportKwh: 200.1))
    XCTAssertEqual(history.average()?.from, at(3))
    XCTAssertEqual(history.average()?.minutes, 5)
    XCTAssertEqual(history.average()?.importW, 600)
  }

  func testMeterAverageNeedsAReadingAtMost30MinutesOld() {
    let t0 = Date(timeIntervalSince1970: 1_000_000)
    var history = MeterHistory()
    history.add(MeterReading(at: t0, importKwh: 100, exportKwh: 200))
    history.add(MeterReading(at: t0.addingTimeInterval(31 * 60), importKwh: 101, exportKwh: 200))
    XCTAssertNil(history.average())
    // Au-delà d'une heure, les lectures sont oubliées.
    history.add(MeterReading(at: t0.addingTimeInterval(61 * 60), importKwh: 102, exportKwh: 200))
    XCTAssertEqual(history.readings.count, 2)
  }
}
