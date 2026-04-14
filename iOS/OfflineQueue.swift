// Shared/OfflineQueue.swift
//
// Persists notification payloads when the Mac server is unreachable.
// Uses a simple JSON file in the App Group container —
// no SQLite dependency needed in the extension (keeps it lightweight).
// Flushed to Mac on next successful connection.

import Foundation

struct QueuedOp: Codable {
    let opId:       String
    let entity:     String       // always "transaction"
    let entityId:   String
    let opType:     String       // "INSERT"
    let payload:    [String: String]
    let changedAt:  String
}

struct OfflineQueue {

    // MARK: - Storage

    private static var queueURL: URL {
        let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: APP_GROUP_ID)!
        return container.appendingPathComponent("offline_queue.json")
    }

    // MARK: - Read / write

    static func load() -> [QueuedOp] {
        guard let data = try? Data(contentsOf: queueURL),
              let ops  = try? JSONDecoder().decode([QueuedOp].self, from: data)
        else { return [] }
        return ops
    }

    static func save(_ ops: [QueuedOp]) {
        guard let data = try? JSONEncoder().encode(ops) else { return }
        try? data.write(to: queueURL, options: .atomic)
    }

    static func enqueue(_ op: QueuedOp) {
        var ops = load()
        ops.append(op)
        save(ops)
    }

    static func clear() {
        save([])
    }

    static var count: Int { load().count }

    // MARK: - Flush to server

    /// Sends all queued ops to the Mac server.
    /// Call this when the app comes to foreground and is online.
    static func flush(completion: @escaping (Bool) -> Void) {
        let ops = load()
        guard !ops.isEmpty, let endpoint = AppConfig.syncEndpoint else {
            completion(true)
            return
        }

        let body: [String: Any] = [
            "last_synced_at": UserDefaults(suiteName: APP_GROUP_ID)?
                .string(forKey: "paisa_last_sync_at") ?? "1970-01-01T00:00:00.000Z",
            "ops": ops.map { op in
                [
                    "op_id":     op.opId,
                    "entity":    op.entity,
                    "entity_id": op.entityId,
                    "op_type":   op.opType,
                    "payload":   op.payload,
                    "changed_at": op.changedAt,
                ]
            }
        ]

        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else {
            completion(false)
            return
        }

        var request        = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(AppConfig.apiSecret)", forHTTPHeaderField: "Authorization")
        request.httpBody   = jsonData
        request.timeoutInterval = 10

        URLSession.shared.dataTask(with: request) { data, response, error in
            guard error == nil,
                  let http = response as? HTTPURLResponse,
                  http.statusCode == 200
            else {
                completion(false)
                return
            }

            // Update last synced timestamp
            if let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let serverTime = json["server_time"] as? String {
                UserDefaults(suiteName: APP_GROUP_ID)?.set(serverTime, forKey: "paisa_last_sync_at")
            }

            clear()
            completion(true)
        }.resume()
    }
}
