import assert from "node:assert/strict";
import test from "node:test";
import agent from "./agent.ts";

const tools = [
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

function message(text: string) {
    return {
        id: `msg_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
    };
}

function call(id: string, tool = "listModels", args = {}) {
    return {
        id: `fc_${id}`,
        type: "function_call",
        status: "completed",
        call_id: id,
        name: `mcp__pollinations__${tool}`,
        arguments: JSON.stringify(args),
    };
}

function modelResponse(output: unknown[], input = 1, generated = 1) {
    return Response.json({
        id: `resp_${crypto.randomUUID()}`,
        object: "response",
        model: "openai/gpt-5.4-nano",
        status: "completed",
        output,
        usage: {
            input_tokens: input,
            output_tokens: generated,
            total_tokens: input + generated,
        },
    });
}

test("runs multiple tool rounds, preserves replay history, and sums model usage", async () => {
    const history = [
        { role: "user", content: "What models are available?" },
        call("previous"),
        {
            id: "result_previous",
            type: "function_call_output",
            call_id: "previous",
            output: '{"content":[{"type":"text","text":"Previous result"}]}',
        },
        { role: "user", content: "Make a cat image using an available model." },
    ];
    const requests: {
        model: string;
        input: { type?: string; call_id?: string }[];
        tools: { name: string }[];
    }[] = [];
    const executed: unknown[] = [];
    const replies = [
        modelResponse([call("models")], 10, 2),
        modelResponse(
            [call("image", "generateImage", { prompt: "a cat" })],
            7,
            3,
        ),
        modelResponse([message("Here is your cat image.")], 9, 8),
    ];
    const mcp = Object.assign(
        async (server: string, tool: string, args: unknown) => {
            executed.push({ server, tool, args });
            return { content: [{ type: "text", text: `${tool} succeeded` }] };
        },
        {
            listTools: async (server: string) => {
                assert.equal(server, "pollinations");
                return tools;
            },
        },
    );
    const response = await agent({
        request: new Request("https://agent.test/v1/responses", {
            method: "POST",
            body: JSON.stringify({ input: history }),
        }),
        pollinations: async (path, init) => {
            assert.equal(path, "/v1/responses");
            requests.push(JSON.parse(String(init?.body)));
            const reply = replies.shift();
            assert.ok(reply, "unexpected extra model call");
            return reply;
        },
        mcp,
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "completed");
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[0].input, history);
    assert.equal(requests[0].model, "openai/gpt-5.4-nano");
    assert.deepEqual(
        requests[0].tools.map((tool: { name: string }) => tool.name),
        ["mcp__pollinations__listModels", "mcp__pollinations__generateImage"],
    );
    assert.deepEqual(executed, [
        { server: "pollinations", tool: "listModels", args: {} },
        {
            server: "pollinations",
            tool: "generateImage",
            args: { prompt: "a cat" },
        },
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
        assert.equal(typeof pair[1].output, "string");
        assert.ok(JSON.parse(pair[1].output).content);
    }
    assert.equal(result.usage.input_tokens, 26);
    assert.equal(result.usage.output_tokens, 13);
    assert.equal(result.usage.total_tokens, 39);
    assert.ok(
        requests[2].input.some(
            (item) =>
                item.call_id === "image" &&
                item.type === "function_call_output",
        ),
    );
});

test("feeds MCP exceptions back to the model as tool failures", async () => {
    let turns = 0;
    const response = await agent({
        request: new Request("https://agent.test/v1/responses", {
            method: "POST",
            body: JSON.stringify({ input: "Make an image." }),
        }),
        pollinations: async (_path, init) => {
            if (turns++ === 0)
                return modelResponse([
                    call("broken", "generateImage", { prompt: "a cat" }),
                ]);
            const body = JSON.parse(String(init?.body));
            const feedback = body.input.find(
                (item: { type: string }) =>
                    item.type === "function_call_output",
            );
            assert.ok(feedback, "the model must receive the tool failure");
            const result = JSON.parse(feedback.output);
            assert.equal(result.isError, true);
            assert.match(feedback.output, /image service unavailable/);
            return modelResponse([
                message("The image service is unavailable."),
            ]);
        },
        mcp: Object.assign(
            async () => {
                throw new Error("image service unavailable");
            },
            { listTools: async () => tools },
        ),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "completed");
    assert.equal(turns, 2);
    assert.equal(
        result.output.at(-1).content[0].text,
        "The image service is unavailable.",
    );
});

test("executes at most eight tools and disables further tool selection", async () => {
    let executions = 0;
    let turns = 0;
    const response = await agent({
        request: new Request("https://agent.test/v1/responses", {
            method: "POST",
            body: JSON.stringify({ input: "Check the models repeatedly." }),
        }),
        pollinations: async (_path, init) => {
            if (turns++ === 0)
                return modelResponse(
                    Array.from({ length: 8 }, (_, index) =>
                        call(`call_${index}`),
                    ),
                );
            assert.equal(turns, 2, "the budget must terminate the tool loop");
            const body = JSON.parse(String(init?.body));
            assert.equal(body.tool_choice, "none");
            const outputs = body.input.filter(
                (item: { type: string }) =>
                    item.type === "function_call_output",
            );
            assert.equal(
                outputs.length,
                8,
                "every call must have a result for valid history",
            );
            return modelResponse([message("Finished within the tool budget.")]);
        },
        mcp: Object.assign(
            async () => {
                executions++;
                return { content: [{ type: "text", text: "ok" }] };
            },
            { listTools: async () => tools },
        ),
    });
    assert.equal(response.status, 200);
    assert.equal(executions, 8);
    assert.equal((await response.json()).status, "completed");
});

test("rejects an oversized tool batch before any tool executes", async () => {
    let executions = 0;
    const response = await agent({
        request: new Request("https://agent.test/v1/responses", {
            method: "POST",
            body: JSON.stringify({ input: "Check the models repeatedly." }),
        }),
        pollinations: async () =>
            modelResponse(
                Array.from({ length: 9 }, (_, index) => call(`call_${index}`)),
            ),
        mcp: Object.assign(
            async () => {
                executions++;
            },
            { listTools: async () => tools },
        ),
    });
    assert.equal(response.status, 502);
    assert.equal(executions, 0);
    const result = await response.json();
    assert.equal(result.status, "failed");
    assert.match(result.error.message, /8-tool-call limit/);
});

test("returns a failed Responses object for a nonstream model HTTP error", async () => {
    const response = await agent({
        request: new Request("https://agent.test/v1/responses", {
            method: "POST",
            body: JSON.stringify({ input: "Hello" }),
        }),
        pollinations: async () =>
            new Response("provider unavailable", { status: 429 }),
        mcp: Object.assign(
            async () => {
                throw new Error("No tool should execute");
            },
            { listTools: async () => tools },
        ),
    });
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.object, "response");
    assert.equal(result.status, "failed");
    assert.deepEqual(result.error, {
        code: "agent_error",
        message: "Model request failed (429)",
    });
});

test("streams completed Responses items and one terminal event", async () => {
    let turns = 0;
    const response = await agent({
        request: new Request("https://agent.test/v1/responses", {
            method: "POST",
            body: JSON.stringify({ input: "List the models.", stream: true }),
        }),
        pollinations: async () =>
            turns++ === 0
                ? modelResponse([call("stream_tool")])
                : modelResponse([message("Models listed.")]),
        mcp: Object.assign(
            async () => ({ content: [{ type: "text", text: "model list" }] }),
            { listTools: async () => tools },
        ),
    });
    assert.equal(response.status, 200);
    assert.match(
        response.headers.get("content-type") ?? "",
        /text\/event-stream/,
    );
    const frames = (await response.text()).split("\n\n").filter(Boolean);
    assert.equal(frames.at(-1), "data: [DONE]");
    const events = frames.slice(0, -1).map((frame) => {
        const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "));
        assert.ok(data);
        return JSON.parse(data.slice(6));
    });
    assert.equal(events[0].type, "response.created");
    assert.equal(events.at(-1).type, "response.completed");
    assert.equal(
        events.filter((event) => event.type === "response.completed").length,
        1,
    );
    assert.equal(
        events.some((event) => event.type === "response.output_text.delta"),
        false,
    );
    const terminal = events.at(-1).response;
    const added = events.filter(
        (event) => event.type === "response.output_item.added",
    );
    const done = events.filter(
        (event) => event.type === "response.output_item.done",
    );
    assert.equal(added.length, terminal.output.length);
    assert.deepEqual(
        done.map((event) => event.item),
        terminal.output,
    );
    assert.deepEqual(
        events.map((event) => event.sequence_number),
        events.map((_, index) => index),
    );
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.output.at(-1).content[0].text, "Models listed.");
});

test("ends a failed model stream with response.failed and DONE", async () => {
    const response = await agent({
        request: new Request("https://agent.test/v1/responses", {
            method: "POST",
            body: JSON.stringify({ input: "Hello", stream: true }),
        }),
        pollinations: async () =>
            new Response("provider unavailable", { status: 503 }),
        mcp: Object.assign(
            async () => {
                throw new Error("No tool should execute");
            },
            { listTools: async () => tools },
        ),
    });
    assert.equal(response.status, 200);
    const frames = (await response.text()).split("\n\n").filter(Boolean);
    assert.equal(frames.at(-1), "data: [DONE]");
    const events = frames.slice(0, -1).map((frame) => {
        const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "));
        assert.ok(data);
        return JSON.parse(data.slice(6));
    });
    assert.equal(events[0].type, "response.created");
    assert.equal(events.at(-1).type, "response.failed");
    assert.equal(events.at(-1).response.status, "failed");
    assert.ok(events.at(-1).response.error.message);
    assert.equal(
        events.some((event) => event.type === "response.completed"),
        false,
    );
});
