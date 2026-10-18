package dev.optio.feature.agents

import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.captureScreens
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Test

class OptioAssistantScreenshotsTest : ScreenshotTest() {
    @Test fun empty() = captureScreens("OptioAssistant_empty") {
        OptioAssistantContent(AssistantState(status = "ready"), { true }, { _, _, _ -> }, {}, {}, {})
    }
    @Test fun review() = captureScreens("OptioAssistant_review") {
        val work = Json.parseToJsonElement("""{
            "name":"Fix login on my machine", "when":{"type":"manual"},
            "where":{"runTarget":"local","localDir":"/Users/jon/repos/optio","localHostId":"my-mac"},
            "who":{"runtime":"codex"}, "what":{"prompt":"Fix the login error and add a regression test."},
            "then":"waits-for-me"
        }""").jsonObject
        OptioAssistantContent(AssistantState(status = "waiting_for_approval", messages = listOf(
            AssistantMessage(content = "Ready to create this work", action = AssistantAction("a", emptyList(), listOf(work)))
        )), { true }, { _, _, _ -> }, {}, {}, {})
    }
}
