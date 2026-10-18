package dev.optio.feature.more.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.produceState
import dev.optio.core.ui.agent.*
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.network.ApiClient
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.Loadable
import dev.optio.core.ui.state.load
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.tabularNums
import dev.optio.feature.more.api.OptioSettingsRow
import dev.optio.feature.more.api.getOptioSettings
import dev.optio.feature.more.api.updateOptioSettings
import dev.optio.feature.more.ui.CardNote
import dev.optio.feature.more.ui.ChipCloud
import dev.optio.feature.more.ui.CollectNotices
import dev.optio.feature.more.ui.MoreAgentTypes
import dev.optio.feature.more.ui.MoreScaffold
import dev.optio.feature.more.ui.NoticeViewModel
import dev.optio.feature.more.ui.SwitchRow
import dev.optio.feature.more.ui.bottomSpacer
import dev.optio.feature.more.ui.groupedItem
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** The editable Optio assistant settings (iOS `OptioAgentSettingsView` state). */
data class AgentSettingsForm(
    val agentRuntime: String = "claude-code",
    val agentOptions: Map<String, OptionValue> = emptyMap(),
    val model: String = "sonnet",
    val systemPrompt: String = "",
    val confirmWrites: Boolean = true,
    val maxTurns: Int = 20,
    /** Shown only: the tool allowlist is edited on the web (the catalog isn't exposed here). */
    val enabledTools: List<String> = emptyList(),
    /** "" = no preference. */
    val reviewAgentType: String = "",
    val reviewModel: String = "",
) {
    /**
     * Keeps harness options alongside the selected model, and sends explicit null to clear
     * review defaults. The tool allowlist remains unchanged because this screen does not edit it.
     */
    fun body(): JsonElement = buildJsonObject {
        put("agentRuntime", JsonPrimitive(agentRuntime))
        put("agentOptions", JsonObject(agentOptions.mapValues { it.value.json } + (modelFieldForRuntime(agentRuntime) to JsonPrimitive(model))))
        put("model", JsonPrimitive(model))
        put("systemPrompt", JsonPrimitive(systemPrompt))
        if (enabledTools.isNotEmpty()) put("enabledTools", JsonArray(enabledTools.map(::JsonPrimitive)))
        put("confirmWrites", JsonPrimitive(confirmWrites))
        put("maxTurns", JsonPrimitive(maxTurns))
        put("defaultReviewAgentType", reviewAgentType.ifEmpty { null }?.let(::JsonPrimitive) ?: JsonNull)
        put("defaultReviewModel", reviewModel.trim().ifEmpty { null }?.let(::JsonPrimitive) ?: JsonNull)
    }

    fun withRuntime(runtime: String): AgentSettingsForm = if (runtime == agentRuntime) this
        else copy(agentRuntime = runtime, agentOptions = emptyMap(), model = "")

    companion object {
        const val MIN_TURNS = 5
        const val MAX_TURNS = 50

        fun of(row: OptioSettingsRow) = AgentSettingsForm(
            agentRuntime = row.agentRuntime ?: "claude-code",
            agentOptions = row.agentOptions.orEmpty().mapNotNull { (key, value) -> OptionValue.fromJson(value)?.let { key to it } }.toMap(),
            model = row.model?.takeIf { it.isNotBlank() }
                ?: row.agentOptions?.get(modelFieldForRuntime(row.agentRuntime ?: "claude-code"))?.let { OptionValue.fromJson(it)?.stringValue }
                ?: if (row.model == null && (row.agentRuntime == null || row.agentRuntime == "claude-code")) "sonnet" else "",
            systemPrompt = row.systemPrompt ?: "",
            confirmWrites = row.confirmWrites ?: true,
            maxTurns = (row.maxTurns ?: 20.0).toInt().coerceIn(MIN_TURNS, MAX_TURNS),
            enabledTools = row.enabledTools.orEmpty(),
            reviewAgentType = row.defaultReviewAgentType.orEmpty(),
            reviewModel = row.defaultReviewModel.orEmpty(),
        )
    }
}

/** `/api/optio/settings`: load into a form, save it back (admins only; the server enforces it too). */
class OptioAgentSettingsViewModel(private val api: ApiClient) : NoticeViewModel() {
    private val _state = MutableStateFlow<LoadState<AgentSettingsForm>>(LoadState.Idle)

    /** The settings as last loaded or saved. */
    val state: StateFlow<LoadState<AgentSettingsForm>> = _state.asStateFlow()

    private val _form = MutableStateFlow(AgentSettingsForm())
    val form: StateFlow<AgentSettingsForm> = _form.asStateFlow()

    private val _saving = MutableStateFlow(false)
    val saving: StateFlow<Boolean> = _saving.asStateFlow()

