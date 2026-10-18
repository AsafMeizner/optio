package dev.optio.feature.agents

import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeSocket
import dev.optio.core.model.stringValue
import kotlinx.serialization.json.*
import kotlin.test.*
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class OptioAssistantTest {
    @get:Rule val main = RealMainRule()
    @get:Rule val rule = FakeOptioServerRule()
    private lateinit var vm: OptioAssistantViewModel

    @Before fun setup() {
        val api = rule.server.client()
        api.workspaceId = "workspace-override"
        vm = main.onMain { OptioAssistantViewModel(api) }
    }
    @After fun cleanup() { main.onMain { vm.disconnect() } }
    private fun connect(): FakeSocket {
        val endpoint = rule.server.webSocket("/ws/optio/chat")
        main.onMain { vm.connect() }
        return endpoint.awaitConnection().also {
            it.sendText("""{"type":"status","status":"ready"}""")
            eventually { vm.state.value.ready }
        }
    }
    private fun proposal(socket: FakeSocket) {
        socket.sendText("""{"type":"action_proposal","actionId":"11111111-1111-4111-8111-111111111111","description":"Create work","items":[],"work":[{"name":"Fix login","what":{"prompt":"Fix login"},"where":{"runTarget":"local","localDir":"/repo"}}]}""")
        socket.sendText("""{"type":"status","status":"waiting_for_approval"}""")
        eventually { vm.state.value.pending && vm.state.value.ready }
    }
    @Test fun sendsPatAndWorkspaceAndStreamsResponse() {
        val socket = connect()
        assertEquals("workspace-override", socket.request.headers["x-workspace-id"])
        assertTrue(socket.request.headers["Sec-WebSocket-Protocol"]?.contains("optio-auth-") == true)
        assertTrue(main.onMain { vm.send("Make some work") })
        val request = Json.parseToJsonElement(socket.awaitText()).jsonObject
        assertEquals("Make some work", request["content"]?.stringValue)
        val requestId = request["requestId"]!!.stringValue!!
        assertEquals(requestId, java.util.UUID.fromString(requestId).toString())
        assertNull(request["conversationContext"])
        socket.sendText("""{"type":"user_message","content":"Make some work","requestId":"$requestId"}""")
        socket.sendText("""{"type":"user_message","content":"Make some work","requestId":"$requestId"}""")
        assertTrue(vm.state.value.canSend)
        socket.sendText("""{"type":"text","content":"Hello "}""")
        socket.sendText("""{"type":"text","content":"world"}""")
        socket.sendText("""{"type":"status","status":"ready"}""")
        eventually { vm.state.value.messages.lastOrNull()?.content == "Hello world" }
        assertEquals(2, vm.state.value.messages.size)
    }
    @Test fun proposalRequiresExplicitSingleUseDecision() {
        val socket = connect()
        proposal(socket)
        assertEquals("Fix login", vm.state.value.messages.last().action?.work?.single()?.get("name")?.stringValue)
        assertTrue(vm.state.value.canSend)
        assertFalse(vm.state.value.canClear)
        assertTrue(socket.received.isEmpty())
        main.onMain { vm.decide("11111111-1111-4111-8111-111111111111", true); vm.decide("11111111-1111-4111-8111-111111111111", true) }
        assertEquals("approve", Json.parseToJsonElement(socket.awaitText()).jsonObject["type"]?.stringValue)
        assertEquals(1, socket.received.size)
        assertEquals("Approved", vm.state.value.messages.last().action?.decision)
    }
    @Test fun disconnectDisablesSavedApprovalWithoutReplay() {
        val socket = connect()
        proposal(socket)
        socket.close(4403, "Access denied")
        eventually { vm.state.value.status == "disconnected" }
        assertTrue(vm.state.value.pending)
        assertFalse(vm.state.value.ready)
        assertNull(vm.state.value.messages.last().action!!.decision)
        main.onMain { vm.decide("11111111-1111-4111-8111-111111111111", true) }
        assertTrue(socket.received.isEmpty())
        assertEquals("Access denied", vm.state.value.error)
    }
    @Test fun denialCarriesFeedbackAndErrorDoesNotLoseConversation() {
        val socket = connect()
        proposal(socket)
        main.onMain { vm.decide("11111111-1111-4111-8111-111111111111", false, "Use another repo") }
        val sent = Json.parseToJsonElement(socket.awaitText()).jsonObject
        assertEquals("deny", sent["type"]?.stringValue)
        assertEquals("Use another repo", sent["feedback"]?.stringValue)
        socket.sendText("""{"type":"error","message":"Refresh Claude credentials"}""")
        eventually { vm.state.value.messages.last().error }
        assertEquals("Refresh Claude credentials", vm.state.value.messages.last().content)
        assertEquals("Denied", vm.state.value.messages.first().action?.decision)
    }
    @Test fun closingDuringExecutionKeepsUncertainResultWarning() {
        val socket = connect()
        proposal(socket)
        main.onMain { vm.decide("11111111-1111-4111-8111-111111111111", true) }
        socket.awaitText()
        main.onMain { vm.disconnect() }
        assertEquals("Approved", vm.state.value.messages.first().action?.decision)
        assertTrue(vm.state.value.messages.last().content.contains("Check Work before repeating"))
        assertTrue(vm.state.value.messages.last().error)
    }
    @Test fun savedHistoryReplacesLocalTranscriptAndDeduplicatesEchoes() {
        val socket = connect()
        assertTrue(main.onMain { vm.send("Optimistic request") })
        val request = Json.parseToJsonElement(socket.awaitText()).jsonObject
        val id = request["requestId"]!!.stringValue!!
        socket.sendText("""{"type":"history","sessionId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","href":"/work/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","frames":[
            {"type":"user_message","content":"Saved request","requestId":"$id"},
            {"type":"text","content":"Saved "},{"type":"text","content":"response"},
            {"type":"error","message":"Saved error"},
            {"type":"action_result","summary":"Action failed","success":false}] }""")
        socket.sendText("""{"type":"user_message","content":"Saved request","requestId":"$id"}""")
        socket.sendText("""{"type":"user_message","content":"From another device","requestId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}""")
        socket.sendText("""{"type":"user_message","content":"From another device","requestId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}""")
        socket.sendText("""{"type":"status","status":"ready"}""")
        eventually { vm.state.value.messages.lastOrNull()?.content == "From another device" }
        assertEquals(listOf("Saved request", "Saved response", "Saved error", "Action failed", "From another device"), vm.state.value.messages.map { it.content })
        assertTrue(vm.state.value.messages.first().user)
        assertTrue(vm.state.value.messages[2].error)
        assertTrue(vm.state.value.messages[3].error)
        assertEquals("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", vm.state.value.sessionId)
        assertEquals("/work/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", vm.state.value.sessionHref)
    }
    @Test fun historyThenPendingProposalRestoresReviewWithoutOldCards() {
        val socket = connect()
        proposal(socket)
        socket.sendText("""{"type":"history","sessionId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","href":"https://untrusted.test","frames":[]}""")
        eventually { vm.state.value.messages.isEmpty() }
        proposal(socket)
        eventually { vm.state.value.messages.size == 1 }
        assertTrue(vm.state.value.pending)
        assertNull(vm.state.value.sessionHref)
        assertFalse(vm.state.value.canClear)
    }
    @Test fun repeatedProposalDoesNotDuplicateOrReviveSettledAction() {
        val socket = connect()
        proposal(socket)
        main.onMain { vm.decide("11111111-1111-4111-8111-111111111111", true) }
        socket.awaitText()
        socket.sendText("""{"type":"action_proposal","actionId":"11111111-1111-4111-8111-111111111111","description":"Duplicate","items":[],"work":[]}""")
        socket.sendText("""{"type":"status","status":"ready"}""")
        eventually { vm.state.value.status == "ready" }
        assertEquals(1, vm.state.value.messages.size)
        assertEquals("Approved", vm.state.value.messages.single().action?.decision)
        assertTrue(vm.state.value.canSend)
    }
    @Test fun anotherClientCanDecideApprovalWithoutBlockingThisClient() {
        val socket = connect()
        proposal(socket)
        socket.sendText("""{"type":"action_decision","actionId":"11111111-1111-4111-8111-111111111111","approved":false}""")
        socket.sendText("""{"type":"status","status":"ready"}""")
        eventually { vm.state.value.status == "ready" && !vm.state.value.pending }
        assertEquals("Denied", vm.state.value.messages.single().action?.decision)
        assertTrue(vm.state.value.canClear)
        assertTrue(socket.received.isEmpty())
    }
    @Test fun anotherClientApprovalAndReceiptSettleOneProposal() {
        val socket = connect()
        proposal(socket)
        socket.sendText("""{"type":"action_decision","actionId":"11111111-1111-4111-8111-111111111111","approved":true}""")
        socket.sendText("""{"type":"action_result","actionId":"11111111-1111-4111-8111-111111111111","success":true,"summary":"Created work"}""")
        socket.sendText("""{"type":"status","status":"ready"}""")
        eventually { vm.state.value.status == "ready" && !vm.state.value.pending }
        assertEquals("Approved", vm.state.value.messages.first().action?.decision)
        assertEquals("Created work", vm.state.value.messages.last().content)
        assertEquals(2, vm.state.value.messages.size)
        assertTrue(socket.received.isEmpty())
    }
    @Test fun receiptRecoversMissedDecisionAndExpiryUnblocksComposer() {
        val socket = connect()
        proposal(socket)
        socket.sendText("""{"type":"action_result","actionId":"11111111-1111-4111-8111-111111111111","success":true,"summary":"Created work"}""")
        eventually { !vm.state.value.pending }
        assertEquals("Approved", vm.state.value.messages.first().action?.decision)
        socket.sendText("""{"type":"action_proposal","actionId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","description":"Next work","items":[],"work":[]}""")
        eventually { vm.state.value.pending }
        socket.sendText("""{"type":"action_expired","actionId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}""")
        socket.sendText("""{"type":"status","status":"ready"}""")
        eventually { vm.state.value.status == "ready" && !vm.state.value.pending }
        assertTrue(vm.state.value.messages.last().action!!.decision!!.startsWith("Expired"))
        assertTrue(socket.received.isEmpty())
    }
    @Test fun resetWaitsForServerAcknowledgement() {
        val socket = connect()
        socket.sendText("""{"type":"text","content":"Saved conversation"}""")
        eventually { vm.state.value.messages.isNotEmpty() }
        main.onMain { vm.reset() }
        assertEquals("interrupt", Json.parseToJsonElement(socket.awaitText()).jsonObject["type"]?.stringValue)
        assertEquals("Saved conversation", vm.state.value.messages.single().content)
        assertFalse(vm.state.value.canClear)
        socket.sendText("""{"type":"history","sessionId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","href":"/work/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","frames":[]}""")
        socket.sendText("""{"type":"status","status":"ready"}""")
        eventually { vm.state.value.messages.isEmpty() && vm.state.value.ready }
    }
    @Test fun runtimeAndModelComeFromStatusAndSurviveStateOnlyFrames() {
        val socket = connect()
        socket.sendText("""{"type":"status","status":"ready","runtime":"codex","model":"gpt-5.4"}""")
        socket.sendText("""{"type":"status","status":"thinking"}""")
        eventually { vm.state.value.status == "thinking" }
        assertEquals("codex", vm.state.value.runtime)
        assertEquals("gpt-5.4", vm.state.value.model)
    }
    @Test fun busyAndPendingApprovalMessagesQueueWithoutPrematureHistory() {
        val socket = connect()
        socket.sendText("""{"type":"status","status":"thinking"}""")
        eventually { vm.state.value.busy }
        assertTrue(main.onMain { vm.send("Next task") })
        val first = Json.parseToJsonElement(socket.awaitText()).jsonObject["requestId"]!!.stringValue!!
        assertTrue(vm.state.value.messages.isEmpty())
        assertTrue(vm.state.value.queuedMessages.single().sending)
        socket.sendText("""{"type":"queue","messages":[{"requestId":"$first","content":"Next task"}]}""")
        eventually { vm.state.value.queuedMessages.singleOrNull()?.sending == false }
        proposal(socket)
        assertTrue(main.onMain { vm.send("One more task") })
        val second = Json.parseToJsonElement(socket.awaitText()).jsonObject["requestId"]!!.stringValue!!
        assertEquals(1, vm.state.value.messages.size, "Only the proposal is in history")
        assertFalse(vm.state.value.canClear)
        socket.sendText("""{"type":"queue","messages":[{"requestId":"$first","content":"Next task"},{"requestId":"$second","content":"One more task"}]}""")
        eventually { vm.state.value.queuedMessages.all { !it.sending } }
        main.onMain { vm.cancelQueued(first) }
        val cancelled = Json.parseToJsonElement(socket.awaitText()).jsonObject
        assertEquals("cancel_queued", cancelled["type"]?.stringValue)
        assertEquals(first, cancelled["requestId"]?.stringValue)
        assertTrue(vm.state.value.queuedMessages.first().cancelling)
        socket.sendText("""{"type":"queue","messages":[{"requestId":"$second","content":"One more task"}]}""")
        socket.sendText("""{"type":"user_message","requestId":"$second","content":"One more task"}""")
        socket.sendText("""{"type":"user_message","requestId":"$second","content":"One more task"}""")
        eventually { vm.state.value.queuedMessages.isEmpty() }
        assertEquals(listOf("One more task"), vm.state.value.messages.filter { it.user }.map { it.content })
    }
    @Test fun reconnectLoadsSavedQueueWithoutResendingIt() {
        val socket = connect()
        assertTrue(main.onMain { vm.send("Keep queued") })
        val id = Json.parseToJsonElement(socket.awaitText()).jsonObject["requestId"]!!.stringValue!!
        socket.sendText("""{"type":"queue","messages":[{"requestId":"$id","content":"Keep queued"}]}""")
        eventually { vm.state.value.queuedMessages.singleOrNull()?.sending == false }
        main.onMain { vm.disconnect() }
        assertFalse(vm.state.value.canSend)
        val next = connect()
        next.sendText("""{"type":"history","sessionId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","href":"/work/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","frames":[]}""")
        next.sendText("""{"type":"queue","messages":[{"requestId":"$id","content":"Keep queued"}]}""")
        eventually { vm.state.value.sessionId != null }
        assertEquals(id, vm.state.value.queuedMessages.single().requestId)
        assertFalse(vm.state.value.canClear)
        assertTrue(next.received.isEmpty())
    }
    @Test fun rejectedEnqueueKeepsTheRequestTextInItsError() {
        val socket = connect()
        assertTrue(main.onMain { vm.send("Keep this request") })
        val id = Json.parseToJsonElement(socket.awaitText()).jsonObject["requestId"]!!.stringValue!!
        socket.sendText("""{"type":"error","requestId":"$id","message":"Queue is full"}""")
        eventually { vm.state.value.messages.lastOrNull()?.error == true }
        assertTrue(vm.state.value.queuedMessages.isEmpty())
        assertTrue(vm.state.value.messages.last().content.contains("Keep this request"))
        assertTrue(vm.state.value.messages.last().content.contains("Queue is full"))
        assertTrue(vm.state.value.messages.none { it.user })
    }
    @Test fun pendingApprovalCannotBeClearedEvenIfStatusSaysReady() {
        val socket = connect()
        proposal(socket)
        main.onMain { vm.reset() }
        assertTrue(socket.received.isEmpty())
        socket.sendText("""{"type":"status","status":"ready"}""")
        eventually { vm.state.value.status == "ready" }
        main.onMain { vm.reset() }
        assertTrue(socket.received.isEmpty())
        assertTrue(vm.state.value.pending)
    }
}
