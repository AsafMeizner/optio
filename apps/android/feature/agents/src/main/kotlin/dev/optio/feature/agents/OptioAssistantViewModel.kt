package dev.optio.feature.agents

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import dev.optio.core.network.WebSocketClient
import dev.optio.core.network.WsFrame
import java.util.UUID
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

internal data class AssistantAction(
    val id: String,
    val items: List<String>,
    val work: List<JsonObject>,
    val decision: String? = null,
)

internal data class AssistantMessage(
    val id: String = UUID.randomUUID().toString(),
    val content: String,
    val user: Boolean = false,
    val error: Boolean = false,
    val action: AssistantAction? = null,
)

internal data class AssistantState(
    val status: String = "connecting",
    val messages: List<AssistantMessage> = emptyList(),
    val error: String? = null,
    val sessionId: String? = null,
    val sessionHref: String? = null,
) {
    val ready get() = status == "ready" || status == "waiting_for_approval"
    val pending get() = messages.any { it.action?.let { action -> action.decision == null } == true }
    val canSend get() = status == "ready" && !pending
    val canClear get() = canSend
    val busy get() = status == "thinking" || status == "executing"
}

/** A view of the saved work session. Reconnect loads history; it never resends a request. */
internal class OptioAssistantViewModel(
    api: ApiClient,
    private val socketFactory: () -> WebSocketClient = {
        WebSocketClient(
            urlProvider = { api.wsUrl("/ws/optio/chat") },
            tokenProvider = { api.token },
            autoReconnect = false,
            httpClient = api.webSocketHttpClient.newBuilder().addInterceptor { chain ->
                val request = chain.request().newBuilder()
                api.workspaceId?.let { request.header("x-workspace-id", it) }
                chain.proceed(request.build())
            }.build(),
        )
    },
) : ViewModel() {
    private val mutableState = MutableStateFlow(AssistantState())
    val state = mutableState.asStateFlow()
    private var socket: WebSocketClient? = null
    private var collecting: Job? = null
    private var streamId: String? = null
    private val seenRequests = mutableSetOf<String>()
    var draft: String = ""

    fun connect() {
        if (socket != null) return
        mutableState.value = mutableState.value.copy(status = "connecting", error = null)
        val current = socketFactory()
        socket = current
        collecting = viewModelScope.launch {
            current.connect()
            current.frames.collect { if (socket === current) handle(it) }
        }
    }

    fun disconnect() {
        collecting?.cancel()
        collecting = null
        socket?.disconnect()
        socket = null
        streamId = null
        val previous = mutableState.value
        mutableState.value = previous.copy(
            status = "disconnected",
            messages = previous.messages + if (previous.busy) listOf(AssistantMessage(
                content = "The connection closed while work was in progress. Reconnect to load the saved result. Check Work before repeating a request; actions are never retried automatically.",
                error = true,
            )) else emptyList(),
        )
    }

    fun reconnect() { disconnect(); connect() }

    internal fun handle(frame: WsFrame) {
        when (frame) {
            WsFrame.Opened -> mutableState.value = mutableState.value.copy(status = "connecting")
            is WsFrame.Closed -> {
                disconnect()
                mutableState.value = mutableState.value.copy(error = frame.reason?.takeIf { it.isNotBlank() }
                    ?: "Connection closed. Check Work before repeating a request whose result is uncertain.")
            }
            is WsFrame.Json -> {
                val obj = frame.value
                val previous = mutableState.value
                when (obj["type"]?.stringValue) {
                    "history" -> {
                        val frames = obj["frames"] as? JsonArray ?: return
                        val sessionId = obj["sessionId"]?.stringValue?.takeIf { SESSION_ID.matches(it) }
                        val href = obj["href"]?.stringValue?.takeIf { sessionId != null && it == "/sessions/$sessionId" }
                        streamId = null
                        seenRequests.clear()
                        mutableState.value = previous.copy(messages = emptyList(), error = null,
                            sessionId = sessionId, sessionHref = href)
                        frames.forEach { item ->
                            val event = item as? JsonObject ?: return@forEach
                            if (event["type"]?.stringValue in setOf("user_message", "text", "error", "action_result")) {
                                handle(WsFrame.Json(event))
                            }
                        }
                        streamId = null
                    }
                    "user_message" -> {
                        val content = obj["content"]?.stringValue ?: return
                        val requestId = obj["requestId"]?.stringValue
                        if (requestId != null && !seenRequests.add(requestId)) return
                        streamId = null
                        mutableState.value = previous.copy(messages = previous.messages + AssistantMessage(content = content, user = true))
                    }
                    "status" -> {
                        val status = obj["status"]?.stringValue ?: return
                        mutableState.value = previous.copy(status = status)
                        if (status == "ready") streamId = null
                    }
                    "text" -> {
                        val content = obj["content"]?.stringValue ?: return
                        val index = previous.messages.indexOfFirst { it.id == streamId }
                        if (index < 0) {
                            val message = AssistantMessage(content = content)
                            streamId = message.id
                            mutableState.value = previous.copy(messages = previous.messages + message)
                        } else {
                            mutableState.value = previous.copy(messages = previous.messages.mapIndexed { i, message ->
                                if (i == index) message.copy(content = message.content + content) else message
                            })
                        }
                    }
                    "action_proposal" -> {
                        val id = obj["actionId"]?.stringValue ?: return
                        if (previous.messages.any { it.action?.id == id }) return
                        streamId = null
                        val action = AssistantAction(
                            id,
                            (obj["items"] as? JsonArray)?.mapNotNull { it.stringValue }.orEmpty(),
                            (obj["work"] as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty(),
                        )
                        mutableState.value = previous.copy(messages = previous.messages + AssistantMessage(
                            content = obj["description"]?.stringValue ?: "Review proposed changes",
                            action = action,
                        ))
                    }
                    "action_decision", "action_expired" -> {
                        val id = obj["actionId"]?.stringValue ?: return
                        val decision = if (obj["type"]?.stringValue == "action_expired") "Expired · ask for a new proposal"
                            else when ((obj["approved"] as? JsonPrimitive)?.booleanOrNull) {
                                true -> "Approved"
                                false -> "Denied"
                                null -> return
                            }
                        streamId = null
                        mutableState.value = previous.copy(messages = previous.messages.map { message ->
                            if (message.action?.id == id) message.copy(action = message.action.copy(decision = decision)) else message
                        })
                    }
                    "action_result", "error" -> {
                        streamId = null
                        val actionId = obj["actionId"]?.stringValue
                        val messages = if (obj["type"]?.stringValue == "action_result" && actionId != null) previous.messages.map { message ->
                            if (message.action?.id == actionId) message.copy(action = message.action.copy(decision = "Approved")) else message
                        } else previous.messages
                        mutableState.value = previous.copy(status = if (previous.status == "clearing") "ready" else previous.status,
                            messages = messages + AssistantMessage(
                            content = obj["summary"]?.stringValue ?: obj["message"]?.stringValue ?: "Optio could not process the request.",
                            error = obj["type"]?.stringValue == "error" || (obj["success"] as? JsonPrimitive)?.booleanOrNull == false,
                        ))
                    }
                }
            }
            else -> Unit
        }
    }

    private fun sendFrame(frame: JsonObject): Boolean {
        if (socket?.send(frame) == true) return true
        mutableState.value = mutableState.value.copy(error = "Not connected. Your draft has been kept; reconnect to try again.")
        return false
    }

    fun send(text: String): Boolean {
        val content = text.trim()
        val previous = mutableState.value
        if (content.isEmpty() || !previous.canSend) return false
        val requestId = UUID.randomUUID().toString()
        val frame = buildJsonObject {
            put("type", "message")
            put("content", content)
            put("requestId", requestId)
        }
        seenRequests.add(requestId)
        if (!sendFrame(frame)) {
            seenRequests.remove(requestId)
            return false
        }
        streamId = null
        mutableState.value = previous.copy(status = "thinking", error = null,
            messages = previous.messages + AssistantMessage(content = content, user = true))
        return true
    }

    fun decide(id: String, approve: Boolean, feedback: String = "") {
        val previous = mutableState.value
        if (!previous.ready || previous.messages.none { it.action?.id == id && it.action.decision == null }) return
        if (!sendFrame(buildJsonObject {
            put("type", if (approve) "approve" else "deny")
            put("actionId", id)
            if (!approve) put("feedback", feedback.trim())
        })) return
        streamId = null
        mutableState.value = previous.copy(status = "thinking", messages = previous.messages.map { message ->
            if (message.action?.id == id) message.copy(action = message.action.copy(decision = if (approve) "Approved" else "Denied"))
            else message
        } + if (!approve && feedback.isNotBlank()) listOf(AssistantMessage(content = feedback.trim(), user = true)) else emptyList())
    }

    fun reset() {
        if (!mutableState.value.canClear || !sendFrame(buildJsonObject { put("type", "interrupt") })) return
        streamId = null
        // Keep the saved transcript until the server acknowledges clearing it with history.
        mutableState.value = mutableState.value.copy(status = "clearing")
    }

    override fun onCleared() { disconnect() }

    private companion object {
        val SESSION_ID = Regex("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}")
    }
}
