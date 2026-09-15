import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  completionToResponsesBody,
  createNousReasoningEnvelope,
  decodeNousReasoningEnvelope,
  dispatchNousDirect,
  NOUS_BASE_URL,
  NOUS_GATEWAY_MODEL,
  NOUS_MODEL_SLUG,
  NOUS_PROVIDER_ID,
  NOUS_UPSTREAM_MODEL,
  toNousChatRequest,
} from "../src/nous-direct.mjs";

const MODEL = NOUS_UPSTREAM_MODEL;
const KEY = "test-internal-service-key-with-sufficient-length";
const MODEL_BINDING = {
  slug: NOUS_MODEL_SLUG,
  gatewayModel: NOUS_GATEWAY_MODEL,
  provider: NOUS_PROVIDER_ID,
  upstreamModel: MODEL,
};
const PROVIDER_BINDING = {
  id: NOUS_PROVIDER_ID,
  kind: "openai-compatible",
  protocol: "openai-responses",
  responseAdapter: "nous-chat",
  baseUrl: NOUS_BASE_URL,
};
const TEST_LOCK_CACHE_HOME = mkdtempSync(path.join(os.tmpdir(), "codex-router-nous-lock-custom-"));
const ORIGINAL_XDG_CACHE_HOME = process.env.XDG_CACHE_HOME;

test.before(() => {
  process.env.XDG_CACHE_HOME = TEST_LOCK_CACHE_HOME;
});

test.after(() => {
  if (ORIGINAL_XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = ORIGINAL_XDG_CACHE_HOME;
  rmSync(TEST_LOCK_CACHE_HOME, { recursive: true, force: true });
});

function completion(message) {
  return {
    id: "chatcmpl_custom_test",
    created: 42,
    model: MODEL,
    choices: [{
      index: 0,
      message,
      finish_reason: message.tool_calls?.length ? "tool_calls" : "stop",
    }],
  };
}

function mixedCompletion(options = {}) {
  const reasoning = Object.hasOwn(options, "reasoning") ? options.reasoning : "provider reasoning";
  const details = Object.hasOwn(options, "details") ? options.details : [{ type: "reasoning.text", text: "detail" }];
  const customArguments = '{\n  "input" : "line\\n\\\"quoted\\\\value"\n}';
  const functionArguments = '{ "path" : "/tmp/a",  "count" : 1 }';
  return {
    completion: completion({
      role: "assistant",
      content: "tool preface",
      ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
      ...(details === undefined ? {} : { reasoning_details: details }),
      tool_calls: [
        { id: "custom-call", type: "function", function: { name: "grammar_tool", arguments: customArguments } },
        { id: "function-call", type: "function", function: { name: "write_file", arguments: functionArguments } },
      ],
    }),
    customArguments,
    functionArguments,
  };
}

function responseFor(options = {}) {
  const source = mixedCompletion(options);
  const body = JSON.parse(completionToResponsesBody(
    source.completion,
    MODEL,
    false,
    {
      internalKey: KEY,
      toolNames: ["grammar_tool", "write_file"],
      customToolNames: ["grammar_tool"],
    },
  ).body);
  return { ...source, body };
}

function replayInput(body, {
  customInput = body.output.find((item) => item.type === "custom_tool_call")?.input,
  functionArguments = body.output.find((item) => item.type === "function_call")?.arguments,
  customOutput = "custom result",
  functionOutput = "function result",
  includeAssistant = false,
  assistantContent,
} = {}) {
  const reasoning = body.output.find((item) => item.type === "reasoning");
  const assistant = body.output.find((item) => item.type === "message");
  const customCall = body.output.find((item) => item.type === "custom_tool_call");
  const functionCall = body.output.find((item) => item.type === "function_call");
  const visibleAssistant = assistantContent === undefined || !assistant
    ? assistant
    : {
        ...assistant,
        content: [{ type: "output_text", text: assistantContent, annotations: [] }],
      };
  return [
    reasoning,
    ...(includeAssistant && visibleAssistant ? [visibleAssistant] : []),
    { ...customCall, input: customInput },
    { ...functionCall, arguments: functionArguments },
    { type: "custom_tool_call_output", call_id: customCall.call_id, output: customOutput },
    { type: "function_call_output", call_id: functionCall.call_id, output: functionOutput },
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
  ];
}

test("custom declarations map to strict Chat functions and preserve grammar metadata", () => {
  const chat = toNousChatRequest({
    input: "hello",
    tools: [
      {
        type: "custom",
        name: "plain_tool",
        description: "Accept a short command.",
        format: { type: "text" },
      },
      {
        type: "custom",
        name: "grammar_tool",
        format: { type: "grammar", syntax: "lark", definition: "start: WORD" },
      },
    ],
    tool_choice: { type: "custom", name: "grammar_tool" },
  }, MODEL);
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "grammar_tool" } });
  assert.deepEqual(chat.tools[0].function.parameters, {
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"],
    additionalProperties: false,
  });
  assert.match(chat.tools[0].function.description, /Accept a short command/);
  assert.match(chat.tools[0].function.description, /"type":"text"/);
  assert.match(chat.tools[1].function.description, /"syntax":"lark"/);
  assert.match(chat.tools[1].function.description, /start: WORD/);
  assert.throws(
    () => toNousChatRequest({ input: "hello", tools: [{ type: "web_search_preview" }] }, MODEL),
    /supported function or custom tool/,
  );
});

