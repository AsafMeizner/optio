package dev.optio.feature.agents

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.DeleteSweep
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.model.stringValue
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.routes.*
import dev.optio.core.network.ApiClient
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.components.MarkdownText
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

private val LocalAssistant = staticCompositionLocalOf<OptioAssistantViewModel> { error("Missing OptioAssistantHost") }

/** Lives with the signed-in shell; a server/workspace switch disposes its conversation. */
@Composable
fun OptioAssistantHost(content: @Composable () -> Unit) {
    val api = LocalApiClient.current
    val generation by LocalSessionStore.current.generation.collectAsStateWithLifecycle()
    val model: OptioAssistantViewModel = viewModel(key = "optio-assistant:$generation") { OptioAssistantViewModel(api) }
    DisposableEffect(model) { onDispose { model.disconnect() } }
    CompositionLocalProvider(LocalAssistant provides model, content = content)
}

/** Full-screen composition keeps the keyboard, review cards and navigation from overlapping. */
@Composable
internal fun OptioAssistantScreen() {
    val api = LocalApiClient.current
    val vm = LocalAssistant.current
    val state by vm.state.collectAsStateWithLifecycle()
    val navigator = LocalNavigator.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    var linkError by remember { mutableStateOf<String?>(null) }
    val uriHandler = remember(api, navigator) { object : UriHandler {
        override fun openUri(uri: String) {
            if (uri.startsWith("/") && !uri.startsWith("//")) {
                scope.launch {
                    try {
                        val route = assistantRoute(api, uri.substringBefore('?'))
                        if (route != null) navigator.push(route) else navigator.open(Section.WORK)
                    } catch (e: Exception) {
                        if (e is kotlinx.coroutines.CancellationException) throw e
                        linkError = "Couldn’t open this work. Try the Work tab."
                    }
                }
            } else if (uri.startsWith("https://") || uri.startsWith("http://")) navigator.openExternal(uri)
        }
    } }
    DisposableEffect(vm, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) vm.connect()
            if (event == Lifecycle.Event.ON_STOP) vm.disconnect()
        }
        lifecycle.addObserver(observer)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) vm.connect()
        onDispose { lifecycle.removeObserver(observer); vm.disconnect() }
    }
    CompositionLocalProvider(LocalUriHandler provides uriHandler) {
        OptioAssistantContent(state, vm::send, vm::decide, vm::reset, vm::reconnect,
            onBack = { navigator.pop() }, linkError = linkError, initialDraft = vm.draft, onDraftChange = { vm.draft = it })
    }
}

@Composable
internal fun OptioAssistantContent(
    state: AssistantState,
    onSend: (String) -> Boolean,
    onDecide: (String, Boolean, String) -> Unit,
    onReset: () -> Unit,
    onReconnect: () -> Unit,
    onBack: () -> Unit,
    linkError: String? = null,
    initialDraft: String = "",
    onDraftChange: (String) -> Unit = {},
) {
    var draft by rememberSaveable { mutableStateOf(initialDraft) }
    fun updateDraft(value: String) { draft = value; onDraftChange(value) }
    var confirmClear by rememberSaveable { mutableStateOf(false) }
    val list = rememberLazyListState()
    LaunchedEffect(state.messages.lastOrNull()?.content, state.messages.size, state.status) {
        if (list.layoutInfo.totalItemsCount > 0) list.animateScrollToItem(list.layoutInfo.totalItemsCount - 1)
    }
    if (confirmClear) AlertDialog(
        onDismissRequest = { confirmClear = false },
        title = { Text("Clear conversation?") },
        text = { Text("The saved conversation history will be removed. Created work stays available in Work.") },
        confirmButton = { TextButton(onClick = { confirmClear = false; onReset() }, enabled = state.canClear) { Text("Clear conversation") } },
        dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Cancel") } },
    )
    Scaffold(
        modifier = Modifier.testTag("optio-assistant"),
        topBar = {
            TopAppBar(title = { Text("Ask Optio") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    IconButton(onClick = { confirmClear = true }, enabled = state.canClear && state.messages.isNotEmpty()) { Icon(Icons.Outlined.DeleteSweep, "Clear conversation") }
                })
        },
        bottomBar = {
            Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(when (state.status) {
                        "connecting" -> "Connecting…"
                        "clearing" -> "Clearing conversation…"
                        "thinking" -> "Thinking…"
                        "executing" -> "Working…"
                        "waiting_for_approval" -> "Review the proposal above"
                        "disconnected" -> "Disconnected"
                        else -> "Ready"
                    }, modifier = Modifier.weight(1f), style = MaterialTheme.typography.labelMedium)
                    if (state.status == "disconnected") TextButton(onClick = onReconnect) { Text("Reconnect") }
                }
                (state.error ?: linkError)?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                Text("Use your keyboard’s microphone to dictate, then review and send.", style = MaterialTheme.typography.labelSmall)
                OutlinedTextField(value = draft, onValueChange = ::updateDraft,
                    modifier = Modifier.fillMaxWidth().testTag("assistant-draft"),
                    placeholder = { Text("Describe the work you want…") }, minLines = 2, maxLines = 5,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences))
                Button(onClick = { if (onSend(draft)) updateDraft("") },
                    enabled = state.canSend && draft.isNotBlank(), modifier = Modifier.fillMaxWidth().testTag("assistant-send")) { Text("Send") }
            }
        },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding), state = list,
            contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (state.messages.isEmpty()) item {
                Text("Turn an idea into work", style = MaterialTheme.typography.headlineSmall)
                Text("Tell Optio what to do and where it should run. It can find your repos and machines and help configure the work.")
                TextButton(onClick = { updateDraft("Help me create work on my machine.") }) { Text("Create work on my machine") }
                TextButton(onClick = { updateDraft("Show me my active work.") }) { Text("See what’s running") }
            }
            items(state.messages, key = { it.id }) { message ->
                Card(colors = CardDefaults.cardColors(containerColor = when {
                    message.error -> MaterialTheme.colorScheme.errorContainer
                    message.user -> MaterialTheme.colorScheme.secondaryContainer
                    else -> MaterialTheme.colorScheme.surfaceContainer
                }), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(if (message.user) "You" else "Optio", style = MaterialTheme.typography.labelMedium)
                        SelectionContainer { MarkdownText(message.content) }
                        message.action?.let { AssistantActionView(it, state.ready, onDecide) }
                    }
                }
            }
        }
    }
}

