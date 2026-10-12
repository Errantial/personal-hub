# Persistent agent scope: Dots / OpenDots

Added at the owner's request on 2026-10-10. Confirmed reference: [CopilotKit/OpenDots](https://github.com/CopilotKit/OpenDots). Goal: equivalent capabilities integrated into this hub. Feature priorities and implementation choices remain open; the repository reference is resolved.

OpenAI describes Dots as agents that continue responsibilities between conversations, use connected context, and return results or request decisions. This supports a hub direction of ongoing goals, scheduled/event-triggered work, persistent context, and user-visible progress. [Official Dots overview](https://learn.chatgpt.com/docs/dots), [tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory).

The repository describes specialist agents, Spaces/editable pages, persistent conversations, scheduled background turns, per-agent computers, MCP tool permissions, user-managed memory, learning, voice calls, and Slack. It requires configured conversation infrastructure and model services; it is not installed in this project. [Repository README](https://github.com/CopilotKit/OpenDots#readme).

The README distinguishes scheduled instructions from a full ongoing-goal/event-trigger system, and identifies automatic delegation as future work. Those broader capabilities are hub requirements, rather than claims of existing OpenDots functionality.

## Feature mapping to implement later

| Capability | Hub requirement |
| --- | --- |
| Persistent assistant | Named assistant with saved responsibilities, context, preferences, and editable memory |
| Ongoing work | Durable goal/job state that survives restarts and client disconnects |
| Proactive work | Bounded scheduled/event-triggered reviews of deadlines, mail, and study progress |
| Interruptions and steering | User can add context, change priorities, pause, resume, or cancel jobs |
| Review and updates | Activity history, execution receipts, completed results, failures, and approval requests |
| Tools and computer access | Scoped MCP/application tools and isolated text-based browser fallback |
| Parallel work | Bounded worker concurrency/delegation where useful, with per-goal budgets and isolation |
| Provider choice | Existing default/sensitive provider routing applies to every step and derived context |
| Project context | Class portfolios and optional project spaces/pages as structured context |
| Workspace documents | Searchable Spaces/pages, nested organization, editable documents, autosave/revisions, and conversations grounded in authorized page content |
| Specialist assistants | Separate roles/instructions, conversations, context access, and tool permissions; one primary assistant initially |
| Learning | Inspectable preferences and proposed reusable skills with evidence, review/publication, deletion, and inherited sensitivity |
| Live execution view | Streamed progress, tool results, source links and review cards; human takeover for isolated browser work |

Voice calls and Slack access are included in later parity scope. Voice is gated on reconciling it with the current text-only hosted-AI policy; hosted audio processing is not authorized. Slack needs separate channel permissions and verification. The first channel remains the hub's own interface.

## Adoption decision remains open

Using OpenDots as a feature reference does not select its runtime or replace the current scaffold. Its README describes CopilotKit Intelligence for conversation persistence, with hosted, local evaluation, and licensed self-hosted options. Assess cost, licensing, retention, and sensitivity routing before choosing any dependency. Conversation storage, learning, search, channels, and computer services are separate data destinations; approving a model provider does not approve them automatically.

## Existing boundaries remain in force

- Hosted AI gets text only: no screenshots, images, attachments, or attachment-derived content.
- Sensitivity uses owner-applied source/content labels and inherited provenance only.
- Calendar writes follow configured authority; email sends require explicit user approval.
- No unrestricted shell, credentials in prompts, or arbitrary browser actions.
- Background work has leases, retry/reconciliation rules, cost limits, stop controls, and visible status.
- Never claim full Dots/OpenDots parity before individual capabilities have been implemented and verified.

## Delivery order

Three local backend milestones are now implemented in [responsibility contracts](responsibilities.md): owned lifecycle, UTC and local daily/weekly review schedules/explicit selected due admission, and blocked run/activity history. This is not an agent executor or background scheduler. Active enables owner requests only; placeholders never call providers/tools. Verified context/routing/permissions/budgets, leases/stop rechecks, real results/actions and UI remain pending. Editable owner memory supports explicit versioned context selection through the verified gateway; automatic retrieval and live AI remain pending.

Finish authenticated planner persistence first. Introduce durable worker/job state before autonomous ongoing responsibilities; implement provider-routing and tool policies before enabling paid agent execution. Add proactive study/inbox reviews incrementally after the relevant integrations work. Android, server resources, and cost limits constrain concurrency and notification guarantees.
