import SmaKit
import SwiftUI

/// Vue du widget « Compteur électrique », partagée avec l'app de réglage (aperçu) : soutirage et injection moyens.
struct MeterView: View {
  let outcome: MeterReader.Outcome
  let compact: Bool

  #if os(macOS)
  static let setupHint = "Ouvrez l'app ConsoElec Widget pour indiquer l'adresse du lecteur P1."
  #else
  static let setupHint = "Ouvrez l'app ConsoElec pour indiquer l'adresse du lecteur P1."
  #endif

  var body: some View {
    VStack(alignment: .leading, spacing: compact ? 4 : 6) {
      HStack(spacing: 6) {
        Image(systemName: "bolt.fill").foregroundStyle(.yellow)
        Text("Compteur").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        Spacer(minLength: 0)
        if !outcome.live && outcome.reading != nil {
          Image(systemName: "wifi.slash").font(.caption2).foregroundStyle(.secondary)
        }
      }
      if let reading = outcome.reading {
        if let average = outcome.average {
          row("Soutirage", icon: "arrow.down", watts: average.importW, color: .orange)
          row("Injection", icon: "arrow.up", watts: average.exportW, color: .green)
          Spacer(minLength: 0)
          if !compact { instantRow(reading) }
          HStack(spacing: 4) {
            Text("moyenne sur \(average.minutes) min")
            Spacer(minLength: 0)
            Text(average.to, style: .time)
          }
          .font(.caption2).foregroundStyle(.secondary)
        } else {
          let w = reading.powerW ?? 0
          row(w < 0 ? "Injection" : "Soutirage", icon: w < 0 ? "arrow.up" : "arrow.down", watts: abs(w), color: w < 0 ? .green : .orange)
          Spacer(minLength: 0)
          Text(outcome.error ?? "Instantané · moyenne à la prochaine lecture")
            .font(.caption2).foregroundStyle(.secondary)
          Text(reading.at, style: .time).font(.caption2).foregroundStyle(.secondary)
        }
      } else {
        Spacer(minLength: 0)
        Text(outcome.error ?? Self.setupHint)
          .font(.caption).foregroundStyle(.secondary)
        Spacer(minLength: 0)
      }
    }
    .padding(compact ? 12 : 14)
  }

  private func row(_ label: String, icon: String, watts: Double, color: Color) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 4) {
      Image(systemName: icon).font(.caption.weight(.bold)).foregroundStyle(color)
      Text(label).font(.callout.weight(.medium))
      Spacer(minLength: 4)
      Text(Format.power(watts)).font(.system(size: compact ? 22 : 26, weight: .bold, design: .rounded))
        .minimumScaleFactor(0.6).lineLimit(1)
      Text(Format.powerUnit(watts)).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
    }
  }

  /// Format moyen : puissance instantanée et moyenne du quart d'heure du compteur.
  private func instantRow(_ reading: MeterReading) -> some View {
    HStack(spacing: 12) {
      if let w = reading.powerW {
        Text("Instantané \(w < 0 ? "−" : "")\(Format.power(abs(w))) \(Format.powerUnit(abs(w)))")
      }
      if let q = reading.quarterHourAvgW {
        Text("Quart d'heure \(Format.power(q)) \(Format.powerUnit(q))")
      }
    }
    .font(.caption).foregroundStyle(.secondary)
    .lineLimit(1).minimumScaleFactor(0.8)
  }
}
