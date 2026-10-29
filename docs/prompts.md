# Repository prompts and optional commit trailers

The built-in task and review prompts use GitLab commands for a GitLab repository and keep GitHub and CodeCommit commands for their respective repositories. A saved repository or default prompt continues to take precedence. `OPTIO_GIT_PLATFORMS=gitlab` selects GitLab-only defaults for that deployment.

An administrator can choose **Add starter prompts** on the Prompts page. The starters cover common jobs such as a skill, a review, documentation, tests and a refactor. The same control restores missing or edited starters without duplicating them or replacing a person's own prompt with the same name. Boot-time seeding is off unless `OPTIO_STARTER_PROMPTS=true` (Helm `prompts.starters`). Linked starter templates select their platform conditional from the repository when instantiated.

`OPTIO_WORK_TRACEABILITY=true` (Helm `tickets.traceability`) adds the original ticket key, requester and run link to the request description and commit trailers. It is off by default. `OPTIO_COMMIT_TRAILERS=false` (Helm `tickets.commitTrailers`) keeps the request metadata and omits trailers. A pod installs a chained `prepare-commit-msg` hook; a repository with its own `core.hooksPath` keeps that hook and receives the instructions in its prompt. Local runs receive the metadata as prompt instructions.

Team-name lookup is added by the Teams split, where team ownership exists. The pure trailer helpers already accept a team name. The execution identity and credentials remain those of the existing run owner.