test("mixed custom/function calls preserve raw arguments, reasoning, details, and typed outputs", () => {
  const { body, customArguments, functionArguments } = responseFor();
  const reasoning = body.output.find((item) => item.type === "reasoning");
  const customCall = body.output.find((item) => item.type === "custom_tool_call");
  const functionCall = body.output.find((item) => item.type === "function_call");
  assert.deepEqual(customCall && {
    type: customCall.type,
    call_id: customCall.call_id,
    name: customCall.name,
    input: customCall.input,
  }, {
    type: "custom_tool_call",
    call_id: "custom-call",
    name: "grammar_tool",
    input: "line\n\"quoted\\value",
  });
  assert.equal(functionCall.arguments, functionArguments);
  assert.match(reasoning.encrypted_content, /^cr-nous-r1:/);

  const customContent = [{ type: "output_text", text: "first" }, { type: "input_text", text: "second" }];
  const chat = toNousChatRequest({
    input: replayInput(body, { customOutput: customContent, includeAssistant: true }),
  }, MODEL, { internalKey: KEY });
  assert.equal(chat.messages[0].content, "tool preface");
  assert.equal(chat.messages[0].reasoning_content, "provider reasoning");
  assert.deepEqual(chat.messages[0].reasoning_details, [{ type: "reasoning.text", text: "detail" }]);
  assert.deepEqual(chat.messages[0].tool_calls, [
    {
      id: "custom-call",
      type: "function",
      function: { name: "grammar_tool", arguments: customArguments },
    },
    {
      id: "function-call",
      type: "function",
      function: { name: "write_file", arguments: functionArguments },
    },
  ]);
  assert.equal(chat.messages[1].content, JSON.stringify(customContent));
  assert.equal(chat.messages[2].content, "function result");
});

test("custom calls with no provider reasoning use an opaque v2 envelope", () => {
  const source = mixedCompletion({ reasoning: undefined, details: undefined });
  const sourceMessage = source.completion.choices[0].message;
  const body = JSON.parse(completionToResponsesBody(
    {
      ...source.completion,
      choices: [{
        ...source.completion.choices[0],
        message: { ...sourceMessage, content: null, tool_calls: [sourceMessage.tool_calls[0]] },
      }],
    },
    MODEL,
    false,
    { internalKey: KEY, toolNames: ["grammar_tool"], customToolNames: ["grammar_tool"] },
  ).body);
  const reasoning = body.output[0];
  assert.equal(reasoning.type, "reasoning");
  assert.deepEqual(reasoning.summary, []);
  const customCall = body.output.find((item) => item.type === "custom_tool_call");
  const chat = toNousChatRequest({
    input: [
      reasoning,
      customCall,
      { type: "custom_tool_call_output", call_id: customCall.call_id, output: "ok" },
    ],
  }, MODEL, { internalKey: KEY });
  assert.equal(Object.hasOwn(chat.messages[0], "reasoning_content"), false);
  assert.equal(chat.messages[0].content, null);
  assert.equal(chat.messages[0].tool_calls[0].function.arguments, source.customArguments);

  const emptyDetails = mixedCompletion({ reasoning: undefined, details: [] });
  const emptyDetailsBody = JSON.parse(completionToResponsesBody(
    emptyDetails.completion,
    MODEL,
    false,
    { internalKey: KEY, toolNames: ["grammar_tool", "write_file"], customToolNames: ["grammar_tool"] },
  ).body);
  assert.deepEqual(emptyDetailsBody.output[0].summary, []);
});

