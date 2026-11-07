import SmaKit
import SwiftUI
import WidgetKit

struct SettingsView: View {
  @StateObject private var discovery = BonjourDiscovery.inverters()
  @StateObject private var p1Discovery = BonjourDiscovery.p1Meters()
  @State private var p1Host = WidgetConfig.store.p1Host
  @State private var meterTesting = false
  @State private var meterOutcome: MeterReader.Outcome?
  @State private var meterMessage: String?
  @State private var host = WidgetConfig.store.host
  @State private var keyDraft = ""
  @State private var hasKey = InverterKeychain.read(accessGroup: WidgetConfig.keychainGroup) != nil
  @State private var testing = false
  @State private var outcome: ProductionReader.Outcome?
  @State private var message: String?
  @State private var fingerprint = WidgetConfig.store.pinnedFingerprint
  @Environment(\.scenePhase) private var scenePhase

  private let intro = "Le widget « Production solaire » lit votre onduleur SMA sur le réseau local (connexion sécurisée SRP) ; le widget « Compteur électrique » lit le compteur par le lecteur HomeWizard P1. macOS les rafraîchit environ toutes les 5 à 15 minutes."
  private let keychainNote = "La clé est rangée dans le Trousseau macOS, partagée seulement avec le widget."
  private let addWidget = "Clic droit sur le bureau → Modifier les widgets → ConsoElec, puis glissez le widget à l'endroit voulu."
  private let previews = AnyLayout(HStackLayout(spacing: 16))

  var body: some View {
    Form {
      Section {
        Text(intro)
          .font(.callout).foregroundStyle(.secondary)
      }
      Section("Onduleur") {
        HStack {
          TextField("Adresse (SMA + numéro de série + .local)", text: $host)
            .textFieldStyle(.roundedBorder)
            .onSubmit(saveHost)
          Button(discovery.searching ? "Recherche…" : "Rechercher") {
            Task {
              let found = await discovery.search()
              let serial = DeviceNames.smaSerial(host)
              if let first = found.first(where: { serial != nil && DeviceNames.smaSerial($0) == serial }) ?? found.first {
                host = first
                saveHost()
              } else {
                message = "Aucun onduleur SMA trouvé sur le réseau."
              }
            }
          }
          .disabled(discovery.searching)
        }
        HStack {
          SecureField(hasKey ? "Clé enregistrée — saisir pour remplacer" : "Clé WPA2-PSK de la plaque (16 caractères)", text: $keyDraft)
            .textFieldStyle(.roundedBorder)
            .onSubmit(saveKey)
          Button("Enregistrer", action: saveKey).disabled(keyDraft.isEmpty)
        }
        Text(keychainNote)
          .font(.caption).foregroundStyle(.secondary)
        HStack {
          Button(testing ? "Lecture…" : "Tester la lecture") { Task { await test() } }
            .disabled(testing || host.isEmpty || !hasKey)
          if fingerprint != nil {
            Button("Oublier le certificat épinglé") {
              WidgetConfig.store.pinnedFingerprint = nil
              fingerprint = nil
            }
          }
        }
        if let message {
          Text(message).font(.callout)
        }
      }
      Section("Compteur (port P1)") {
        HStack {
          TextField("Adresse du lecteur (p1meter-XXXXXX.local ou IP)", text: $p1Host)
            .textFieldStyle(.roundedBorder)
            .onSubmit(saveP1Host)
          Button(p1Discovery.searching ? "Recherche…" : "Rechercher") { Task { await searchP1() } }
            .disabled(p1Discovery.searching)
        }
        Text("Activez l'API locale du lecteur dans l'application HomeWizard Energy. Le widget affiche le soutirage et l'injection moyens depuis la lecture précédente (au moins 5 minutes) ; tant que cette app est ouverte, il lit le compteur chaque minute.")
          .font(.caption).foregroundStyle(.secondary)
        Button(meterTesting ? "Lecture…" : "Tester la lecture") { Task { await testMeter() } }
          .disabled(meterTesting || p1Host.isEmpty)
        if let meterMessage {
          Text(meterMessage).font(.callout)
        }
      }
      if let meterOutcome {
        Section("Aperçu du compteur") {
          previews {
            MeterView(outcome: meterOutcome, compact: true)
              .frame(width: 170, height: 170)
              .background(.quaternary, in: RoundedRectangle(cornerRadius: 20))
            MeterView(outcome: meterOutcome, compact: false)
              .frame(width: 330, height: 170)
              .background(.quaternary, in: RoundedRectangle(cornerRadius: 20))
          }
        }
      }
      if let outcome {
        Section("Aperçu") {
          previews {
            ProductionView(snapshot: outcome.snapshot, curve: outcome.curve, error: outcome.error, live: outcome.live, compact: true)
              .frame(width: 170, height: 170)
              .background(.quaternary, in: RoundedRectangle(cornerRadius: 20))
            ProductionView(snapshot: outcome.snapshot, curve: outcome.curve, error: outcome.error, live: outcome.live, compact: false)
              .frame(width: 330, height: 170)
              .background(.quaternary, in: RoundedRectangle(cornerRadius: 20))
          }
        }
      }
      Section("Ajouter le widget") {
        Text(addWidget)
          .font(.callout)
      }
    }
    .formStyle(.grouped)
    .padding()
    // Tant que l'app est au premier plan, lecture à l'ouverture puis chaque minute.
    // Adresse du lecteur P1 cherchée d'office tant qu'elle est vide.
    .task {
      if p1Host.isEmpty { await searchP1(quiet: true) }
    }
    .task(id: scenePhase) {
      while scenePhase == .active && !Task.isCancelled {
        if hasKey && !host.isEmpty && !testing { await test() }
        if !p1Host.isEmpty && !meterTesting { await testMeter() }
        try? await Task.sleep(for: .seconds(60))
      }
    }
  }

