import Foundation
import SmaKit

/// Identifiants partagés avec le widget, calculés à la compilation à partir de l'équipe de signature.
enum WidgetConfig {
  static var appGroup: String? { Bundle.main.object(forInfoDictionaryKey: "ConsoElecAppGroup") as? String }
  static var keychainGroup: String? { Bundle.main.object(forInfoDictionaryKey: "ConsoElecKeychainGroup") as? String }
  static var store: SharedStore { SharedStore(appGroup: appGroup) }
}