test("custom JSON and SSE responses expose native custom call events", () => {
  const source = responseFor({ reasoning: undefined, details: undefined });
  const sse = completionToResponsesBody(
    source.completion,
    MODEL,
    true,
    { internalKey: KEY, toolNames: ["grammar_tool", "write_file"], customToolNames: ["grammar_tool"] },
  );
  assert.match(sse.body, /event: response.custom_tool_call_input.delta/);
  assert.match(sse.body, /event: response.custom_tool_call_input.done/);
  const added = sse.body.split("\n").find((line) => line.includes('"type":"response.output_item.added"') && line.includes('"type":"custom_tool_call"'));
  assert.ok(added);
  assert.match(added, /"input":""/);
  const done = sse.body.split("\n").find((line) => line.includes('"type":"response.custom_tool_call_input.done"'));
  assert.match(done, /"input":"line\\n/);
  const json = JSON.parse(completionToResponsesBody(
    source.completion,
    MODEL,
    false,
    { internalKey: KEY, toolNames: ["grammar_tool", "write_file"], customToolNames: ["grammar_tool"] },
  ).body);
  assert.equal(json.output.find((item) => item.type === "custom_tool_call").type, "custom_tool_call");
});

test("dispatch passes original custom declarations into completion conversion", async () => {
  const source = mixedCompletion({ reasoning: undefined, details: undefined });
  let requestBody;
  const response = await dispatchNousDirect({
    payload: {
      input: "hello",
      tools: [{ type: "custom", name: "grammar_tool", format: { type: "text" } }],
      reasoning: { effort: "max" },
    },
    model: MODEL_BINDING,
    provider: PROVIDER_BINDING,
    credential: "TEST_NOUS_KEY",
    baseUrl: NOUS_BASE_URL,
    internalKey: KEY,
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        ...source.completion,
        choices: [{ ...source.completion.choices[0], message: { ...source.completion.choices[0].message, tool_calls: [source.completion.choices[0].message.tool_calls[0]] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(requestBody.tools[0].function.name, "grammar_tool");
  const body = await response.json();
  assert.equal(body.output.find((item) => item.type === "custom_tool_call").name, "grammar_tool");
});

test("custom replay rejects missing, tampered, reordered, dropped, or mismatched history", () => {
  const { body } = responseFor();
  const base = replayInput(body);
  const withAssistant = replayInput(body, { includeAssistant: true });
  const cases = [
    {
      label: "visible custom input mismatch",
      input: replayInput(body, { customInput: "tampered", includeAssistant: true }),
      pattern: /visible custom input/,
    },
    {
      label: "visible function argument mismatch",
      input: replayInput(body, { functionArguments: '{"path":"changed"}', includeAssistant: true }),
      pattern: /visible function arguments/,
    },
    {
      label: "dropped call",
      input: [withAssistant[0], withAssistant[1], withAssistant[2], withAssistant[4]],
      pattern: /visible call count/,
    },
    {
      label: "reordered calls",
      input: [withAssistant[0], withAssistant[1], withAssistant[3], withAssistant[2], withAssistant[4], withAssistant[5]],
      pattern: /visible call order/,
    },
    {
      label: "mismatched output type",
      input: [withAssistant[0], withAssistant[1], withAssistant[2], withAssistant[3], { type: "function_call_output", call_id: "custom-call", output: "wrong" }],
      pattern: /mismatched call type/,
    },
  ];
  for (const { label, input, pattern } of cases) {
    assert.throws(() => toNousChatRequest({ input }, MODEL, { internalKey: KEY }), pattern, label);
  }

  const tampered = { ...base[0], encrypted_content: `${base[0].encrypted_content.slice(0, -1)}${base[0].encrypted_content.endsWith("A") ? "B" : "A"}` };
  assert.throws(
    () => toNousChatRequest({ input: [tampered, ...base.slice(1)] }, MODEL, { internalKey: KEY }),
    /authentication failed|malformed/,
  );
  assert.throws(
    () => toNousChatRequest({ input: [base[1], base[3]] }, MODEL, { internalKey: KEY }),
    /missing its authenticated replay sidecar/,
  );
  assert.throws(
    () => toNousChatRequest({ input: [base[0]] }, MODEL, { internalKey: KEY }),
    /orphaned without a visible call group/,
  );
});

test("custom replay rejects dropped or edited assistant prefaces", () => {
  const { body } = responseFor();
  assert.throws(
    () => toNousChatRequest({ input: replayInput(body) }, MODEL, { internalKey: KEY }),
    /requires its visible assistant content/,
  );
  assert.throws(
    () => toNousChatRequest({
      input: replayInput(body, { includeAssistant: true, assistantContent: "edited preface" }),
    }, MODEL, { internalKey: KEY }),
    /visible assistant content/,
  );
});

test("declared custom history cannot downgrade to a legacy function_call without its sidecar", () => {
  const { body } = responseFor({ reasoning: "visible reasoning" });
  const reasoning = body.output.find((item) => item.type === "reasoning");
  const customCall = body.output.find((item) => item.type === "custom_tool_call");
  const downgradedReasoning = { ...reasoning, encrypted_content: undefined };
  const downgradedCall = {
    type: "function_call",
    id: customCall.id,
    status: "completed",
    call_id: customCall.call_id,
    name: customCall.name,
    arguments: JSON.stringify({ input: customCall.input }),
  };
  assert.throws(
    () => toNousChatRequest({
      tools: [{ type: "custom", name: "grammar_tool", format: { type: "text" } }],
      input: [downgradedReasoning, downgradedCall],
    }, MODEL, { internalKey: KEY }),
    /downgraded to function_call without its authenticated replay sidecar/,
  );
});

test("custom replay preserves null and empty assistant content", () => {
  const source = mixedCompletion({ reasoning: undefined, details: undefined });
  const sourceMessage = source.completion.choices[0].message;
  for (const originalContent of [null, ""]) {
    const completionWithContent = {
      ...source.completion,
      choices: [{
        ...source.completion.choices[0],
        message: {
          ...sourceMessage,
          content: originalContent,
          tool_calls: [sourceMessage.tool_calls[0]],
        },
      }],
    };
    const body = JSON.parse(completionToResponsesBody(
      completionWithContent,
      MODEL,
      false,
      { internalKey: KEY, toolNames: ["grammar_tool"], customToolNames: ["grammar_tool"] },
    ).body);
    const reasoning = body.output.find((item) => item.type === "reasoning");
    const customCall = body.output.find((item) => item.type === "custom_tool_call");
    const message = body.output.find((item) => item.type === "message");
    if (originalContent === null) {
      assert.equal(message, undefined);
    } else {
      assert.equal(message.content[0].text, "");
    }
    const noMessageInput = [
      reasoning,
      customCall,
      { type: "custom_tool_call_output", call_id: customCall.call_id, output: "ok" },
    ];
    const noMessageChat = toNousChatRequest({ input: noMessageInput }, MODEL, { internalKey: KEY });
    assert.equal(noMessageChat.messages[0].content, originalContent);
    if (message) {
      const visibleChat = toNousChatRequest({
        input: [
          reasoning,
          message,
          customCall,
          { type: "custom_tool_call_output", call_id: customCall.call_id, output: "ok" },
        ],
      }, MODEL, { internalKey: KEY });
      assert.equal(visibleChat.messages[0].content, originalContent);
    }
  }
});

test("unowned empty reasoning is rejected before it can be silently ignored", () => {
  assert.throws(
    () => toNousChatRequest({ input: [{ type: "reasoning", summary: [] }] }, MODEL),
    /reasoning has no replayable text/,
  );
  assert.throws(
    () => toNousChatRequest({ input: [{ type: "reasoning", content: [{ type: "summary_text", text: "" }] }] }, MODEL),
    /reasoning has no replayable text/,
  );
});

test("provider custom arguments are strict and names remain request-bound", () => {
  const malformed = completion({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "bad", type: "function", function: { name: "custom", arguments: '{"input":"ok","extra":1}' } }],
  });
  assert.throws(
    () => completionToResponsesBody(malformed, MODEL, false, {
      internalKey: KEY,
      toolNames: ["custom"],
      customToolNames: ["custom"],
    }),
    /only input:string/,
  );
  const unknown = completion({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "unknown", type: "function", function: { name: "not_declared", arguments: '{"input":"ok"}' } }],
  });
  assert.throws(
    () => completionToResponsesBody(unknown, MODEL, false, {
      internalKey: KEY,
      toolNames: ["declared"],
      customToolNames: ["declared"],
    }),
    /not requested/,
  );
});

test("v1 reasoning envelopes remain decodable and v2 distinguishes its authenticated sidecar", () => {
  const v1 = createNousReasoningEnvelope({ internalKey: KEY, model: MODEL, text: "old reasoning" });
  const decodedV1 = decodeNousReasoningEnvelope(v1, { internalKey: KEY, expectedModel: MODEL, visibleText: "old reasoning" });
  assert.equal(decodedV1.version, 1);
  assert.equal(decodedV1.toolReplay, undefined);
  const v2 = createNousReasoningEnvelope({
    internalKey: KEY,
    model: MODEL,
    text: "",
    toolReplay: {
      content: null,
      calls: [{
        kind: "custom",
        id: "c",
        type: "function",
        function: { name: "custom", arguments: '{  "input" : "raw" }' },
      }],
    },
  });
  const decodedV2 = decodeNousReasoningEnvelope(v2, { internalKey: KEY, expectedModel: MODEL, visibleText: "" });
  assert.equal(decodedV2.version, 2);
  assert.equal(decodedV2.toolReplay.content, null);
  assert.equal(decodedV2.toolReplay.calls[0].function.arguments, '{  "input" : "raw" }');
  assert.throws(
    () => createNousReasoningEnvelope({ internalKey: KEY, model: MODEL, text: "" }),
    /no replayable text/,
  );
});
