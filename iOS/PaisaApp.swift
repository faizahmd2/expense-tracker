// PaisaApp/PaisaApp.swift
//
// App entry point.
// On every foreground transition: flush any offline queue to Mac.

import SwiftUI

@main
struct PaisaApp: App {

    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active {
                // Flush notification extension's offline queue to Mac
                OfflineQueue.flush { success in
                    if success {
                        print("[paisa] Offline queue flushed.")
                    }
                }
            }
        }
    }
}
