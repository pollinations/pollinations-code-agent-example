const MODEL = "openai/gpt-5.4-nano";
const SERVER = "pollinations";
const MAX_TOOL_CALLS = 8;

type McpTool = {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
};
type AgentContext = {
    request: Request;
    pollinations: (path: string, init?: RequestInit) => Promise<Response>;
    mcp: {
        (server: string, tool: string, args: unknown): Promise<unknown>;
        listTools(server: string): Promise<McpTool[]>;
    };
};
type Item =
    | {
          id: string;
          type: "function_call";
          call_id: string;
          name: string;
          arguments: string;
          status?: string;
      }
    | {
          id: string;
          type: "message" | "reasoning" | "function_call_output";
          [key: string]: unknown;
      };
type Usage = {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
};
type ModelResponse = { status: string; output: Item[]; usage: Usage };

export default async function agent({
    request,
    pollinations,
    mcp,
}: AgentContext) {
    const body = (await request.json()) as {
        input: string | unknown[];
        instructions?: string;
        stream?: boolean;
        [key: string]: unknown;
    };
    const history =
        typeof body.input === "string"
            ? [{ role: "user", content: body.input }]
            : [...body.input];
    const response = {
        id: `resp_${crypto.randomUUID()}`,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "in_progress",
        model: body.model ?? "pollinations-code-agent-example",
        output: [] as Item[],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        error: null as { code: string; message: string } | null,
    };
    const abort = new AbortController();

    async function* run() {
        yield {
            type: "response.created",
            response: { ...response, output: [], usage: null },
        };
        try {
            const available = await mcp.listTools(SERVER);
            const names = new Map(
                available.map((tool) => [
                    `mcp__${SERVER}__${tool.name}`,
                    tool.name,
                ]),
            );
            const tools = available.map((tool) => ({
                type: "function",
                name: `mcp__${SERVER}__${tool.name}`,
                description: tool.description,
                parameters: tool.inputSchema,
                strict: false,
            }));
            let calls = 0;
            while (!abort.signal.aborted) {
                const upstream = await pollinations("/v1/responses", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    signal: abort.signal,
                    body: JSON.stringify({
                        ...body,
                        model: MODEL,
                        input: history,
                        instructions: [
                            "You are a helpful assistant with Pollinations MCP tools. Use tools when needed; report their real results and include generated media links.",
                            body.instructions,
                        ]
                            .filter(Boolean)
                            .join("\n\n"),
                        tools,
                        tool_choice: calls < MAX_TOOL_CALLS ? "auto" : "none",
                        stream: false,
                        store: false,
                    }),
                });
                if (!upstream.ok)
                    throw new Error(
                        `Model request failed (${upstream.status})`,
                    );
                const turn = (await upstream.json()) as ModelResponse;
                if (turn.status !== "completed")
                    throw new Error(`Model response was ${turn.status}`);
                if (!turn.usage)
                    throw new Error("Model response omitted usage");
                response.usage.input_tokens += turn.usage.input_tokens;
                response.usage.output_tokens += turn.usage.output_tokens;
                response.usage.total_tokens += turn.usage.total_tokens;
                const requested = turn.output.filter(
                    (item) => item.type === "function_call",
                );
                if (calls + requested.length > MAX_TOOL_CALLS) {
                    throw new Error(
                        `Agent exceeded its ${MAX_TOOL_CALLS}-tool-call limit`,
                    );
                }
                for (const item of turn.output) yield* append(item);
                if (!requested.length) {
                    response.status = "completed";
                    yield { type: "response.completed", response };
                    return;
                }
                for (const call of requested) {
                    if (abort.signal.aborted) return;
                    calls++;
                    let result: unknown;
                    try {
                        const name = names.get(call.name);
                        if (!name)
                            throw new Error(
                                "Model requested an unavailable tool",
                            );
                        result = await mcp(
                            SERVER,
                            name,
                            JSON.parse(call.arguments),
                        );
                    } catch (error) {
                        result = {
                            content: [
                                {
                                    type: "text",
                                    text:
                                        error instanceof Error
                                            ? error.message
                                            : "Tool call failed",
                                },
                            ],
                            isError: true,
                        };
                    }
                    yield* append({
                        id: `fco_${crypto.randomUUID()}`,
                        type: "function_call_output",
                        call_id: call.call_id,
                        output: JSON.stringify(result),
                        status: "completed",
                    });
                }
            }
        } catch (error) {
            response.status = "failed";
            response.error = {
                code: "agent_error",
                message:
                    error instanceof Error ? error.message : "Agent failed",
            };
            yield { type: "response.failed", response };
        }
    }

    function* append(item: Item) {
        const output_index = response.output.length;
        history.push(item);
        response.output.push(item);
        yield { type: "response.output_item.added", output_index, item };
        yield { type: "response.output_item.done", output_index, item };
    }

    const events = run();
    if (!body.stream) {
        for await (const _event of events) {
            /* Consume the same loop without streaming. */
        }
        return Response.json(response, {
            status: response.status === "failed" ? 502 : 200,
        });
    }
    const encoder = new TextEncoder();
    let sequence_number = 0;
    return new Response(
        new ReadableStream({
            async pull(controller) {
                const { value, done } = await events.next();
                if (done) {
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                } else {
                    controller.enqueue(
                        encoder.encode(
                            `event: ${value.type}\ndata: ${JSON.stringify({ ...value, sequence_number: sequence_number++ })}\n\n`,
                        ),
                    );
                }
            },
            async cancel() {
                abort.abort();
                await events.return();
            },
        }),
        {
            headers: {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
            },
        },
    );
}
