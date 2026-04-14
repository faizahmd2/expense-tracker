// PaisaApp/ContentView.swift
//
// The entire main app UI is a WKWebView loading the PWA from the Mac server.
// On first launch it shows a setup screen to capture server URL + API secret.
// Once configured, it goes straight to the PWA.
//
// When the app comes to foreground it flushes any offline queue to the server.

import SwiftUI
import WebKit

struct ContentView: View {
    @State private var isConfigured = AppConfig.isConfigured
    @State private var showSetup    = false

    var body: some View {
        Group {
            if isConfigured {
                PaisaWebView()
                    .ignoresSafeArea()
                    .onAppear {
                        // Flush any offline ops queued by the notification extension
                        OfflineQueue.flush { _ in }
                    }
            } else {
                SetupView {
                    isConfigured = true
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

// ── PWA WebView ───────────────────────────────────────────────────────────────

struct PaisaWebView: UIViewRepresentable {

    func makeUIView(context: Context) -> WKWebView {
        let config                          = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback    = true
        config.mediaTypesRequiringUserActionForPlayback = []

        // Allow localStorage / IndexedDB (needed for offline queue)
        let prefs                           = WKWebpagePreferences()
        prefs.allowsContentJavaScript       = true
        config.defaultWebpagePreferences    = prefs

        let webView                         = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque                    = false
        webView.backgroundColor             = UIColor(red: 0.04, green: 0.04, blue: 0.04, alpha: 1)
        webView.scrollView.backgroundColor  = webView.backgroundColor
        webView.navigationDelegate          = context.coordinator

        loadApp(in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    private func loadApp(in webView: WKWebView) {
        guard let url = URL(string: AppConfig.serverURL) else { return }
        var request     = URLRequest(url: url)
        // Pre-set the API secret as a cookie so the PWA picks it up automatically
        // (saves the user from having to type it in the browser)
        if let cookieHeader = makeCookieHeader() {
            request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        }
        webView.load(request)
    }

    private func makeCookieHeader() -> String? {
        let secret = AppConfig.apiSecret
        guard !secret.isEmpty else { return nil }
        // PWA reads this from document.cookie on first boot to pre-fill the secret
        return "paisa_secret=\(secret); Path=/"
    }

    // ── Coordinator ───────────────────────────────────────────────────────────

    class Coordinator: NSObject, WKNavigationDelegate {

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            showOfflineOverlay(in: webView)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            showOfflineOverlay(in: webView)
        }

        private func showOfflineOverlay(in webView: WKWebView) {
            // Inject minimal offline message if server is unreachable
            let js = """
                document.body.innerHTML = `
                  <div style="display:flex;flex-direction:column;align-items:center;
                              justify-content:center;height:100vh;background:#0a0a0a;
                              color:#888;font-family:system-ui;text-align:center;gap:12px;">
                    <div style="font-size:2rem;">📡</div>
                    <div style="font-size:1rem;font-weight:700;color:#f0ede8;">Mac server unreachable</div>
                    <div style="font-size:0.85rem;max-width:260px;line-height:1.5;">
                      Make sure your MacBook is on and Tailscale is connected.
                    </div>
                    <button onclick="window.location.reload()"
                            style="margin-top:12px;padding:12px 24px;border-radius:100px;
                                   background:#c8f04a;color:#0a0a0a;border:none;
                                   font-size:0.9rem;font-weight:700;">
                      Retry
                    </button>
                  </div>`;
            """
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}

// ── Setup screen ─────────────────────────────────────────────────────────────

struct SetupView: View {
    @State private var serverURL = ""
    @State private var apiSecret = ""
    @State private var isChecking = false
    @State private var errorMsg: String? = nil

    var onComplete: () -> Void

    var body: some View {
        ZStack {
            Color(red: 0.04, green: 0.04, blue: 0.04).ignoresSafeArea()

            VStack(spacing: 28) {
                Spacer()

                // Logo
                VStack(spacing: 6) {
                    Text("paisa")
                        .font(.system(size: 42, weight: .black))
                        .foregroundColor(Color(red: 0.78, green: 0.94, blue: 0.29))
                    Text("Connect to your Mac server")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(Color.gray)
                }

                // Form
                VStack(spacing: 14) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("SERVER URL")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(Color.gray)
                            .kerning(1.2)
                        TextField("http://macbook.tail1234.ts.net:3000", text: $serverURL)
                            .textFieldStyle(.plain)
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                            .keyboardType(.URL)
                            .padding(14)
                            .background(Color(white: 0.1))
                            .cornerRadius(10)
                            .overlay(RoundedRectangle(cornerRadius: 10)
                                .stroke(Color(white: 0.2), lineWidth: 1))
                            .foregroundColor(.white)
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("API SECRET")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(Color.gray)
                            .kerning(1.2)
                        SecureField("Paste from secrets.env", text: $apiSecret)
                            .textFieldStyle(.plain)
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                            .padding(14)
                            .background(Color(white: 0.1))
                            .cornerRadius(10)
                            .overlay(RoundedRectangle(cornerRadius: 10)
                                .stroke(Color(white: 0.2), lineWidth: 1))
                            .foregroundColor(.white)
                    }

                    if let error = errorMsg {
                        Text(error)
                            .font(.system(size: 13))
                            .foregroundColor(Color(red: 1, green: 0.42, blue: 0.42))
                            .multilineTextAlignment(.center)
                    }
                }
                .padding(.horizontal, 28)

                // Connect button
                Button(action: connect) {
                    if isChecking {
                        ProgressView().progressViewStyle(CircularProgressViewStyle(tint: .black))
                    } else {
                        Text("Connect")
                            .font(.system(size: 16, weight: .black))
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .background(Color(red: 0.78, green: 0.94, blue: 0.29))
                .foregroundColor(.black)
                .cornerRadius(12)
                .padding(.horizontal, 28)
                .disabled(serverURL.isEmpty || apiSecret.isEmpty || isChecking)

                Spacer()
            }
        }
    }

    private func connect() {
        guard let url = URL(string: serverURL.trimmingCharacters(in: .whitespaces) + "/health") else {
            errorMsg = "Invalid server URL."
            return
        }

        isChecking = true
        errorMsg   = nil

        var request = URLRequest(url: url, timeoutInterval: 6)
        request.setValue("Bearer \(apiSecret)", forHTTPHeaderField: "Authorization")

        URLSession.shared.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                isChecking = false

                if let error = error {
                    errorMsg = "Could not reach server.\n\(error.localizedDescription)"
                    return
                }

                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    errorMsg = "Server responded but returned an error.\nCheck your API secret."
                    return
                }

                // Save config and proceed
                AppConfig.serverURL = serverURL.trimmingCharacters(in: .whitespaces)
                AppConfig.apiSecret = apiSecret.trimmingCharacters(in: .whitespaces)
                onComplete()
            }
        }.resume()
    }
}
