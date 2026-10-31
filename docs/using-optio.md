# Using Optio

This guide is for the people who use Optio day to day. You describe a change,
an agent makes it on a branch of your repository and opens a pull request (a
merge request on GitLab), and you review it and merge it.

The same guide is in the app when a deployment admin turns on **Settings →
Access → Getting-started guide** (`OPTIO_ONBOARDING`, chart
`onboarding.enabled`; off by default): **Help → Using Optio** in the account
menu at the bottom of the sidebar.

- [Your first day](#your-first-day)
- [Sign in](#sign-in)
- [Start work](#start-work)
- [Follow a run](#follow-a-run)
- [Waiting for you](#waiting-for-you)
- [Review the pull request](#review-the-pull-request)
- [Merge automatically](#merge-automatically)
- [When something goes wrong](#when-something-goes-wrong)

## Your first day

With the getting-started guide on, the **Overview** shows you a **Getting
started** checklist until you have done each step. Every step reads the real
state and links to where it is done:

| Step                           | Done when                          |
| ------------------------------ | ---------------------------------- |
| Sign in                        | Always (you're signed in)          |
| A repository to work on        | The workspace has a repository     |
| Start your first task          | You started a task on a repository |
| Review your first pull request | A task you started was merged      |

Only a workspace admin adds repositories; until one does, the repository
step says it waits for them. A workspace viewer, who can't start work, gets
no checklist.

**Hide** puts the checklist away for you in this browser; **Help →
Getting-started checklist** in the account menu brings it back. It goes away
by itself once every step is done.

## Sign in

Open Optio's address. The sign-in page has a **Sign in with …** button for
each way your admins set up; you sign in there and come back to Optio. If
there is no button, ask an Optio admin.

## Start work

### From New work

**New work** (on the Overview, or the Work page) asks:

- **When**: **Now**, on a **Schedule**, or on a trigger (a webhook or an
  event from a connected service).
- **Where**: an **Optio pod**, or **My machine** (a computer you paired
  under Machines). For work on a repository, pick the repository and its
  **Base branch**.
- **Who**: an agent and its model, or a plain terminal (just you at a shell
  prompt).
- **What**: the prompt, written by you or taken from a saved prompt
  (**Prompts** in the sidebar).
- **Then**:
  - **Exit when done**: one run; on a branch, it opens the pull request
    first.
  - **Work until merged**: opens a pull request, then comes back to fix
    failing CI, conflicts and review feedback until it merges.
  - **Wait for me**: stops at its prompt after each turn until you type.
  - **Persistent agent**: stays reachable and wakes when a person or
    another agent messages it.

### From an issue

**Inbox** (in the sidebar) lists the issues of your connected repositories
and ticket providers. **Assign to Optio** starts a task from one; **Assign
all to Optio** takes every unassigned one.

## Follow a run

- **Work** (in the sidebar) lists your work under **Active**, **Recurring**,
  **Agents** and **History**.
- The **Overview** shows what is running and what **needs you**.
- A task's page streams the agent's log as it works and links to its pull
  request once there is one. While the agent runs you can **Send** it a
  message, or **Stop** it. **Retry** and **Cancel task** are at the top.

## Waiting for you

When the agent is done and its pull request is open, the task waits for a
person to review and merge it. Nothing is stuck. Answer it in one of these
ways:

- **Merge it** on GitHub or GitLab; the task completes by itself.
- **Ask for changes**: as a review on the pull request (with **Work until
  merged**, the agent comes back for review feedback, failing CI and
  conflicts), or on the task's page: type into **Resume the agent with a
  message...** and press **Resume**.
- **Close** the pull request if you don't want the change: the task fails
  with "PR was closed without merging".

A task that **needs attention** stopped and needs you, for example because
CI failed or the pull request has conflicts. The task's page says why, and
the same message box resumes it.

## Review the pull request

The agent works on its own branch (`optio/task-<id>`). Review its pull
request like any colleague's.

The **Reviews** page lists the open pull requests of your repositories.
**Review with Optio** asks the review agent to review one, and **Approve &
merge** approves and merges it without the agent. You can also paste any
pull request's URL there to review it. When a repository has automatic code
review on (on its page: after CI passes, or when the pull request opens),
the review agent reviews each of its pull requests by itself.

## Merge automatically

On New work, with **Then: Work until merged**, tick **Merge it for me when
it's ready**. Optio then merges the pull request once its checks pass (or it
has none). Leave it unticked to merge by hand.

## When something goes wrong

| You see                                     | Do this                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| The task waits on its pull request for days | That's you: [review and merge, or ask for changes](#waiting-for-you)   |
| The task needs attention                    | Read why on its page, then resume it with a message or **Retry**       |
| "PR was closed without merging"             | The pull request was closed; start the work again if you still want it |
| No repository to pick in New work           | Ask a workspace admin to add it under Repos                            |
