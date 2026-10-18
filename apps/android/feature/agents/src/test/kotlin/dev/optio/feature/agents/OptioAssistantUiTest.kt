package dev.optio.feature.agents

import androidx.compose.ui.test.*
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.optio.core.ui.theme.OptioTheme
import kotlin.test.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w360dp-h800dp")
class OptioAssistantUiTest {
    @get:Rule val compose = createComposeRule()
    @Test fun failedSendPreservesEditableDictatedDraft() {
        compose.setContent { OptioTheme {
            OptioAssistantContent(AssistantState(status = "ready"), { false }, { _, _, _ -> }, {}, {}, {})
        } }
        compose.onNodeWithTag("assistant-draft").performTextInput("Create work from dictation")
        compose.onNodeWithTag("assistant-send").performClick()
        compose.onNodeWithTag("assistant-draft").assertTextContains("Create work from dictation")
    }
    @Test fun sendsOnlyOnExplicitTapAndClearsSuccessfulDraft() {
        val sent = mutableListOf<String>()
        compose.setContent { OptioTheme {
            OptioAssistantContent(AssistantState(status = "ready"), { sent += it; true }, { _, _, _ -> }, {}, {}, {})
        } }
        compose.onNodeWithTag("assistant-draft").performTextInput("Fix the login")
        assertEquals(emptyList(), sent)
        compose.onNodeWithTag("assistant-send").performClick()
        assertEquals(listOf("Fix the login"), sent)
        compose.onNodeWithTag("assistant-draft").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
    }
    @Test fun clearConversationRequiresConfirmation() {
        var clears = 0
        compose.setContent { OptioTheme {
            OptioAssistantContent(AssistantState(status = "ready", messages = listOf(AssistantMessage(content = "Hello"))),
                { true }, { _, _, _ -> }, { clears++ }, {}, {})
        } }
        compose.onNodeWithContentDescription("Clear conversation").performClick()
        assertEquals(0, clears)
        compose.onNodeWithText("Clear conversation?").assertExists()
        compose.onNodeWithText("Clear conversation").performClick()
        assertEquals(1, clears)
    }
    @Test fun pendingApprovalDisablesClearConversation() {
        compose.setContent { OptioTheme {
            OptioAssistantContent(AssistantState(status = "ready", messages = listOf(AssistantMessage(content = "Review", action = AssistantAction("a", emptyList(), emptyList())))),
                { true }, { _, _, _ -> }, {}, {}, {})
        } }
        compose.onNodeWithContentDescription("Clear conversation").assertIsNotEnabled()
    }
    @Test fun disconnectedChatStillAllowsDraftingButCannotSend() {
        compose.setContent { OptioTheme {
            OptioAssistantContent(AssistantState(status = "disconnected"), { false }, { _, _, _ -> }, {}, {}, {})
        } }
        compose.onNodeWithTag("assistant-draft").performTextInput("Keep my draft")
        compose.onNodeWithTag("assistant-send").assertIsNotEnabled()
        compose.onNodeWithText("Reconnect").assertExists()
    }
}
