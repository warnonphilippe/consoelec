import SmaKit
import SwiftUI
import WidgetKit

struct ProductionEntry: TimelineEntry {
  let date: Date
  let snapshot: Snapshot?
  let curve: DayCurve
  let error: String?
  let live: Bool
}

struct Provider: TimelineProvider {
  func placeholder(in context: Context) -> ProductionEntry {
    ProductionEntry(
      date: Date(),
      snapshot: Snapshot(measurements: Measurements(powerW: 2450, dayWh: 15700, totalWh: 32_070_000), at: Date()),
      curve: DayCurve(), error: nil, live: true)
  }

  func getSnapshot(in context: Context, completion: @escaping (ProductionEntry) -> Void) {
    let store = WidgetConfig.store
    if context.isPreview || store.last == nil {
      completion(store.last == nil ? placeholder(in: context) : entry(store: store))
    } else {
      completion(entry(store: store))
    }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<ProductionEntry>) -> Void) {
    Task {
      let outcome = await ProductionReader.refresh(store: WidgetConfig.store, keychainGroup: WidgetConfig.keychainGroup)
      let entry = ProductionEntry(date: Date(), snapshot: outcome.snapshot, curve: outcome.curve, error: outcome.error, live: outcome.live)
      // Le système décide du rythme réel (macOS : 5 à 15 min) ; on demande 5 minutes.
      completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(5 * 60))))
    }
  }

  private func entry(store: SharedStore) -> ProductionEntry {
    ProductionEntry(date: Date(), snapshot: store.last, curve: store.curve, error: nil, live: false)
  }
}

struct ProductionWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: ProductionEntry

  var body: some View {
    switch family {
    default:
      ProductionView(snapshot: entry.snapshot, curve: entry.curve, error: entry.error, live: entry.live, compact: family == .systemSmall)
        .containerBackground(.fill.tertiary, for: .widget)
    }
  }
}

@main
struct ConsoElecWidgets: WidgetBundle {
  var body: some Widget {
    ProductionWidget()
    MeterWidget()
  }
}

struct ProductionWidget: Widget {
  static let families: [WidgetFamily] = [.systemSmall, .systemMedium]

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "ConsoElecProduction", provider: Provider()) { entry in
      ProductionWidgetView(entry: entry)
    }
    .configurationDisplayName("Production solaire")
    .description("Puissance de vos panneaux et production du jour, lues sur l'onduleur.")
    .supportedFamilies(Self.families)
    .contentMarginsDisabled()
  }
}