    private val _saved = MutableStateFlow(false)

    /** True after a save until the next edit (iOS shows "Saved" on the button). */
    val saved: StateFlow<Boolean> = _saved.asStateFlow()

    private var loadJob: Job? = null

    init {
        refresh()
    }

    fun refresh() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch { load() }
    }

    suspend fun load() {
        _state.load { AgentSettingsForm.of(api.getOptioSettings()) }?.let { _form.value = it }
    }

    fun edit(transform: (AgentSettingsForm) -> AgentSettingsForm) {
        _form.update(transform)
        _saved.value = false
    }

    fun save() {
        if (_saving.value) return
        _saving.value = true
        _saved.value = false
        viewModelScope.launch {
            try {
                val saved = AgentSettingsForm.of(api.updateOptioSettings(_form.value.body()))
                _state.value = LoadState.Loaded(saved)
                _form.value = saved
                _saved.value = true
                notify("Saved")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                _saving.value = false
            }
        }
    }
}

/** `OptioAgentSettingsRoute` (iOS `OptioAgentSettingsView`, "Optio Agent"). */
@Composable
fun OptioAgentSettingsScreen() {
    val api = LocalApiClient.current
    val viewModel = viewModel { OptioAgentSettingsViewModel(api) }
    val state by viewModel.state.collectAsStateWithLifecycle()
    val form by viewModel.form.collectAsStateWithLifecycle()
    val saving by viewModel.saving.collectAsStateWithLifecycle()
    val saved by viewModel.saved.collectAsStateWithLifecycle()
    val provider = providerFor(form.agentRuntime)
    val catalogState by produceState<CatalogState?>(CatalogState.Loading, api, provider) {
        value = CatalogState.Loading
        value = AgentCatalogCache.load(api, provider)
    }
    CollectNotices(viewModel.notices)
    MoreScaffold("Optio Agent settings") { padding ->
        OptioAgentSettingsContent(
            state = state,
            form = form,
            isAdmin = Roles.isAdmin,
            saving = saving,
            saved = saved,
            contentPadding = padding,
            onRetry = viewModel::refresh,
            onEdit = viewModel::edit,
            onSave = viewModel::save,
            catalogState = catalogState,
        )
    }
}

/** The settings form, stateless. Non-admins see it read-only. */
@Composable
fun OptioAgentSettingsContent(
    state: LoadState<AgentSettingsForm>,
    form: AgentSettingsForm,
    isAdmin: Boolean,
    saving: Boolean,
    saved: Boolean,
    contentPadding: PaddingValues,
    onRetry: () -> Unit,
    onEdit: ((AgentSettingsForm) -> AgentSettingsForm) -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
    catalogState: CatalogState? = null,
) {
    val colors = OptioTheme.colors
    Loadable(state = state, onRetry = onRetry, what = "the settings", contentPadding = contentPadding, modifier = modifier) {
        LazyColumn(Modifier.fillMaxSize().readableWidth().testTag("agent-settings"), contentPadding = contentPadding) {
            groupedItem("assistant", header = "Assistant") {
                if (isAdmin) {
                    RuntimeMenuRow("Agent", form.agentRuntime,
                        ALL_RUNTIME_CHOICES.filter { it.value != "openclaw" },
                        onPick = { runtime -> onEdit { it.withRuntime(runtime) } },
                        modifier = Modifier.testTag("assistant-runtime"))
                    InsetDivider()
                    val provider = providerFor(form.agentRuntime)
                    val modelField = catalogState.catalog?.modelField ?: modelFieldForProvider(provider)
                    AgentOptionsPicker(provider, catalogState,
                        form.agentOptions + (modelField to OptionValue.Str(form.model)), local = false,
                        onChange = { key, value -> onEdit { previous ->
                            previous.copy(agentOptions = previous.agentOptions + (key to value),
                                model = if (key == modelField) value.stringValue.orEmpty() else previous.model)
                        } })
                    catalogFootnote(catalogState)?.let { CardNote(it) }
                } else {
                    Column(Modifier.padding(Spacing.l).testTag("assistant-runtime-readonly")) {
                        Text("Agent: ${runtimeLabel(form.agentRuntime)}")
                        Text("Model: ${form.model.ifBlank { "Default" }}")
                        form.agentOptions.forEach { (key, value) -> Text("$key: ${value.raw}") }
                    }
                }
                InsetDivider()
                SwitchRow(
                    "Confirm before write operations",
                    checked = form.confirmWrites,
                    onCheckedChange = { on -> onEdit { it.copy(confirmWrites = on) } },
                    enabled = isAdmin,
                    modifier = Modifier.testTag("confirm-writes"),
                )
                InsetDivider()
                MaxTurnsStepper(
                    value = form.maxTurns,
                    enabled = isAdmin,
                    onChange = { turns -> onEdit { it.copy(maxTurns = turns) } },
                )
            }
            groupedItem("prompt", header = "System prompt", footer = "Appended to the built-in base prompt.") {
                OutlinedTextField(
                    value = form.systemPrompt,
                    onValueChange = { text -> onEdit { it.copy(systemPrompt = text) } },
                    enabled = isAdmin,
                    textStyle = OptioTheme.type.monoFootnote,
                    minLines = 6,
                    modifier = Modifier.fillMaxWidth().padding(Spacing.m).testTag("system-prompt"),
                )
            }
            groupedItem("tools", header = "Enabled tools", footer = "Edit the tool allowlist from the web Settings page.") {
                if (form.enabledTools.isEmpty()) CardNote("All tools enabled") else ChipCloud(form.enabledTools)
            }
            groupedItem(
                "review",
                header = "Workspace review defaults",
                footer = "Used when a repo does not set its own review agent. The model must belong to the chosen agent's catalog.",
            ) {
                ReviewAgentPicker(
                    value = form.reviewAgentType,
                    enabled = isAdmin,
                    onChange = { agent -> onEdit { it.copy(reviewAgentType = agent) } },
                )
                InsetDivider()
                OutlinedTextField(
                    value = form.reviewModel,
                    onValueChange = { text -> onEdit { it.copy(reviewModel = text) } },
                    enabled = isAdmin,
                    label = { Text("Review model (optional)") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth().padding(Spacing.m).testTag("review-model"),
                )
            }
            if (isAdmin) {
                item(key = "save") {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.l),
                        horizontalArrangement = Arrangement.End,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (saving) CircularProgressIndicator(Modifier.padding(end = Spacing.m).size(20.dp), strokeWidth = 2.dp)
                        Button(onClick = onSave, enabled = !saving, modifier = Modifier.testTag("save-settings")) {
                            Text(if (saved) "Saved" else "Save settings")
                        }
                    }
                }
            } else {
                groupedItem("readonly") {
                    CardNote("Only workspace admins can change these settings.")
                }
            }
            bottomSpacer()
        }
    }
}

