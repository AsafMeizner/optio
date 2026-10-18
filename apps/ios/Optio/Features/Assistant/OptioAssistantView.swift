import SwiftUI

struct OptioAssistantView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: OptioAssistantModel
    @State private var showReset = false
    @State private var navigationError: String?

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        if model.rows.isEmpty { introduction }
                        ForEach(model.rows) { row in message(row) }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding()
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: model.rows.last?.text) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                .onChange(of: model.rows.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .background(Surface.page)
            .safeAreaInset(edge: .bottom, spacing: 0) { composer }
            .navigationTitle("Ask Optio")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { showReset = true } label: { Image(systemName: "eraser") }
                        .accessibilityLabel("Clear conversation")
                        .disabled(!model.canReset)
                }
            }
            .confirmationDialog("Clear conversation history?", isPresented: $showReset, titleVisibility: .visible) {
                Button("Clear conversation", role: .destructive) { Task { await model.reset() } }
            } message: { Text("This clears the saved conversation history. Created work and your draft are kept.") }
            .environment(\.openURL, OpenURLAction { url in
                guard url.scheme == nil else { return .systemAction }
                Task { await openWork(url) }
                return .handled
            })
            .task { model.start(api: api) }
            .onDisappear { model.stop() }
        }
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Turn an idea into work", systemImage: "sparkles").font(.title2.bold())
            Text("Describe what you want done. Optio can find your repos and machines, then prepare work for you to review.").foregroundStyle(.secondary)
            Button("Help me start work on my machine") { model.draft = "Help me start work on my machine" }
                .buttonStyle(.bordered)
            Text("To dictate, tap the microphone on your iPhone keyboard. Review the text before sending.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func message(_ row: OptioAssistantModel.Row) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(row.role == "user" ? "You" : "Optio").font(.caption.bold()).foregroundStyle(.secondary)
            Text((try? AttributedString(markdown: row.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(row.text))
                .textSelection(.enabled)
                .foregroundStyle(row.isError ? Color.red : Color.primary)
                .fixedSize(horizontal: false, vertical: true)
            if let proposal = row.proposal {
                ForEach(Array(proposal.work.enumerated()), id: \.offset) { _, work in workPreview(work) }
                ForEach(Array(proposal.items.enumerated()), id: \.offset) { _, item in
                    Text(item).font(.footnote.monospaced()).textSelection(.enabled)
                }
                if let decision = proposal.decision { Text(decision).font(.caption).foregroundStyle(.secondary) }
                else {
                    ViewThatFits(in: .horizontal) {
                        HStack { approvalButtons(proposal.id) }
                        VStack(alignment: .leading) { approvalButtons(proposal.id) }
                    }
                    .disabled(model.status != .waitingForApproval)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(row.role == "user" ? AppTheme.accent.opacity(0.08) : Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
    }

    @ViewBuilder private func approvalButtons(_ id: String) -> some View {
        Button("Approve") { Task { await model.decide(id: id, approve: true) } }.buttonStyle(.borderedProminent)
        Button("Decline") { Task { await model.decide(id: id, approve: false) } }.buttonStyle(.bordered)
    }

    private func workPreview(_ work: [String: Any]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(work["name"] as? String ?? "New work").font(.headline)
            ForEach([("when", "When"), ("where", "Where"), ("who", "Who"), ("what", "What"), ("then", "Then")], id: \.0) { key, title in
                if let value = work[key] {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(title).font(.caption.bold()).foregroundStyle(.secondary)
                        Text(previewText(key, value)).font(.footnote).textSelection(.enabled)
                    }
                }
            }
            // Keep every setting reviewable, including permissions, setup and owner.
            DisclosureGroup("All settings") {
                Text(OptioAssistantModel.json(work)).font(.caption.monospaced()).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.font(.footnote)
        }
        .padding(12)
        .background(Surface.page, in: RoundedRectangle(cornerRadius: 10))
    }

    private func previewText(_ key: String, _ value: Any) -> String {
        let object = value as? [String: Any] ?? [:]
        switch key {
        case "when":
            let type = object["type"] as? String ?? "manual"
            if type == "manual" { return "Now / on demand" }
            return type.capitalized + (object["config"].map { "\n" + OptioAssistantModel.json($0) } ?? "")
        case "where":
            var lines = [object["runTarget"] as? String == "local" ? "Your machine" : "Optio pod"]
            for (field, label) in [("localHostId", "Machine"), ("localDir", "Directory"), ("repoUrl", "Repo"), ("repoBranch", "Branch")] {
                if let text = object[field] as? String, !text.isEmpty { lines.append("\(label): \(text)") }
            }
            return lines.joined(separator: "\n")
        case "who":
            let runtime = object["runtime"] as? String ?? "terminal"
            var text = runtime == "terminal" ? "Terminal" : WorkFeed.runtimeLabel(runtime)
            if let model = object["model"] as? String { text += " · \(model)" }
            if let options = object["agentOptions"] as? [String: Any], !options.isEmpty { text += "\n" + OptioAssistantModel.json(options) }
            return text
        case "what":
            var text = object["prompt"] as? String ?? ""
            if text.isEmpty { text = "No initial prompt" }
            if let title = object["runTitle"] as? String { text += "\nRun title: \(title)" }
            return text
        case "then":
            switch value as? String {
            case "exits": return "Exits when done"
            case "waits-for-me": return "Waits for me"
            case "waits-for-messages": return "Waits for messages"
            case "until-merged": return "Works until merged"
            default: return OptioAssistantModel.json(value)
            }
        default: return OptioAssistantModel.json(value)
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(statusLabel).font(.caption).foregroundStyle(.secondary)
                Spacer()
                if model.status == .disconnected { Button("Reconnect") { model.reconnect(api: api) }.font(.caption.bold()) }
            }
            if let navigationError { Text(navigationError).font(.caption).foregroundStyle(.red) }
            HStack(alignment: .bottom, spacing: 12) {
                TextField("Describe the work…", text: $model.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(12)
                    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityLabel("Message to Optio")
                Button { Task { await model.send() } } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 36)).frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("Send message")
                .disabled(!model.canSend || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding()
        .background(.regularMaterial)
    }

    private var statusLabel: String {
        switch model.status {
        case .ready: "Ready · use your keyboard microphone to dictate"
        case .waitingForApproval: "Review the proposed work above"
        case .thinking: "Optio is thinking…"
        case .executing: "Optio is working…"
        case .connecting: "Connecting…"
        case .disconnected: "Disconnected · your draft is saved"
        }
    }

    private func openWork(_ url: URL) async {
        let parts = url.path.split(separator: "/").map(String.init)
        guard let first = parts.first, ["work", "tasks", "local", "sessions", "jobs", "agents"].contains(first) else {
            navigationError = "Open this link from the web app."
            return
        }
        if parts.count == 1 { router.open(.work); dismiss(); return }
        guard let id = parts.last, UUID(uuidString: id) != nil else { return }
        struct Resolved: Decodable { let source: String }
        do {
            let work: Resolved = try await api.get("/api/work/\(id)")
            let destination: WorkDestination
            switch work.source {
            case "repo-task": destination = .task(id)
            case "repo-blueprint": destination = .blueprint(id)
            case "standalone": destination = .job(id)
            case "local-terminal": destination = .localTerminal(id)
            case "local-blueprint": destination = .localBlueprint(id)
            case "pod-session": destination = .podSession(id)
            case "persistent-agent": destination = .agent(id)
            default: navigationError = "Find this item in Work."; return
            }
            router.createdWork = destination
            router.open(.work)
            dismiss()
        } catch { navigationError = "Couldn’t open this work: \(error.localizedDescription)" }
    }
}

struct AskOptioButton: View {
    @Environment(AppRouter.self) private var router
    @Environment(SessionStore.self) private var session
    var body: some View {
        if session.canCreateWork {
            Button { router.showAssistant = true } label: { Label("Ask Optio", systemImage: "sparkles") }
        }
    }
}