  private func saveHost() {
    let trimmed = host.trimmingCharacters(in: .whitespaces)
    let store = WidgetConfig.store
    if trimmed != store.host {
      // Même onduleur sous un autre nom (suffixe `-N`) : l'empreinte épinglée reste valable.
      let sameDevice = DeviceNames.smaSerial(trimmed).map { $0 == DeviceNames.smaSerial(store.host) } ?? false
      store.host = trimmed
      if !sameDevice {
        store.pinnedFingerprint = nil
        fingerprint = nil
      }
    }
    WidgetCenter.shared.reloadAllTimelines()
  }

  private func saveP1Host() {
    let trimmed = p1Host.trimmingCharacters(in: .whitespacesAndNewlines)
    let store = WidgetConfig.store
    if trimmed != store.p1Host {
      store.p1Host = trimmed
      store.meterHistory = MeterHistory()
    }
    WidgetCenter.shared.reloadAllTimelines()
  }

  private func searchP1(quiet: Bool = false) async {
    let found = await p1Discovery.search()
    if let first = found.first {
      p1Host = first
      saveP1Host()
      await testMeter()
    } else if !quiet {
      meterMessage = "Aucun lecteur P1 HomeWizard trouvé sur le réseau."
    }
  }

  private func testMeter() async {
    saveP1Host()
    meterTesting = true
    defer { meterTesting = false }
    let result = await MeterReader.refresh(store: WidgetConfig.store)
    meterOutcome = result
    meterMessage = result.error ?? "Lecture réussie."
    WidgetCenter.shared.reloadTimelines(ofKind: "ConsoElecMeter")
  }

  private func saveKey() {
    let value = keyDraft.replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "-", with: "")
    guard !value.isEmpty else { return }
    if InverterKeychain.save(value, accessGroup: WidgetConfig.keychainGroup) {
      keyDraft = ""
      hasKey = true
      message = "Clé enregistrée dans le Trousseau."
      WidgetCenter.shared.reloadAllTimelines()
    } else {
      message = "Impossible d'enregistrer la clé dans le Trousseau."
    }
  }

  private func test() async {
    saveHost()
    testing = true
    defer { testing = false }
    let result = await ProductionReader.refresh(store: WidgetConfig.store, keychainGroup: WidgetConfig.keychainGroup)
    outcome = result
    fingerprint = WidgetConfig.store.pinnedFingerprint
    message = result.error ?? "Lecture réussie."
    WidgetCenter.shared.reloadAllTimelines()
  }
}