/** iOS `Stepper("Max turns: N", in: 5...50)`. */
@Composable
private fun MaxTurnsStepper(
    value: Int,
    enabled: Boolean,
    onChange: (Int) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.s).testTag("max-turns"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Text(
            "Max turns: $value",
            style = OptioTheme.type.body.tabularNums(),
            color = OptioTheme.colors.label.copy(alpha = if (enabled) 1f else 0.38f),
            modifier = Modifier.weight(1f),
        )
        FilledTonalIconButton(
            onClick = { onChange((value - 1).coerceAtLeast(AgentSettingsForm.MIN_TURNS)) },
            enabled = enabled && value > AgentSettingsForm.MIN_TURNS,
            modifier = Modifier.testTag("max-turns-minus"),
        ) { Icon(Icons.Outlined.Remove, contentDescription = "Fewer turns") }
        FilledTonalIconButton(
            onClick = { onChange((value + 1).coerceAtMost(AgentSettingsForm.MAX_TURNS)) },
            enabled = enabled && value < AgentSettingsForm.MAX_TURNS,
            modifier = Modifier.testTag("max-turns-plus"),
        ) { Icon(Icons.Outlined.Add, contentDescription = "More turns") }
    }
}

/** iOS `Picker("Review agent")`: No preference, then the agent runtimes. */
@Composable
private fun ReviewAgentPicker(
    value: String,
    enabled: Boolean,
    onChange: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val options = listOf("" to "No preference") + MoreAgentTypes.all
    Row(
        Modifier.fillMaxWidth().padding(start = Spacing.l, end = Spacing.s, top = Spacing.xs, bottom = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "Review agent",
            style = OptioTheme.type.body,
            color = OptioTheme.colors.label.copy(alpha = if (enabled) 1f else 0.38f),
            modifier = Modifier.weight(1f),
        )
        Box {
            TextButton(onClick = { open = true }, enabled = enabled, modifier = Modifier.testTag("review-agent")) {
                Text(options.firstOrNull { it.first == value }?.second ?: MoreAgentTypes.label(value))
                Icon(Icons.Filled.ExpandMore, contentDescription = null, modifier = Modifier.size(18.dp))
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                options.forEach { (agent, label) ->
                    DropdownMenuItem(
                        text = { Text(label) },
                        trailingIcon = if (agent == value) {
                            { Icon(Icons.Filled.Check, contentDescription = "Selected") }
                        } else {
                            null
                        },
                        onClick = {
                            open = false
                            onChange(agent)
                        },
                    )
                }
            }
        }
    }
}
