package dev.optio.core.navigation

/** Navigation stacks. INSIGHTS remains routable under More; visible order is [primary]. */
enum class Tab(val label: String) {
    OVERVIEW("Overview"),
    WORK("Work"),
    LIBRARY("Library"),
    INSIGHTS("Insights"),
    MORE("More"),
    ASSISTANT("Optio Agent"),
    ;

    companion object {
        val primary = listOf(OVERVIEW, WORK, ASSISTANT, LIBRARY, MORE)
    }

    /** The hub sections in this tab's segmented switcher, in order; empty for single-screen hubs. */
    val sections: List<Section>
        get() = Section.entries.filter { it.tab == this }
}
