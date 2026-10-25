// swift-tools-version:5.9
import PackageDescription

// Lecture locale des onduleurs SMA (WebConnect) : connexion SRP « YAP », mesures, épinglage du certificat.
// Partagé par l'app « ConsoElec Widget » et son extension WidgetKit.
let package = Package(
  name: "SmaKit",
  platforms: [.macOS(.v14)],
  products: [.library(name: "SmaKit", targets: ["SmaKit"])],
  dependencies: [.package(url: "https://github.com/attaswift/BigInt.git", from: "5.4.0")],
  targets: [
    .target(name: "SmaKit", dependencies: ["BigInt"]),
    // Vérification des vecteurs croisés sans XCTest (utilisable avec les seuls Command Line Tools).
    .executableTarget(name: "smakit-check", dependencies: ["SmaKit"]),
    // Les tests XCTest (Tests/SmaKitTests) sont exécutés par le projet Xcode du widget.
  ]
)
