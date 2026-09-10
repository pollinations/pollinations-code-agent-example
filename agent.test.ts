import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const repo = process.env.POLLINATIONS_REPO;
assert.ok(
    repo,
    "Set POLLINATIONS_REPO to the code-agents Pollinations checkout.",
);
const require = createRequire(path.join(repo, "package.json"));
const { build } = require("esbuild");
const OpenAI = require("openai").default;
const { outputFiles } = await build({
    stdin: {
        contents: `
import agent from ${JSON.stringify(path.join(import.meta.dirname, "agent.ts"))};
import createWorker from ${JSON.stringify(path.join(repo, "enter.pollinations.ai/src/services/code-agent-runtime.js"))};
export { responsesToChatStream } from ${JSON.stringify(path.join(repo, "gen.pollinations.ai/src/text/responses/chatResponse.ts"))};
export const worker = createWorker(agent);
`,
        resolveDir: repo,
    },
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfig: path.join(repo, "gen.pollinations.ai/tsconfig.json"),
    nodePaths: [path.join(repo, "node_modules")],
    write: false,
    banner: {
        js: `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(path.join(repo, "package.json"))});`,
    },
    footer: { js: "//# sourceURL=code-agent-example-test-bundle.mjs" },
});
const { worker, responsesToChatStream } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);
const BASE = "https://staging.gen.pollinations.ai";
const TOOLS = [
    {
        name: "listModels",
        description: "List available models",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "generateImage",
        description: "Generate an image",
        inputSchema: {
            type: "object",
            properties: { prompt: { type: "string" } },
            required: ["prompt"],
        },
    },
];

function toolCall(id: string, name = "listModels", args = {}) {
    return {
        id,
        type: "function",
        function: {
            name: `mcp__pollinations__${name}`,
            arguments: JSON.stringify(args),
        },
    };
}

function modelReply(
    message: Record<string, unknown>,
    input = 1,
    output = 1,
    stream = false,
) {
    const base = {
        id: "chatcmpl-example",
        created: 1,
        model: "openai/gpt-5.4-nano",
    };
    const finish_reason = message.tool_calls ? "tool_calls" : "stop";
    const usage = {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: input + output,
    };
    if (!stream) {
        return Response.json({
            ...base,
            object: "chat.completion",
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", ...message },
                    finish_reason,
                },
            ],
            usage,
        });
    }
    const calls = message.tool_calls as
        | ReturnType<typeof toolCall>[]
        | undefined;
    const delta = {
        role: "assistant",
        ...message,
        ...(calls && {
            tool_calls: calls.map((call, index) => ({ index, ...call })),
        }),
    };
    const chunks = [
        {
            ...base,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta, finish_reason: null }],
        },
        {
            ...base,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason }],
            usage,
        },
    ];
    return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
    );
}

