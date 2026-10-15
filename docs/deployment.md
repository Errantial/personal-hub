# Deployment and AI policy

## Live admission boundary 1 rollout (development; not deployed)

After the reviewed release and migrations 060/061 are deployed, approve a live destination in **Settings → AI → Assistant**. Choose the model and one declared upstream, then select **Approve destination**. Assistant asks, scheduled agents and selected-message category/task suggestions require approval. A saved key alone does not approve disclosure. No server profile/environment change is needed.

Changing the model or server destination terms invalidates prior approval. Revocation blocks later admissions; versions survive revoke/reapprove. An unavailable approved zero-retention upstream blocks without switching hosts. The Personal-mail switch is an additional permission ceiling; Restricted sources stay excluded. General gateway profiles and dispatch are unchanged.

Legacy conversations remain readable, but unbound turns are withheld from inference. New history follows retained source permissions; Use mail off also withholds mail-dependent history. Mail-dependent Assistant proposals remain read-only until output lineage is implemented; existing applied changes retain Undo. Client-composed owner Apply and unidentified legacy origins remain limitations.

Use normal sealed-artifact/service-user preflight, fresh backup and isolated restore gates. Verify migrations and the integrated commit, then check readiness separately from authenticated worker configuration and live owner acceptance. Routine verification uses synthetic providers; no paid verification request is required. This procedure is not a deployment receipt.

## Confirmed target

Current deployment (2026-10-13): the existing VM is Oracle Linux 9.7 ARM64, with two CPUs and 10 GiB RAM. The tested app is running at `https://hub.ecg.name` with PostgreSQL, supervised API, managed HTTPS and daily same-device backups. Isolated backup restore passed. See the [receipt and operating guide](../deploy/oracle-linux/README.md). Owner enrollment and development-data transfer remain pending. The owner deferred encrypted off-host backups.

The Ubuntu/sizing description below remains the original proposal, not the inspected host configuration.

Oracle Cloud Ubuntu Linux VM with 24 GB RAM and 4 OCPUs. Hosted inference initially; no local GPU/model-serving service required. Exact shape, architecture, Ubuntu version, storage, domain, and backup destination remain setup decisions.

Proposed services: HTTPS reverse proxy/static web delivery, application API, PostgreSQL, durable worker, and isolated browser worker when needed. Keep database/browser-control ports private. Use service supervision, bounded concurrency, resource limits, health checks, encrypted off-host backups, and a verified restore procedure. Start browser work with one active job and tune from measurements.

Capacity is a hypothesis for personal use. Benchmark concurrent email import, Canvas refresh, browser fallback, and planner requests before claiming performance.

## CPU and cloud-cost gates

Oracle Ampere A1 is ARM-based. If selected, verify native dependencies, container images, and browser binaries on ARM64. Containers do not remove CPU architecture requirements. [Oracle documentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

Proton officially excludes Linux ARM devices from Bridge support. Keep Bridge on a supported Windows/Linux host with an authenticated connector if the main VM is ARM. An unofficial build is a separate investigation. [Proton requirements](https://proton.me/support/operating-systems-supported-bridge).

Requested sizing is not a guaranteed free entitlement. Oracle's current Always Free page describes 2 OCPUs/12 GB for Always Free tenancies; verify actual account entitlements/pricing before provisioning 4 OCPUs/24 GB. No resources have been provisioned. [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

## Hosted AI content boundary

Allowed: relevant email body text, Canvas page text, user requests, selected planner facts, and approved memory. Parse HTML locally into bounded text, removing credentials and irrelevant content. Treat source text as untrusted.

Excluded: screenshots, images, attachment bytes, attachment-derived text/OCR, and equivalent content through tools, linked resources, memory, embeddings, or third-party MCP servers. Do not ask a remote service to extract an excluded attachment as a workaround. A message's ordinary body is allowed even if it also has attachments.

Enforce this before every model request and at ingestion/retrieval boundaries. Track content origin and invalidate cached context on policy changes. Text-browser automation sends DOM/accessibility descriptions, never visual captures; report workflows that require excluded visual input.

Provider routing is a second permission boundary: relevant text is sent only to providers approved for its sensitivity. Apply [routing rules](ai-permissions.md) before every inference, hosted embedding, or classification request. Being text-only does not make personal text eligible for every provider.

Credentials stay in protected connector storage. Relevant-text processing approval does not authorize screenshots or broad mailbox uploads. External assistants receive scoped approved context without default attachment/image exports.

## Cost strategy

The owner prioritizes low basic-task cost and accepts higher spend for material functionality. This is a preference, not a numeric cap or unlimited spending authority.

- Apply reliable deterministic rules before model calls.
- Process new/changed source data; cache classifications and summaries by content version and policy.
- Batch compatible routine tasks and bound context/output sizes.
- Evaluate inexpensive models on representative synthetic/redacted fixtures.
- Route difficult planning/extraction to stronger models within configured feature limits.
- Choose cheaper/stronger models only from providers allowed for the request's sensitivity. Cost or outage fallback never broadens permissions.
- Meter calls, retries, background work, and tool loops; cap attempts/tokens per job.
- Show spend by feature/provider/model and estimate expensive jobs before execution.
- Support routine and advanced-feature budgets. Set numeric warning/hard limits before paid automation and preserve the planner when limits are reached.

Select models and estimate monthly cost after measuring message volume, text size, refresh frequency, assistant requests, and browser-fallback rate. No model or price guarantee has been made.
