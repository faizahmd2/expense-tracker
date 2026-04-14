// Shared/AppConfig.swift
//
// Single place for all configuration that both the main app
// and the Notification Extension need to read.
// Uses App Groups UserDefaults so both targets share the same store.

import Foundation

/// App Group identifier — must match what you set in Xcode Signing & Capabilities.
let APP_GROUP_ID = "group.com.yourname.paisa"  // ← update to your bundle ID

struct AppConfig {

    // MARK: - Shared UserDefaults (App Group)

    static var shared: UserDefaults {
        UserDefaults(suiteName: APP_GROUP_ID)!
    }

    // MARK: - Keys

    private enum Key {
        static let serverURL  = "paisa_server_url"
        static let apiSecret  = "paisa_api_secret"
        static let lastSyncAt = "paisa_last_sync_at"
    }

    // MARK: - Properties

    /// Base URL of the Mac server e.g. "http://macbook.tail1234.ts.net:3000"
    static var serverURL: String {
        get { shared.string(forKey: Key.serverURL) ?? "" }
        set { shared.set(newValue, forKey: Key.serverURL) }
    }

    static var apiSecret: String {
        get { shared.string(forKey: Key.apiSecret) ?? "" }
        set { shared.set(newValue, forKey: Key.apiSecret) }
    }

    static var isConfigured: Bool {
        !serverURL.isEmpty && !apiSecret.isEmpty
    }

    /// Endpoint for parsing a raw notification
    static var parseEndpoint: URL? {
        URL(string: serverURL + "/api/transactions/parse")
    }

    /// Endpoint for sync push
    static var syncEndpoint: URL? {
        URL(string: serverURL + "/api/sync/push")
    }

    /// Health check endpoint (used to test connectivity)
    static var healthEndpoint: URL? {
        URL(string: serverURL + "/health")
    }
}
