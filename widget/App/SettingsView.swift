import SmaKit
import SwiftUI
import WidgetKit

struct SettingsView: View {
  @StateObject private var discovery = InverterDiscovery()
  @State private var host = WidgetConfig.store.host
  @State private var keyDraft = ""
  @State private var hasKey = InverterKeychain.read(accessGroup: WidgetConfig.keychainGroup) != nil
  @State private var testing = false
  @State private var outcome: ProductionReader.Outcome?
  @State private var message: String?
  @State private var fingerprint = WidgetConfig.store.pinnedFingerprint

  var body: some View {
    Form {
      Section {
        Text("Le widget lit votre onduleur SMA sur le réseau local (connexion sécurisée SRP) et affiche la production. macOS le rafraîchit environ toutes les 5 à 15 minutes.")
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
              if let first = found.first {
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
        Text("La clé est rangée dans le Trousseau macOS, partagée seulement avec le widget.")
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
      if let outcome {
        Section("Aperçu") {
          HStack(spacing: 16) {
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
        Text("Clic droit sur le bureau → Modifier les widgets → ConsoElec, puis glissez le widget à l'endroit voulu.")
          .font(.callout)
      }
    }
    .formStyle(.grouped)
    .padding()
  }

  private func saveHost() {
    let trimmed = host.trimmingCharacters(in: .whitespaces)
    let store = WidgetConfig.store
    if trimmed != store.host {
      store.host = trimmed
      store.pinnedFingerprint = nil
      fingerprint = nil
    }
    WidgetCenter.shared.reloadAllTimelines()
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
