# Agent Instructions

## Subagent Preferences

- Use OpenCode with MiMo V2.6 Flash (`opencode/mimo-v2.6-flash-free`), or another available free model, for delegated subagent work.
- Use subagents frequently for useful, well-scoped tasks that can run in parallel; keep immediate blocking work local and avoid duplicating delegated work.
- Do not default to a single subagent. When work has independent parts, spawn multiple subagents in parallel and give each a smaller, concrete task with a distinct scope. For code changes, use disjoint file ownership to avoid conflicting edits.
- Discover available providers and models through the orchestration capabilities before choosing a subagent model.
- If a subagent encounters a regional block, cancel that subagent and restart the task with a different available model. Do not keep retrying the blocked model.
- Review and validate subagent results before integrating them, and report any remaining limitations.
