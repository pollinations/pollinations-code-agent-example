import {
    type LanguageModel,
    stepCountIs,
    type ToolLoopAgentSettings,
    type ToolSet,
} from "ai";

type AgentContext = {
    model: (id: string) => LanguageModel;
    mcp: { tools: (server: string) => Promise<ToolSet> };
    respond: (
        settings: ToolLoopAgentSettings<never, ToolSet>,
    ) => Promise<Response>;
};

export default async function agent({ model, mcp, respond }: AgentContext) {
    return respond({
        model: model("openai/gpt-5.4-nano"),
        instructions:
            "You are a helpful assistant with Pollinations MCP tools. Use tools when needed; report their real results and include generated media links.",
        tools: await mcp.tools("pollinations"),
        stopWhen: stepCountIs(5),
    });
}