function request(input: unknown, stream = false) {
    return new Request(`${BASE}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            model: "voodoohop/pollinations-code-agent-example",
            input,
            stream,
            max_output_tokens: 123,
        }),
    });
}

function events(text: string) {
    return text
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map((line) => JSON.parse(line.slice(6)));
}

test("real SDK loops through MCP, preserves replay, and sums every model turn", async (t) => {
    const messages: {
        model: string;
        max_tokens: number;
        messages: { tool_call_id?: string }[];
    }[] = [];
    const executed: unknown[] = [];
    const replies = [
        {
            message: { content: null, tool_calls: [toolCall("models")] },
            input: 10,
            output: 2,
        },
        {
            message: {
                content: null,
                tool_calls: [
                    toolCall("image", "generateImage", { prompt: "a cat" }),
                ],
            },
            input: 7,
            output: 3,
        },
        {
            message: { content: "Here is your cat image." },
            input: 9,
            output: 8,
        },
    ];
    t.mock.method(
        globalThis,
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const incoming = new Request(input, init);
            const body = await incoming.json();
            if (incoming.url === `${BASE}/mcp/pollinations`) {
                if (body.method === "tools/list")
                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: { tools: TOOLS },
                    });
                assert.equal(body.method, "tools/call");
                executed.push(body.params);
                return Response.json({
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {
                        content: [
                            {
                                type: "text",
                                text: `${body.params.name} succeeded`,
                            },
                        ],
                    },
                });
            }
            assert.equal(incoming.url, `${BASE}/v1/chat/completions`);
            messages.push(body);
            const reply = replies.shift();
            assert.ok(reply, "unexpected extra model call");
            return modelReply(
                reply.message,
                reply.input,
                reply.output,
                body.stream,
            );
        },
    );
    const response = await worker.fetch(
        request([
            { role: "user", content: "What models are available?" },
            {
                type: "function_call",
                id: "fc_previous",
                call_id: "previous",
                name: "mcp__pollinations__listModels",
                arguments: "{}",
                status: "completed",
            },
            {
                type: "function_call_output",
                id: "fco_previous",
                call_id: "previous",
                output: '{"content":[{"type":"text","text":"Previous result"}]}',
                status: "completed",
            },
            {
                role: "user",
                content: "Make a cat image using an available model.",
            },
        ]),
        { POLLINATIONS_BASE_URL: BASE },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.status, "completed");
    assert.equal(messages.length, 3);
    assert.equal(messages[0].model, "openai/gpt-5.4-nano");
    assert.equal(messages[0].max_tokens, 123);
    assert.ok(
        messages[0].messages.some((item) => item.tool_call_id === "previous"),
    );
    assert.deepEqual(executed, [
        { name: "listModels", arguments: {} },
        { name: "generateImage", arguments: { prompt: "a cat" } },
    ]);
    assert.deepEqual(
        result.output.map((item: { type: string }) => item.type),
        [
            "function_call",
            "function_call_output",
            "function_call",
            "function_call_output",
            "message",
        ],
    );
    for (const id of ["models", "image"]) {
        const pair = result.output.filter(
            (item: { call_id?: string }) => item.call_id === id,
        );
        assert.equal(pair.length, 2);
        assert.notEqual(pair[0].id, pair[1].id);
        assert.equal(pair[0].status, "completed");
        assert.equal(pair[1].status, "completed");
        assert.ok(JSON.parse(pair[1].output).content);
    }
    assert.equal(result.usage.input_tokens, 26);
    assert.equal(result.usage.output_tokens, 13);
    assert.equal(result.usage.total_tokens, 39);
});

test("SDK tool streaming works with OpenAI Responses and the Gen Chat adapter", async (t) => {
    let turns = 0;
    t.mock.method(
        globalThis,
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const incoming = new Request(input, init);
            const body = await incoming.json();
            if (incoming.url.endsWith("/mcp/pollinations")) {
                return Response.json({
                    jsonrpc: "2.0",
                    id: body.id,
                    result:
                        body.method === "tools/list"
                            ? { tools: TOOLS }
                            : {
                                  content: [
                                      {
                                          type: "text",
                                          text: "Models available.",
                                      },
                                  ],
                              },
                });
            }
            assert.equal(body.stream, true);
            return modelReply(
                turns++ === 0
                    ? { content: null, tool_calls: [toolCall("stream_tool")] }
                    : { content: "Models listed." },
                10,
                2,
                true,
            );
        },
    );
    const response = await worker.fetch(request("List the models.", true), {
        POLLINATIONS_BASE_URL: BASE,
    });
    assert.equal(response.status, 200);
    assert.match(
        response.headers.get("content-type") ?? "",
        /text\/event-stream/,
    );
    const sse = await response.text();
    const chunks = events(sse);
    assert.equal(chunks[0].type, "response.created");
    assert.equal(chunks.at(-1).type, "response.completed");
    assert.equal(
        chunks.filter((event) => event.type === "response.completed").length,
        1,
    );
    assert.ok(
        chunks.some((event) => event.type === "response.output_text.delta"),
    );
    assert.match(sse, /data: \[DONE\]\n\n$/);
    const client = new OpenAI({
        apiKey: "unused",
        fetch: async () =>
            new Response(sse, {
                headers: { "content-type": "text/event-stream" },
            }),
    });
    const final = await client.responses
        .stream({ model: "example", input: "hi" })
        .finalResponse();
    assert.equal(final.output.at(-1).content[0].text, "Models listed.");
    assert.equal(final.output.length, 3);
    assert.equal(final.usage.total_tokens, 24);
    const chat = events(
        await new Response(
            responsesToChatStream(new Response(sse).body, "example"),
        ).text(),
    );
    assert.equal(
        chat
            .flatMap((chunk) => chunk.choices ?? [])
            .some((choice) => choice.delta?.tool_calls),
        false,
    );
    const text = chat
        .flatMap((chunk) => chunk.choices ?? [])
        .map((choice) => choice.delta?.content ?? "")
        .join("");
    assert.equal(text.split("Models listed.").length - 1, 1);
});

test("MCP failure is fed back to the model for a useful response", async (t) => {
    let turns = 0;
    t.mock.method(
        globalThis,
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const incoming = new Request(input, init);
            const body = await incoming.json();
            if (incoming.url.endsWith("/mcp/pollinations")) {
                return body.method === "tools/list"
                    ? Response.json({
                          jsonrpc: "2.0",
                          id: body.id,
                          result: { tools: TOOLS },
                      })
                    : new Response("unavailable", { status: 503 });
            }
            if (turns++ === 0)
                return modelReply({
                    content: null,
                    tool_calls: [toolCall("failed")],
                });
            assert.match(
                JSON.stringify(body.messages),
                /MCP tool call failed \(503\)/,
            );
            return modelReply({ content: "The tool service is unavailable." });
        },
    );
    const response = await worker.fetch(request("List the models."), {
        POLLINATIONS_BASE_URL: BASE,
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "completed");
    assert.equal(
        result.output.at(-1).content[0].text,
        "The tool service is unavailable.",
    );
    assert.equal(turns, 2);
});

test("model failure does not retry billed requests", async (t) => {
    t.mock.method(console, "error", () => {});
    for (const stream of [false, true]) {
        let turns = 0;
        const mock = t.mock.method(
            globalThis,
            "fetch",
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const incoming = new Request(input, init);
                const body = await incoming.json();
                if (incoming.url.endsWith("/mcp/pollinations"))
                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: { tools: TOOLS },
                    });
                turns++;
                return Response.json(
                    { error: { message: "Provider unavailable" } },
                    { status: 503 },
                );
            },
        );
        const response = await worker.fetch(request("Hello", stream), {
            POLLINATIONS_BASE_URL: BASE,
        });
        if (stream) {
            const chunks = events(await response.text());
            assert.equal(chunks.at(-1).type, "response.failed");
            assert.equal(
                chunks.some((event) => event.type === "response.completed"),
                false,
            );
        } else {
            assert.ok(response.status >= 400);
            assert.match(
                (await response.json()).error.message,
                /Provider unavailable/,
            );
        }
        assert.equal(turns, 1);
        mock.mock.restore();
    }
});

test("reports exhaustion when the SDK stops after five tool-use steps", async (t) => {
    for (const stream of [false, true]) {
        let modelCalls = 0;
        let toolCalls = 0;
        const mock = t.mock.method(
            globalThis,
            "fetch",
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const incoming = new Request(input, init);
                const body = await incoming.json();
                if (incoming.url.endsWith("/mcp/pollinations")) {
                    if (body.method === "tools/list")
                        return Response.json({
                            jsonrpc: "2.0",
                            id: body.id,
                            result: { tools: TOOLS },
                        });
                    toolCalls++;
                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            content: [{ type: "text", text: "Models listed." }],
                        },
                    });
                }
                modelCalls++;
                return modelReply(
                    {
                        content: null,
                        tool_calls: [toolCall(`step_${modelCalls}`)],
                    },
                    1,
                    1,
                    body.stream,
                );
            },
        );
        const response = await worker.fetch(
            request("Keep checking the models.", stream),
            { POLLINATIONS_BASE_URL: BASE },
        );
        const result = stream
            ? events(await response.text()).at(-1).response
            : await response.json();
        assert.equal(modelCalls, 5);
        assert.equal(toolCalls, 5);
        assert.equal(response.status, 200);
        assert.equal(result.status, "incomplete");
        assert.equal(result.incomplete_details.reason, "max_output_tokens");
        assert.match(
            result.output.at(-1).content[0].text,
            /stopping condition without a final answer/,
        );
        assert.equal(result.usage.total_tokens, 10);
        mock.mock.restore();
    }
});
