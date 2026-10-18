import SwiftUI

/// The Optio conversational assistant's settings (`/api/optio/settings`):
/// harness, model/options, system prompt, confirm-writes, max turns, and the workspace default
/// review agent/model. Tool toggles are edited on the web (the tool catalog is
/// not exposed to this client).
struct OptioAgentSettingsView: View {
    @Environment(APIClient.self) private var api
    @Environment(MoreContext.self) private var context

    @State private var loaded = false
    @State private var loadError: Error?
    @State private var runtime = "claude-code"
    @State private var agentOptions: WorkForm.AgentOptions = [:]
    @State private var catalogs = AgentCatalogStore()
    private var provider: String { WorkForm.provider(for: runtime) }
    @State private var systemPrompt = ""
    @State private var confirmWrites = true
    @State private var maxTurns = 20
    @State private var enabledTools: [String] = []
    @State private var defaultReviewAgentType = ""
    @State private var defaultReviewModel = ""
    @State private var saving = false
    @State private var saved = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if loaded {
                form
            } else if let loadError {
                ErrorRow(error: loadError) { Task { await load() } }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Optio Agent")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .moreErrorAlert($errorMessage)
    }

    private var form: some View {
        Form {
            Section("Assistant") {
                Picker("Harness", selection: Binding(get: { runtime }, set: { value in
                    runtime = value
                    agentOptions = [:]
                    catalogs.load(WorkForm.provider(for: value), api: api)
                })) {
                    ForEach(MoreAgentTypes.all, id: \.0) { Text($0.1).tag($0.0) }
                }
                AgentOptionsPickerView(provider: provider, state: catalogs.state(provider), values: agentOptions, local: false) { key, value in
                    agentOptions[key] = value
                }
                if let note = AgentOptionsPickerView.footnote(catalogs.state(provider)) {
                    Text(note).font(.footnote).foregroundStyle(.secondary)
                }
                Toggle("Confirm before write operations", isOn: $confirmWrites)
                Stepper("Max turns: \(maxTurns)", value: $maxTurns, in: 5...50)
            }
            Section {
                TextEditor(text: $systemPrompt)
                    .font(.footnote.monospaced())
                    .frame(minHeight: 160)
            } header: {
                Text("System prompt")
            } footer: {
                Text("Appended to the built-in base prompt.")
            }
            Section {
                if enabledTools.isEmpty {
                    Text("All tools enabled").font(.footnote).foregroundStyle(.secondary)
                } else {
                    MoreChipCloud(items: enabledTools)
                }
            } header: {
                Text("Enabled tools")
            } footer: {
                Text("Edit the tool allowlist from the web Settings page.")
            }
            Section {
                Picker("Review agent", selection: $defaultReviewAgentType) {
                    Text("No preference").tag("")
                    ForEach(MoreAgentTypes.all, id: \.0) { Text($0.1).tag($0.0) }
                }
                TextField("Review model (optional)", text: $defaultReviewModel)
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
            } header: {
                Text("Workspace review defaults")
            } footer: {
                Text("Used when a repo does not set its own review agent. The model must belong to the chosen agent's catalog.")
            }
            if context.isAdmin {
                Section {
                    Button {
                        Task { await save() }
                    } label: {
                        if saving { ProgressView() } else { Text(saved ? "Saved" : "Save settings") }
                    }
                    .disabled(saving)
                }
            } else {
                Section {
                    Text("Only workspace admins can change these settings.").font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .disabled(!context.isAdmin)
    }

    private func load() async {
        do {
            let s = try await api.getOptioSettings()
            runtime = s.agentRuntime ?? "claude-code"
            agentOptions = (s.agentOptions ?? [:]).compactMapValues { value in
                if let text = value.stringValue { return WorkForm.OptionValue.string(text) }
                if let flag = value.boolValue { return WorkForm.OptionValue.bool(flag) }
                return nil
            }
            let field = WorkForm.modelField(forRuntime: runtime)
            if agentOptions[field] == nil, let model = s.model, !model.isEmpty { agentOptions[field] = .string(model) }
            catalogs.load(provider, api: api)
            systemPrompt = s.systemPrompt ?? ""
            confirmWrites = s.confirmWrites ?? true
            maxTurns = Int(s.maxTurns ?? 20)
            enabledTools = s.enabledTools ?? []
            defaultReviewAgentType = s.defaultReviewAgentType ?? ""
            defaultReviewModel = s.defaultReviewModel ?? ""
            loaded = true
            loadError = nil
        } catch {
            loadError = error
        }
    }

    private func save() async {
        saving = true
        saved = false
        defer { saving = false }
        let input = UpdateOptioSettingsInput(
            agentRuntime: runtime,
            agentOptions: agentOptions.mapValues(\.anyCodable),
            model: agentOptions[WorkForm.modelField(forRuntime: runtime)]?.stringValue ?? "",
            systemPrompt: systemPrompt,
            enabledTools: enabledTools,
            confirmWrites: confirmWrites,
            maxTurns: Double(maxTurns),
            defaultReviewAgentType: defaultReviewAgentType.isEmpty ? nil : defaultReviewAgentType,
            defaultReviewModel: defaultReviewModel.isEmpty ? nil : defaultReviewModel
        )
        do {
            _ = try await api.updateOptioSettings(input)
            saved = true
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
