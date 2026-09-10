type AgentContext = {
    request: Request;
    pollinations: (path: string, init?: RequestInit) => Promise<Response>;
};

type ResponsesRequest = {
    input?: string | Array<unknown>;
};

export default async function agent({
    request,
    pollinations,
}: AgentContext): Promise<Response> {
    const input = (await request.json()) as ResponsesRequest;
    const models = await pollinations("/v1/models");
    if (!models.ok) {
        return Response.json(
            { error: { message: "Could not list Pollinations models" } },
            { status: 502 },
        );
    }
    const catalog = (await models.json()) as { data?: Array<unknown> };
    const text = `TypeScript code agent received ${JSON.stringify(input.input)} and can see ${catalog.data?.length ?? 0} models.`;

    return Response.json({
        id: `resp_${crypto.randomUUID()}`,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: "pollinations-code-agent-example",
        output: [
            {
                id: `msg_${crypto.randomUUID()}`,
                type: "message",
                status: "completed",
                role: "assistant",
                content: [
                    {
                        type: "output_text",
                        text,
                        annotations: [],
                    },
                ],
            },
        ],
        usage: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
        },
    });
}
