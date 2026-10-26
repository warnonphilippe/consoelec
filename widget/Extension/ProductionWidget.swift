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
      // Le système décide du rythme réel (macOS : 5 à 15 min, iOS : environ un quart d'heure) ; on demande 5 minutes.
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
    #if os(iOS)
    case .accessoryInline:
      Label(entry.snapshot.map { "\(Format.power($0.measurements.powerW)) \(Format.powerUnit($0.measurements.powerW)) · \(Format.kwh($0.measurements.dayWh))" } ?? "Production —",
            systemImage: "sun.max.fill")
        .containerBackground(.clear, for: .widget)
    case .accessoryCircular:
      AccessoryCircularView(snapshot: entry.snapshot)
        .containerBackground(.clear, for: .widget)
    case .accessoryRectangular:
      AccessoryRectangularView(snapshot: entry.snapshot, live: entry.live)
        .containerBackground(.clear, for: .widget)
    #endif
    default:
      ProductionView(snapshot: entry.snapshot, curve: entry.curve, error: entry.error, live: entry.live, compact: family == .systemSmall)
        .containerBackground(.fill.tertiary, for: .widget)
    }
  }
}

#if os(iOS)
/// Écran verrouillé, format rond : puissance instantanée.
struct AccessoryCircularView: View {
  let snapshot: Snapshot?

  var body: some View {
    let power = snapshot?.measurements.powerW
    ZStack {
      AccessoryWidgetBackground()
      VStack(spacing: 0) {
        Image(systemName: power ?? 0 > 0 ? "sun.max.fill" : "moon.stars.fill").font(.caption2)
        Text(snapshot == nil ? "—" : Format.power(power)).font(.system(.body, design: .rounded).weight(.bold))
          .minimumScaleFactor(0.5).lineLimit(1)
        Text(Format.powerUnit(power)).font(.system(size: 9, weight: .semibold))
      }
      .padding(4)
    }
  }
}

/// Écran verrouillé, format rectangulaire : puissance, production du jour et heure de la lecture.
struct AccessoryRectangularView: View {
  let snapshot: Snapshot?
  let live: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Label("Production", systemImage: live ? "sun.max.fill" : "wifi.slash")
        .font(.caption2.weight(.semibold))
      if let snapshot {
        Text("\(Format.power(snapshot.measurements.powerW)) \(Format.powerUnit(snapshot.measurements.powerW))")
          .font(.system(.title3, design: .rounded).weight(.bold))
        HStack(spacing: 4) {
          Text("Auj. \(Format.kwh(snapshot.measurements.dayWh))")
          Text(snapshot.at, style: .time).foregroundStyle(.secondary)
        }
        .font(.caption2)
      } else {
        Text("Ouvrez ConsoElec").font(.caption)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
#endif

@main
struct ProductionWidget: Widget {
  #if os(iOS)
  static let families: [WidgetFamily] = [.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline]
  #else
  static let families: [WidgetFamily] = [.systemSmall, .systemMedium]
  #endif

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
