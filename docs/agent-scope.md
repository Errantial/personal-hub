# Persistent agent scope: Dots / OpenDots

Added at the owner's request on 2026-10-10. Goal: equivalent capabilities integrated into this hub, rather than an automatic dependency on a particular service or repository. Exact OpenDots reference and feature priorities are awaiting clarification; CopilotKit/OpenDots is the current comparison candidate.

OpenAI describes Dots as agents that continue responsibilities between conversations, use connected context, and return results or request decisions. This supports a hub direction of ongoing goals, scheduled/event-triggered work, persistent context, and user-visible progress. [Official Dots overview](https://learn.chatgpt.com/docs/dots), [tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory).

CopilotKit's OpenDots is a reference for persistent agent workspaces, agent identity, conversations, and computer/tool integration. It is not installed in this project. [Official repository](https://github.com/CopilotKit/OpenDots).

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

Voice calls and additional messaging channels are comparison items pending prioritization and input-permission decisions. They are not initial dependencies. The first channel remains the hub's own interface.

## Existing boundaries remain in force

- Hosted AI gets text only: no screenshots, images, attachments, or attachment-derived content.
- Sensitivity uses owner-applied source/content labels and inherited provenance only.
- Calendar writes follow configured authority; email sends require explicit user approval.
- No unrestricted shell, credentials in prompts, or arbitrary browser actions.
- Background work has leases, retry/reconciliation rules, cost limits, stop controls, and visible status.
- Never claim full Dots/OpenDots parity before individual capabilities have been implemented and verified.

## Delivery order

Finish authenticated planner persistence first. Introduce durable worker/job state before autonomous ongoing responsibilities; implement provider-routing and tool policies before enabling paid agent execution. Add proactive study/inbox reviews incrementally after the relevant integrations work. Android, server resources, and cost limits constrain concurrency and notification guarantees.
