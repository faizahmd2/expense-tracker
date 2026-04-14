// NotificationExtension/NotificationService.swift
//
// Notification Service Extension — runs in background when a notification
// arrives, BEFORE it is shown on screen.
//
// What it does:
//   1. Receives raw notification body from any watched app
//   2. POSTs it to the Mac backend for parsing
//   3. If offline, queues it locally
//   4. Modifies the displayed notification with parsed info
//
// This is the entire business logic of the iOS native layer.
// The rest of the app is just a WKWebView.

import UserNotifications

// ── Bundle IDs of apps whose notifications we want to intercept ───────────────
// These must also be declared in the extension's Info.plist under
// NSExtension → NSExtensionAttributes → UNNotificationExtensionCategory
// For generic interception (all notifications), leave this open
// and filter by content instead.

private let WATCHED_KEYWORDS: [String] = [
    // Bank debit/credit signals — catches any bank notification
    "debited", "credited", "deducted", "withdrawn",
    "Rs.", "INR", "₹",
    // UPI apps
    "paid", "received", "sent to", "payment",
    // Specific bank names as fallback
    "HDFC", "ICICI", "SBI", "Axis", "Kotak", "IDFC",
    "PhonePe", "Google Pay", "Paytm", "GPay",
]

class NotificationService: UNNotificationServiceExtension {

    // The content handler iOS gave us — we must call it before the deadline
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?

    // MARK: - Extension lifecycle

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler      = contentHandler
        self.bestAttemptContent  = (request.content.mutableCopy() as? UNMutableNotificationContent)

        guard let content = bestAttemptContent else {
            contentHandler(request.content)
            return
        }

        let body = content.body

        // Only process if it looks like a financial notification
        guard isFinancialNotification(body) else {
            contentHandler(content)
            return
        }

        // Try to send to Mac backend
        sendToBackend(rawText: body, bundleId: request.content.categoryIdentifier) { result in
            if let result = result {
                // Backend parsed it — update the notification display
                content.title    = result.displayTitle
                content.body     = result.displayBody
                content.subtitle = result.displaySubtitle
            }
            // Whether parsing succeeded or not, always show the notification
            contentHandler(content)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        // iOS is about to kill us — show whatever we have
        if let contentHandler = contentHandler, let content = bestAttemptContent {
            contentHandler(content)
        }
    }

    // MARK: - Financial notification filter

    private func isFinancialNotification(_ text: String) -> Bool {
        let lower = text.lowercased()
        return WATCHED_KEYWORDS.contains { lower.contains($0.lowercased()) }
    }

    // MARK: - Backend communication

    private struct ParseResult {
        let displayTitle:    String
        let displayBody:     String
        let displaySubtitle: String
        let transactionId:   String?
    }

    private func sendToBackend(
        rawText: String,
        bundleId: String,
        completion: @escaping (ParseResult?) -> Void
    ) {
        guard let endpoint = AppConfig.parseEndpoint else {
            queueForLater(rawText: rawText)
            completion(nil)
            return
        }

        let body: [String: Any] = [
            "raw_notification": rawText,
            "received_at":      ISO8601DateFormatter().string(from: Date()),
            "source_app":       bundleId,
        ]

        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else {
            completion(nil)
            return
        }

        var request        = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json",           forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(AppConfig.apiSecret)", forHTTPHeaderField: "Authorization")
        request.httpBody   = jsonData
        request.timeoutInterval = 8  // extension must finish quickly

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard error == nil,
                  let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 201,
                  let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let txnData = json["data"] as? [String: Any]
            else {
                // Server unreachable — queue for later
                self?.queueForLater(rawText: rawText)
                completion(nil)
                return
            }

            let result = self?.buildDisplayResult(from: txnData)
            completion(result)
        }.resume()
    }

    // MARK: - Build notification display text

    private func buildDisplayResult(from txn: [String: Any]) -> ParseResult {
        let amount   = txn["amount"]      as? Double ?? 0
        let type     = txn["type"]        as? String ?? "debit"
        let merchant = txn["merchant_raw"] as? String ?? "Unknown"
        let catName  = txn["category_name"] as? String ?? ""
        let catIcon  = txn["category_icon"] as? String ?? "💰"
        let id       = txn["id"]          as? String

        let sign    = type == "credit" ? "+" : "−"
        let amtStr  = formatAmount(amount)
        let typeStr = type == "credit" ? "Received" : "Paid"

        return ParseResult(
            displayTitle:    "\(sign)₹\(amtStr) · \(merchant)",
            displayBody:     "\(catIcon) \(catName.isEmpty ? typeStr : catName)",
            displaySubtitle: "",
            transactionId:   id
        )
    }

    // MARK: - Offline queue

    private func queueForLater(rawText: String) {
        let op = QueuedOp(
            opId:      UUID().uuidString,
            entity:    "transaction",
            entityId:  UUID().uuidString,
            opType:    "INSERT",
            payload:   [
                "raw_notification": rawText,
                "source":           "notification",
                "received_at":      ISO8601DateFormatter().string(from: Date()),
                "needs_review":     "1",
            ],
            changedAt: ISO8601DateFormatter().string(from: Date())
        )
        OfflineQueue.enqueue(op)
    }

    // MARK: - Helpers

    private func formatAmount(_ amount: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle    = .decimal
        formatter.groupingSeparator = ","
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 0
        return formatter.string(from: NSNumber(value: amount)) ?? String(format: "%.0f", amount)
    }
}
