import SmaKit
import SwiftUI

/// Vue du widget, partagée avec l'app de réglage (aperçu).
struct ProductionView: View {
  let snapshot: Snapshot?
  let curve: DayCurve
  let error: String?
  let live: Bool
  let compact: Bool

  private var power: Double? { snapshot?.measurements.powerW }

  #if os(macOS)
  static let setupHint = "Ouvrez l'app ConsoElec Widget pour configurer l'onduleur."
  #else
  static let setupHint = "Ouvrez l'app ConsoElec pour configurer l'onduleur."
  #endif

  var body: some View {
    VStack(alignment: .leading, spacing: compact ? 4 : 6) {
      HStack(spacing: 6) {
        Image(systemName: power ?? 0 > 0 ? "sun.max.fill" : "moon.stars.fill")
          .foregroundStyle(power ?? 0 > 0 ? .orange : .secondary)
        Text("Production").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        Spacer(minLength: 0)
        if !live && snapshot != nil {
          Image(systemName: "wifi.slash").font(.caption2).foregroundStyle(.secondary)
        }
      }
      if let snapshot {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
          Text(Format.power(power)).font(.system(size: compact ? 30 : 34, weight: .bold, design: .rounded))
            .minimumScaleFactor(0.6).lineLimit(1)
          Text(Format.powerUnit(power)).font(.callout.weight(.semibold)).foregroundStyle(.secondary)
        }
        Text("Aujourd'hui \(Format.kwh(snapshot.measurements.dayWh))")
          .font(.callout.weight(.medium))
        if !compact {
          Sparkline(curve: curve).frame(maxHeight: .infinity)
          HStack {
            Text("Total \(Format.kwhInt(snapshot.measurements.totalWh))")
            Spacer()
            Text(snapshot.at, style: .time)
          }
          .font(.caption2).foregroundStyle(.secondary)
        } else {
          Spacer(minLength: 0)
          Text(snapshot.at, style: .time).font(.caption2).foregroundStyle(.secondary)
        }
      } else {
        Spacer(minLength: 0)
        Text(error ?? Self.setupHint)
          .font(.caption).foregroundStyle(.secondary)
        Spacer(minLength: 0)
      }
    }
    .padding(compact ? 12 : 14)
  }
}

struct Sparkline: View {
  let curve: DayCurve

  var body: some View {
    GeometryReader { geo in
      let points = curve.points
      let peak = max(curve.peakW, 1)
      if points.count >= 2, let first = points.first?.at, let last = points.last?.at, last > first {
        let span = last.timeIntervalSince(first)
        let path = Path { p in
          for (i, point) in points.enumerated() {
            let x = geo.size.width * point.at.timeIntervalSince(first) / span
            let y = geo.size.height * (1 - point.powerW / peak)
            if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
          }
        }
        path.stroke(.orange, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
      } else {
        Text("La courbe du jour apparaîtra au fil des lectures.")
          .font(.caption2).foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
      }
    }
  }
}

enum Format {
  static let locale = Locale(identifier: "fr_BE")

  static func power(_ w: Double?) -> String {
    guard let w, w > 0 else { return "0" }
    return w >= 1000 ? (w / 1000).formatted(.number.precision(.fractionLength(2)).locale(locale)) : w.formatted(.number.precision(.fractionLength(0)).locale(locale))
  }

  static func powerUnit(_ w: Double?) -> String { (w ?? 0) >= 1000 ? "kW" : "W" }

  static func kwh(_ wh: Double?) -> String {
    ((wh ?? 0) / 1000).formatted(.number.precision(.fractionLength(1)).locale(locale)) + " kWh"
  }

  static func kwhInt(_ wh: Double?) -> String {
    ((wh ?? 0) / 1000).formatted(.number.precision(.fractionLength(0)).locale(locale)) + " kWh"
  }
}