@Composable
private fun AssistantActionView(action: AssistantAction, ready: Boolean, onDecide: (String, Boolean, String) -> Unit) {
    var feedback by rememberSaveable(action.id) { mutableStateOf("") }
    var showFeedback by rememberSaveable(action.id) { mutableStateOf(false) }
    action.work.forEach { work ->
        Text(work["name"]?.stringValue ?: "New work", style = MaterialTheme.typography.titleMedium)
        listOf("when" to "When", "where" to "Where", "who" to "Who", "what" to "What", "then" to "Then").forEach { (key, title) ->
            work[key]?.let { Text("$title\n${previewValue(it)}", style = MaterialTheme.typography.bodyMedium) }
        }
        var expanded by remember { mutableStateOf(false) }
        TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Hide all settings" else "All work settings") }
        if (expanded) SelectionContainer { Text(prettyJson.encodeToString(JsonObject.serializer(), work), style = MaterialTheme.typography.bodySmall) }
    }
    action.items.forEach { SelectionContainer { Text(it, style = MaterialTheme.typography.bodySmall) } }
    if (action.decision != null) Text(action.decision, style = MaterialTheme.typography.labelLarge)
    else if (showFeedback) {
        OutlinedTextField(value = feedback, onValueChange = { feedback = it }, label = { Text("What should change? (optional)") }, modifier = Modifier.fillMaxWidth())
        TextButton(onClick = { onDecide(action.id, false, feedback) }, enabled = ready) { Text("Deny proposal") }
    } else {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { showFeedback = true }, enabled = ready) { Text("Deny") }
            Button(onClick = { onDecide(action.id, true, "") }, enabled = ready) { Text("Approve") }
        }
    }
}

private val prettyJson = Json { prettyPrint = true }
private fun previewValue(value: JsonElement): String = when (value) {
    is JsonObject -> value.entries.joinToString("\n") { (key, item) -> "$key: ${previewValue(item)}" }
    is JsonArray -> value.joinToString(", ") { previewValue(it) }
    else -> value.stringValue ?: value.toString()
}

private suspend fun assistantRoute(api: ApiClient, path: String): androidx.navigation3.runtime.NavKey? {
    val parts = path.trim('/').split('/')
    val id = parts.getOrNull(1) ?: return null
    if (id == "new") return null
    return when (parts.first()) {
        "work" -> {
            val result = api.get<JsonObject>("/api/work/$id")
            when (result["source"]?.stringValue) {
                "repo-task" -> TaskDetailRoute(id)
                "local-terminal" -> LocalTerminalRoute(id)
                "repo-blueprint" -> ScheduledDetailRoute(id)
                "local-blueprint" -> LocalAutomationRoute(id)
                "persistent-agent" -> AgentDetailRoute(id)
                "pod-session" -> SessionDetailRoute(id)
                "standalone" -> {
                    val work = result["work"] as? JsonObject
                    work?.get("workflowId")?.stringValue?.let { JobRunRoute(it, id) } ?: JobDetailRoute(id)
                }
                else -> null
            }
        }
        "tasks" -> if (id == "scheduled") parts.getOrNull(2)?.let { ScheduledDetailRoute(it) } else TaskDetailRoute(id)
        "local" -> if (id == "automations") parts.getOrNull(2)?.let { LocalAutomationRoute(it) } else LocalTerminalRoute(id)
        "jobs" -> if (parts.getOrNull(2) == "runs") parts.getOrNull(3)?.let { JobRunRoute(id, it) } else JobDetailRoute(id)
        "agents" -> AgentDetailRoute(id)
        "sessions" -> SessionDetailRoute(id)
        else -> null
    }
}
