import SmaKit
import SwiftUI
import WidgetKit

struct MeterEntry: TimelineEntry {
  let date: Date
  let outcome: MeterReader.Outcome
}

struct MeterProvider: TimelineProvider {
  func placeholder(in context: Context) -> MeterEntry {
    let now = Date()
    let from = MeterReading(at: now.addingTimeInterval(-300), importKwh: 1000, exportKwh: 2000, powerW: 420)
    let to = MeterReading(at: now, importKwh: 1000.035, exportKwh: 2000, powerW: 420, quarterHourAvgW: 390)
    var history = MeterHistory()
    history.add(from)
    history.add(to)
    return MeterEntry(date: now, outcome: .init(reading: to, average: history.average(), error: nil, live: true))
  }

  func getSnapshot(in context: Context, completion: @escaping (MeterEntry) -> Void) {
    let cached = MeterReader.cached(store: WidgetConfig.store)
    completion(context.isPreview && cached.reading == nil ? placeholder(in: context) : MeterEntry(date: Date(), outcome: cached))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<MeterEntry>) -> Void) {
    Task {
      let outcome = await MeterReader.refresh(store: WidgetConfig.store)
      // Le système décide du rythme réel (macOS : 5 à 15 min) ; la moyenne couvre le temps écoulé depuis la lecture
      // précédente, au moins 5 minutes.
      completion(Timeline(entries: [MeterEntry(date: Date(), outcome: outcome)], policy: .after(Date().addingTimeInterval(5 * 60))))
    }
  }
}

struct MeterWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "ConsoElecMeter", provider: MeterProvider()) { entry in
      MeterWidgetView(entry: entry)
    }
    .configurationDisplayName("Compteur électrique")
    .description("Soutirage et injection moyens des dernières minutes, lus sur le compteur (port P1).")
    .supportedFamilies([.systemSmall, .systemMedium])
    .contentMarginsDisabled()
  }
}

/// Le petit format n'affiche pas la ligne « instantané / quart d'heure ».
struct MeterWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: MeterEntry

  var body: some View {
    MeterView(outcome: entry.outcome, compact: family == .systemSmall)
      .containerBackground(.fill.tertiary, for: .widget)
  }
}
