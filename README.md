# MCP tool-loop agent

A minimal AI SDK loop that calls Pollinations MCP tools. Model and tool calls use the caller's Pollen.

1. [Fork this repository](https://github.com/pollinations/pollinations-code-agent-example/fork).
2. In the [staging dashboard](https://staging.enter.pollinations.ai/my-models), choose **Add Agent → Code agent** and enter your fork's URL.
3. Edit `agent.ts`, push, then use **Sync** in the dashboard to deploy the update.

Code agents are currently available on staging. The source repository must be public; the agent itself can be private.

For automatic sync after a push, enable GitHub Actions in your fork and add the repository **variable** `POLLINATIONS_SYNC_URL` with `https://staging.gen.pollinations.ai/account/agents/YOUR_AGENT_ID/sync`. No API key is needed. Without this variable, the workflow skips deployment.

[Agent guide](https://github.com/pollinations/pollinations/blob/main/BUILD_YOUR_OWN_AGENT.md) · [More examples](https://github.com/orgs/pollinations/repositories?q=topic%3Apollinations-code-agent-example)
