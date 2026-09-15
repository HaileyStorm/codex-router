import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import {
  createNousReasoningEnvelope,
  assertNousDirectCredentialMetadata,
  completionToResponsesBody,
  dispatchNousDirect,
  NOUS_BASE_URL,
  NOUS_GATEWAY_MODEL,
  NOUS_MODEL_SLUG,
  NOUS_PROVIDER_ID,
  NOUS_UPSTREAM_MODEL,
  responsesInputToNousMessages,
  safeNousDirectError,
  toNousChatRequest,
} from "../src/nous-direct.mjs";

function tamperEnvelope(value) {
  const prefixEnd = value.indexOf(":") + 1;
  const bytes = Buffer.from(value.slice(prefixEnd), "base64url");
  bytes[bytes.length - 1] ^= 1;
  return value.slice(0, prefixEnd) + bytes.toString("base64url");
}

const MODEL = {
  slug: NOUS_MODEL_SLUG,
  gatewayModel: NOUS_GATEWAY_MODEL,
  provider: NOUS_PROVIDER_ID,
  upstreamModel: NOUS_UPSTREAM_MODEL,
};
const PROVIDER = {
  id: NOUS_PROVIDER_ID,
  kind: "openai-compatible",
  protocol: "openai-responses",
  responseAdapter: "nous-chat",
  baseUrl: NOUS_BASE_URL,
};
const INTERNAL_ROUTER_KEY = "test-internal-service-key-with-sufficient-length";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const TEST_LOCK_CACHE_HOME = mkdtempSync(path.join(os.tmpdir(), "codex-router-nous-lock-direct-"));
const ORIGINAL_XDG_CACHE_HOME = process.env.XDG_CACHE_HOME;

test.before(() => {
  process.env.XDG_CACHE_HOME = TEST_LOCK_CACHE_HOME;
});

test.after(() => {
  if (ORIGINAL_XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = ORIGINAL_XDG_CACHE_HOME;
  rmSync(TEST_LOCK_CACHE_HOME, { recursive: true, force: true });
});

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  return { server, port: address.port };
}

async function requestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function child(script, env) {
  const processHandle = spawn(process.execPath, [path.join(ROOT, "src", script)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  processHandle.stderr.setEncoding("utf8");
  let errors = "";
  processHandle.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  processHandle.testErrors = () => errors;
  return processHandle;
}

async function waitFor(url, processHandle, headers = {}) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Child exited early (${processHandle.exitCode}): ${processHandle.testErrors()}`);
    }
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${processHandle.testErrors()}`);
}

async function stopChild(processHandle) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  processHandle.kill("SIGTERM");
  await new Promise((resolve) => processHandle.once("exit", resolve));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function isolatedRegistry(directory, baseUrl, credentialOverrides = {}) {
  const target = path.join(directory, "registry.json");
  writeFileSync(
    target,
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: "nous",
          displayName: "Nous Portal Direct",
          kind: "openai-compatible",
          ownedBy: "nous",
          protocol: "openai-responses",
          responseAdapter: "nous-chat",
          baseUrl,
          credential: {
            environment: ["NOUS_API_KEY"],
            environmentOnly: true,
            label: "Nous API key",
            ...credentialOverrides,
          },
        },
      ],
      models: [
        {
          slug: "nous/deepseek/deepseek-v4.1-flash",
          gatewayModel: "nous-deepseek-v4-1-flash",
          upstreamModel: MODEL.upstreamModel,
          provider: "nous",
          listed: false,
          inputModalities: ["text"],
        },
      ],
    }),
  );
  return target;
}

function nousFetchRewritePreload(directory, targetOrigin) {
  const target = path.join(directory, "nous-fetch-rewrite-preload.mjs");
  writeFileSync(
    target,
    [
      `const sourceOrigin = ${JSON.stringify(new URL(NOUS_BASE_URL).origin)};`,
      `const targetOrigin = ${JSON.stringify(targetOrigin)};`,
      "const nativeFetch = globalThis.fetch;",
      "globalThis.fetch = function testOnlyNousFetch(input, init) {",
      "  const raw = input instanceof Request ? input.url : String(input);",
      "  const url = new URL(raw);",
      "  if (url.origin !== sourceOrigin) return nativeFetch(input, init);",
      "  const rewritten = `${targetOrigin}${url.pathname}${url.search}${url.hash}`;",
      "  if (input instanceof Request) return nativeFetch(new Request(rewritten, input), init);",
      "  return nativeFetch(rewritten, init);",
      "};",
      "",
    ].join("\n"),
  );
  return target;
}

function completion(message, overrides = {}) {
  return {
    id: "chatcmpl_nous_test",
    created: 42,
    model: MODEL.upstreamModel,
    choices: [{
      index: 0,
      message,
      finish_reason: Array.isArray(message.tool_calls) && message.tool_calls.length ? "tool_calls" : "stop",
    }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    ...overrides,
  };
}

test("Nous Direct translates exact max-effort request and complete multi-tool replay", () => {
  const firstArguments = '{"path":"/tmp/a","text":"line\\nraw"}';
  const secondArguments = '{"query":"alpha beta"}';
  const firstResult = '{"ok":true,"bytes":12}';
  const secondResult = "RAW RESULT\nWITH NEWLINE";
  const payload = {
    model: "nous-deepseek-v4-1-flash",
    instructions: "Follow the operator's exact request.",
    reasoning: { effort: "max" },
    max_output_tokens: 200000,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "RAW REASONING\nUNCHANGED" }],
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will use both tools." }] },
      { type: "function_call", call_id: "call_1", name: "write_file", arguments: firstArguments },
      { type: "function_call", call_id: "call_2", name: "search", arguments: secondArguments },
      { type: "function_call_output", call_id: "call_1", output: firstResult },
      { type: "function_call_output", call_id: "call_2", output: secondResult },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
    tools: [
      {
        type: "function",
        name: "write_file",
        description: "Write one file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
    tool_choice: { type: "function", name: "write_file" },
    parallel_tool_calls: true,
  };

  const chat = toNousChatRequest(payload, MODEL.upstreamModel);
  assert.equal(chat.model, MODEL.upstreamModel);
  assert.equal(chat.reasoning_effort, "max");
  assert.equal(chat.max_tokens, 131072);
  assert.equal(chat.stream, false);
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "write_file" } });
  assert.equal(chat.parallel_tool_calls, true);
  assert.deepEqual(chat.messages, [
    { role: "system", content: "Follow the operator's exact request." },
    { role: "user", content: "first" },
    {
      role: "assistant",
      content: "I will use both tools.",
      reasoning_content: "RAW REASONING\nUNCHANGED",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "write_file", arguments: firstArguments } },
        { id: "call_2", type: "function", function: { name: "search", arguments: secondArguments } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: firstResult },
    { role: "tool", tool_call_id: "call_2", content: secondResult },
    { role: "user", content: "continue" },
  ]);
  assert.doesNotMatch(JSON.stringify(chat), /tool result unavailable|interrupted or omitted/);
});

test("Nous Direct rejects malformed or unknown replay instead of repairing it", () => {
  assert.throws(
    () => responsesInputToNousMessages([{ type: "unknown_item", value: "must not be dropped" }]),
    /unsupported item type/,
  );
  assert.throws(
    () => responsesInputToNousMessages([
      { type: "function_call", call_id: "call_1", name: "tool", arguments: "{}" },
      {
        type: "agent_message",
        author: "/root",
        recipient: "/root/child",
        content: [{ type: "input_text", text: "skip result" }],
      },
    ]),
    /before all prior tool results/,
  );
  assert.throws(
    () => responsesInputToNousMessages([
      { type: "function_call_output", call_id: "orphan", output: "must not be invented" },
    ]),
    /orphan function_call_output/,
  );
  for (const hostile of ["private-item-type-value", "private-role-value"]) {
    let error;
    try {
      responsesInputToNousMessages([
        hostile.includes("type")
          ? { type: hostile }
          : { type: "message", role: hostile, content: "secret" },
      ]);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.doesNotMatch(error.message, new RegExp(hostile));
  }
  assert.throws(
    () => responsesInputToNousMessages([
      { type: "function_call", call_id: "duplicate", name: "one", arguments: "{}" },
      { type: "function_call", call_id: "duplicate", name: "two", arguments: "{}" },
    ]),
    /repeats a function call id/,
  );
  assert.throws(
    () => toNousChatRequest({ input: "hi", reasoning: { effort: "high" } }, MODEL.upstreamModel),
    /effort max only/,
  );
  assert.throws(
    () => toNousChatRequest({ input: "hi", parallel_tool_calls: "yes" }, MODEL.upstreamModel),
    /parallel_tool_calls must be boolean/,
  );
});

test("Nous Direct preserves normalized agent-message text and provenance as user data", () => {
  const text = "Message Type: NEW_TASK\nPayload:\nUse the exact fixture.";
  const messages = responsesInputToNousMessages([{
    type: "agent_message",
    author: "/root",
    recipient: "/root/nous_desktop_write_acceptance",
    content: [
      { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
      { type: "input_text", text: "Use the exact fixture." },
    ],
  }]);
  assert.deepEqual(messages, [{
    role: "user",
    content: JSON.stringify({
      type: "agent_message",
      author: "/root",
      recipient: "/root/nous_desktop_write_acceptance",
      content: text,
    }),
  }]);
  assert.throws(
    () => responsesInputToNousMessages([{
      type: "agent_message",
      author: "/root",
      recipient: "/root/child",
      content: [
        { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "plaintext must be normalized first" },
      ],
    }]),
    /supported text part/,
  );
  assert.throws(
    () => responsesInputToNousMessages([{
      type: "agent_message",
      author: "/root",
      recipient: "/root/child",
      content: [{ type: "input_image", image_url: "https:\/\/example.invalid\/image" }],
    }]),
    /supported text part/,
  );
  assert.throws(
    () => responsesInputToNousMessages([{
      type: "agent_message",
      author: "/root",
      content: [{ type: "input_text", text: "missing recipient provenance" }],
    }]),
    /author and recipient provenance/,
  );
});

test("Nous Direct safe diagnostics are marker-bound and retain their original snapshot", () => {
  let error;
  try {
    toNousChatRequest({
      input: "hello",
      tools: [{ type: "web_search_preview", name: "raw-secret-tool" }],
    }, MODEL.upstreamModel);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  const expected = {
    status: 400,
    type: "local_nous_direct_error",
    message: "tools[0] is not a supported function or custom tool.",
  };
  assert.deepEqual(safeNousDirectError(error), expected);

  error.message = "raw-secret-message";
  error.status = 599;
  error.code = "nous_direct_invalid_request";
  assert.deepEqual(safeNousDirectError(error), expected);

  const returned = safeNousDirectError(error);
  returned.message = "mutated-copy";
  assert.equal(safeNousDirectError(error).message, expected.message);
  assert.equal(
    safeNousDirectError({
      code: "nous_direct_invalid_request",
      message: "raw-secret-message",
      status: 400,
    }),
    undefined,
  );
  assert.equal(safeNousDirectError(new Error("raw-secret-message")), undefined);
});

test("Nous Direct preserves readable foreign reasoning as assistant context", () => {
  const summaryContext = responsesInputToNousMessages([
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Foreign model summary" }],
      encrypted_content: "gAAAAA-foreign-model-ciphertext",
    },
  ]);
  assert.deepEqual(summaryContext, [{ role: "assistant", content: "Foreign model summary" }]);

  const contentContext = responsesInputToNousMessages([
    {
      type: "reasoning",
      summary: [],
      content: [{ type: "output_text", text: "Readable typed content" }],
      encrypted_content: "gAAAAA-foreign-model-ciphertext",
    },
  ]);
  assert.deepEqual(contentContext, [{ role: "assistant", content: "Readable typed content" }]);

  assert.throws(
    () => responsesInputToNousMessages([{
      type: "reasoning",
      summary: [],
      content: [],
      encrypted_content: "gAAAAA-no-readable-summary",
    }]),
    /fresh task packet/,
  );
});

test("Nous Direct authenticates only its own reasoning envelope prefix", () => {
  const envelope = createNousReasoningEnvelope({
    internalKey: INTERNAL_ROUTER_KEY,
    model: MODEL.upstreamModel,
    text: "Nous-owned reasoning",
  });
  const tampered = tamperEnvelope(envelope);
  assert.throws(
    () => responsesInputToNousMessages([{
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Nous-owned reasoning" }],
      encrypted_content: tampered,
    }], undefined, {
      internalKey: INTERNAL_ROUTER_KEY,
      upstreamModel: MODEL.upstreamModel,
    }),
    /authentication failed|malformed/,
  );
});

test("Nous Direct credential metadata stays environment-only and exact", () => {
  const valid = {
    ...PROVIDER,
    credential: {
      environment: ["NOUS_API_KEY"],
      environmentOnly: true,
      label: "Nous API key",
    },
  };
  assert.equal(assertNousDirectCredentialMetadata(valid).environment[0], "NOUS_API_KEY");
  for (const credential of [
    { ...valid.credential, environmentOnly: false, file: "nous-api-key.secret" },
    { ...valid.credential, environment: ["OTHER_API_KEY"] },
    { ...valid.credential, file: "nous-api-key.secret" },
  ]) {
    assert.throws(
      () => assertNousDirectCredentialMetadata({ ...valid, credential }),
      /environment-only NOUS_API_KEY credential/,
    );
  }
  assert.throws(
    () => assertNousDirectCredentialMetadata({ ...valid, responseAdapter: "openai-chat" }),
    /environment-only NOUS_API_KEY credential/,
  );
});

test("Nous Direct keeps the Responses request contract explicit", () => {
  const omitted = toNousChatRequest({ input: "hello" }, MODEL.upstreamModel);
  assert.equal(omitted.stream, false);
  assert.throws(
    () => toNousChatRequest({ input: "hello", stream: "true" }, MODEL.upstreamModel),
    /stream must be boolean/,
  );
  assert.deepEqual(
    toNousChatRequest({ input: "hello", text: { format: { type: "json_object" } } }, MODEL.upstreamModel)
      .response_format,
    { type: "json_object" },
  );
  assert.deepEqual(
    toNousChatRequest({ input: "hello", response_format: { type: "json_object" } }, MODEL.upstreamModel)
      .response_format,
    { type: "json_object" },
  );
  assert.equal(
    toNousChatRequest({
      input: "hello",
      tools: [{ type: "function", name: "fixture", parameters: { type: "object" }, strict: true }],
    }, MODEL.upstreamModel).tools[0].function.strict,
    true,
  );
  assert.throws(
    () => toNousChatRequest({ input: "hello", text: { format: { type: "json_schema", name: "x", schema: {} } } }, MODEL.upstreamModel),
    /does not support json_schema/,
  );
  assert.throws(
    () => toNousChatRequest({ input: "hello", response_format: { type: "json_object", extra: true } }, MODEL.upstreamModel),
    /json_object format has unsupported fields/,
  );
  assert.throws(
    () => toNousChatRequest({ input: "hello", tool_choice: { type: "function", name: "missing" }, tools: [] }, MODEL.upstreamModel),
    /undeclared function/,
  );
  const manyTools = toNousChatRequest({
    input: "hello",
    tools: Array.from({ length: 17 }, (_, index) => ({
      type: "function",
      name: `tool_${index}`,
      parameters: { type: "object" },
    })),
  }, MODEL.upstreamModel);
  assert.equal(manyTools.tools.length, 17);
  assert.throws(
    () => toNousChatRequest({
      input: "hello",
      tools: [
        { type: "function", name: "duplicate", parameters: { type: "object" } },
        { type: "function", name: "duplicate", parameters: { type: "object" } },
      ],
    }, MODEL.upstreamModel),
    /repeats a function name/,
  );
  assert.throws(
    () => toNousChatRequest({
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        ...Array.from({ length: 17 }, (_, index) => ({
          type: "function_call",
          call_id: `call_${index}`,
          name: "fixture",
          arguments: "{}",
        })),
      ],
    }, MODEL.upstreamModel),
    /more than 16 function calls/,
  );
});

test("Nous Direct preserves returned reasoning, ordered call ids, and raw arguments", () => {
  const argumentsOne = '{"target":"/root/a","payload":"x\\ny"}';
  const argumentsTwo = '{"target":"/root/b"}';
  const adapted = completionToResponsesBody(
    completion({
      role: "assistant",
      content: "tool preface",
      reasoning_content: "PROVIDER RAW REASONING",
      tool_calls: [
        { id: "provider_call_1", type: "function", function: { name: "send", arguments: argumentsOne } },
        { id: "provider_call_2", type: "function", function: { name: "wait", arguments: argumentsTwo } },
      ],
    }),
    MODEL.upstreamModel,
    true,
  );
  assert.equal(adapted.contentType, "text/event-stream; charset=utf-8");
  assert.match(adapted.body, /PROVIDER RAW REASONING/);
  const completedLine = adapted.body
    .split("\n")
    .find((line, index, lines) => lines[index - 1] === "event: response.completed" && line.startsWith("data: "));
  assert.ok(completedLine);
  const output = JSON.parse(completedLine.slice(6)).response.output;
  assert.equal(output[0].type, "reasoning");
  assert.equal(output[0].summary[0].text, "PROVIDER RAW REASONING");
  assert.equal(output[1].type, "message");
  assert.equal(output[1].content[0].text, "tool preface");
  assert.deepEqual(
    output.filter((item) => item.type === "function_call").map((item) => ({
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
    })),
    [
      { call_id: "provider_call_1", name: "send", arguments: argumentsOne },
      { call_id: "provider_call_2", name: "wait", arguments: argumentsTwo },
    ],
  );
});

test("Nous Direct dispatches once to Chat Completions and never invents a Responses upstream", async () => {
  const attempts = [];
  const upstream = completion({ role: "assistant", content: "done", reasoning_content: "raw" });
  const response = await dispatchNousDirect({
    payload: { input: "hello", reasoning: { effort: "max" } },
    model: MODEL,
    provider: PROVIDER,
    credential: "TEST_NOUS_KEY",
    baseUrl: NOUS_BASE_URL,
    internalKey: INTERNAL_ROUTER_KEY,
    fetchImpl: async (url, init) => {
      attempts.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(upstream), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-ratelimit-remaining": "7" },
      });
    },
  });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].url, `${NOUS_BASE_URL}/chat/completions`);
  assert.doesNotMatch(attempts[0].url, /\/responses$/);
  assert.equal(attempts[0].init.redirect, "error");
  assert.equal(attempts[0].body.model, MODEL.upstreamModel);
  assert.equal(attempts[0].body.reasoning_effort, "max");
  assert.equal(attempts[0].body.max_tokens, 131072);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-ratelimit-remaining"), "7");
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.output.find((item) => item.type === "message").content[0].text, "done");
});

test("Nous Direct rejects unsupported built-in tools before any upstream fetch", async () => {
  let attempts = 0;
  let error;
  await assert.rejects(
    dispatchNousDirect({
      payload: {
        input: "hello",
        tools: [{ type: "web_search_preview", name: "raw-secret-tool" }],
      },
      model: MODEL,
      provider: PROVIDER,
      credential: "TEST_NOUS_KEY",
      baseUrl: NOUS_BASE_URL,
      internalKey: INTERNAL_ROUTER_KEY,
      fetchImpl: async () => {
        attempts += 1;
        throw new Error("must not fetch");
      },
    }),
    (caught) => {
      error = caught;
      return true;
    },
  );
  assert.equal(attempts, 0);
  assert.deepEqual(safeNousDirectError(error), {
    status: 400,
    type: "local_nous_direct_error",
    message: "tools[0] is not a supported function or custom tool.",
  });
});

test("Nous Direct rejects returned tools outside the flattened request set", () => {
  assert.throws(
    () => completionToResponsesBody(
      completion({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "provider_call_unknown",
          type: "function",
          function: { name: "not_requested", arguments: "{}" },
        }],
      }),
      MODEL.upstreamModel,
      false,
      { internalKey: INTERNAL_ROUTER_KEY, toolNames: ["requested"] },
    ),
    /tool name that was not requested/,
  );
});

test("Nous Direct fails closed on provider, model, and origin binding mismatches", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    throw new Error("must not fetch");
  };
  const cases = [
    { provider: { ...PROVIDER, id: "other" } },
    { provider: { ...PROVIDER, baseUrl: "https://other.example/v1" } },
    { model: { ...MODEL, upstreamModel: "deepseek/other" } },
    { baseUrl: "https://other.example/v1" },
  ];
  for (const override of cases) {
    await assert.rejects(
      dispatchNousDirect({
        payload: { input: "hello" },
        model: override.model || MODEL,
        provider: override.provider || PROVIDER,
        credential: "TEST_NOUS_KEY",
        baseUrl: override.baseUrl || NOUS_BASE_URL,
        internalKey: INTERNAL_ROUTER_KEY,
        fetchImpl,
      }),
      (error) => error?.code === "nous_direct_binding",
    );
  }
  assert.equal(attempts, 0);
});

test("Nous Direct bounds response bodies before allocating a completion", async () => {
  let attempts = 0;
  await assert.rejects(
    dispatchNousDirect({
      payload: { input: "hello" },
      model: MODEL,
      provider: PROVIDER,
      credential: "TEST_NOUS_KEY",
      baseUrl: NOUS_BASE_URL,
      internalKey: INTERNAL_ROUTER_KEY,
      fetchImpl: async () => {
        attempts += 1;
        return new Response('{"too":"large"}', {
          status: 200,
          headers: { "content-length": String(17 * 1024 * 1024) },
        });
      },
    }),
    /exceeded the local response limit/,
  );
  assert.equal(attempts, 1);
});

test("Nous Direct terminal failures, redirects, transport errors, and empties never retry", async (t) => {
  await t.test("HTTP 402", async () => {
    let attempts = 0;
    const response = await dispatchNousDirect({
      payload: { input: "hello", reasoning: { effort: "max" } },
      model: MODEL,
      provider: PROVIDER,
      credential: "TEST_NOUS_KEY",
      baseUrl: NOUS_BASE_URL,
      internalKey: INTERNAL_ROUTER_KEY,
      fetchImpl: async () => {
        attempts += 1;
        return new Response('{"error":{"message":"credit exhausted"}}', { status: 402 });
      },
    });
    assert.equal(attempts, 1);
    assert.equal(response.status, 402);
  });

  await t.test("error body finishes before the next attempt enters fetch", async () => {
    let enteredFirst;
    const firstEntered = new Promise(resolve => { enteredFirst = resolve; });
    let finishBody;
    let secondEntered = false;
    const common = { payload: { input: "hello" }, model: MODEL, provider: PROVIDER,
      credential: "TEST_NOUS_KEY", baseUrl: NOUS_BASE_URL, internalKey: INTERNAL_ROUTER_KEY };
    const first = dispatchNousDirect({ ...common, fetchImpl: async () => {
      const body = new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":"quota"}'));
        finishBody = () => controller.close();
      } });
      enteredFirst();
      return new Response(body, { status: 402 });
    } });
    await firstEntered;
    const second = dispatchNousDirect({ ...common, fetchImpl: async () => {
      secondEntered = true;
      return new Response('{"error":"quota"}', { status: 402 });
    } });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(secondEntered, false);
    } finally { finishBody(); }
    const [a, b] = await Promise.all([first, second]);
    assert.equal(await a.text(), '{"error":"quota"}');
    assert.equal(b.status, 402);
    assert.equal(secondEntered, true);
  });

  await t.test("redirect", async () => {
    let attempts = 0;
    const response = await dispatchNousDirect({
      payload: { input: "hello", reasoning: { effort: "max" } },
      model: MODEL,
      provider: PROVIDER,
      credential: "TEST_NOUS_KEY",
      baseUrl: NOUS_BASE_URL,
      internalKey: INTERNAL_ROUTER_KEY,
      fetchImpl: async (_url, init) => {
        attempts += 1;
        assert.equal(init.redirect, "error");
        return new Response(null, { status: 307, headers: { Location: "https://other.invalid/v1" } });
      },
    });
    assert.equal(attempts, 1);
    assert.equal(response.status, 307);
  });

  await t.test("transport error", async () => {
    let attempts = 0;
    await assert.rejects(
      dispatchNousDirect({
        payload: { input: "hello", reasoning: { effort: "max" } },
        model: MODEL,
        provider: PROVIDER,
        credential: "TEST_NOUS_KEY",
        baseUrl: NOUS_BASE_URL,
        internalKey: INTERNAL_ROUTER_KEY,
        fetchImpl: async () => {
          attempts += 1;
          throw new TypeError("fetch failed");
        },
      }),
      /fetch failed/,
    );
    assert.equal(attempts, 1);
  });

  await t.test("empty completion", async () => {
    let attempts = 0;
    await assert.rejects(
      dispatchNousDirect({
        payload: { input: "hello", reasoning: { effort: "max" } },
        model: MODEL,
        provider: PROVIDER,
        credential: "TEST_NOUS_KEY",
        baseUrl: NOUS_BASE_URL,
        internalKey: INTERNAL_ROUTER_KEY,
        fetchImpl: async () => {
          attempts += 1;
          return new Response(JSON.stringify(completion({ role: "assistant", content: null })), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
      (error) => error?.status === 502 && error?.code === "nous_direct_empty_completion",
    );
    assert.equal(attempts, 1);
  });
});

test("Nous Direct validates exact response identity, finish state, and reasoning variants", () => {
  assert.throws(
    () => completionToResponsesBody(
      completion({ role: "assistant", content: "wrong model" }, { model: "deepseek/other" }),
      MODEL.upstreamModel,
      false,
    ),
    /model identity/,
  );
  for (const finishReason of ["length", "content_filter", null]) {
    const payload = completion({ role: "assistant", content: "partial" });
    payload.choices[0].finish_reason = finishReason;
    assert.throws(
      () => completionToResponsesBody(payload, MODEL.upstreamModel, false),
      /finish reason/,
    );
  }
  const reasoningPayload = completion({
    role: "assistant",
    content: "done",
    reasoning: "RAW reasoning alternative",
  });
  const reasoningResponse = JSON.parse(
    completionToResponsesBody(reasoningPayload, MODEL.upstreamModel, false).body,
  );
  assert.equal(reasoningResponse.output[0].summary[0].text, "RAW reasoning alternative");
  const reasoningDetails = [{ type: "reasoning.text", text: "opaque provider detail" }];
  const detailResponse = JSON.parse(
    completionToResponsesBody(
      completion({
        role: "assistant",
        content: "done",
        reasoning_content: "visible replay text",
        reasoning_details: reasoningDetails,
      }),
      MODEL.upstreamModel,
      false,
      { internalKey: INTERNAL_ROUTER_KEY },
    ).body,
  );
  assert.equal(detailResponse.output[0].reasoning_details, undefined);
  assert.match(detailResponse.output[0].encrypted_content, /^cr-nous-r1:/);
  const nativeSerdeReasoning = JSON.parse(JSON.stringify({
    type: detailResponse.output[0].type,
    id: detailResponse.output[0].id,
    status: detailResponse.output[0].status,
    summary: detailResponse.output[0].summary,
    encrypted_content: detailResponse.output[0].encrypted_content,
  }));
  const replay = toNousChatRequest({
    input: [
      nativeSerdeReasoning,
      { type: "function_call", call_id: "call_detail", name: "fixture", arguments: "{}" },
      { type: "function_call_output", call_id: "call_detail", output: "fixture-result" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
    reasoning: { effort: "max" },
  }, MODEL.upstreamModel, { internalKey: INTERNAL_ROUTER_KEY });
  assert.deepEqual(replay.messages[0].reasoning_details, reasoningDetails);
  assert.throws(
    () => toNousChatRequest({
      input: [{
        type: "reasoning",
        summary: [{ type: "summary_text", text: "tampered visible summary" }],
        encrypted_content: nativeSerdeReasoning.encrypted_content,
      }, { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }],
    }, MODEL.upstreamModel, { internalKey: INTERNAL_ROUTER_KEY }),
    /disagrees with its visible summary/,
  );
  assert.throws(
    () => toNousChatRequest({
      input: [{
        type: "reasoning",
        summary: [{ type: "summary_text", text: "visible replay text" }],
        encrypted_content: tamperEnvelope(nativeSerdeReasoning.encrypted_content),
      }, { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }],
    }, MODEL.upstreamModel, { internalKey: INTERNAL_ROUTER_KEY }),
    /authentication failed|malformed/,
  );
  assert.throws(
    () => completionToResponsesBody(
      completion({
        role: "assistant",
        content: "done",
        reasoning_content: "one",
        reasoning: "two",
      }),
      MODEL.upstreamModel,
      false,
    ),
    /ambiguous plaintext reasoning fields/,
  );
});

test("API forwarder refuses a noncanonical Nous origin before attaching the provider key", async () => {
  const requests = [];
  const upstream = await mockServer(async (request, response) => {
    requests.push({ url: request.url, headers: request.headers, body: await requestJson(request) });
    const body = JSON.stringify(
      completion({ role: "assistant", content: "adapter ok", reasoning_content: "raw provider thought" }),
    );
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) });
    response.end(body);
  });
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "nous-forwarder-"));
  const port = await openPort();
  const forwarder = child("api-forwarder.mjs", {
    MODEL_ROUTER_REGISTRY: isolatedRegistry(testRoot, `http://127.0.0.1:${upstream.port}/v1`),
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
    CODEX_ROUTER_API_PORT: String(port),
    CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
    NOUS_API_KEY: "TEST_NOUS_ENVIRONMENT_ONLY_KEY",
    CODEX_ROUTER_QUIET: "1",
  });
  try {
    await waitFor(`http://127.0.0.1:${port}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "responses/nous-deepseek-v4-1-flash",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
        stream: true,
        reasoning: { effort: "max" },
      }),
    });
    assert.equal(response.status, 400, forwarder.testErrors());
    assert.equal(requests.length, 0, "binding failure must not reach the upstream origin");
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("API forwarder rejects file-backed Nous metadata before credential lookup or fetch", async () => {
  const requests = [];
  const upstream = await mockServer(async (request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(completion({ role: "assistant", content: "must not reach upstream" })));
  });
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "nous-forwarder-metadata-"));
  const stateDir = path.join(testRoot, "state");
  mkdirSync(path.join(stateDir, "nous-api-key.secret"), { recursive: true, mode: 0o700 });
  const port = await openPort();
  const forwarder = child("api-forwarder.mjs", {
    MODEL_ROUTER_REGISTRY: isolatedRegistry(
      testRoot,
      `http://127.0.0.1:${upstream.port}/v1`,
      { environmentOnly: undefined, file: "nous-api-key.secret" },
    ),
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_API_PORT: String(port),
    CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
    NOUS_API_KEY: "",
    CODEX_ROUTER_QUIET: "1",
  });
  try {
    await waitFor(`http://127.0.0.1:${port}/models`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "responses/nous-deepseek-v4-1-flash",
        input: "hello",
      }),
    });
    assert.equal(response.status, 400, forwarder.testErrors());
    assert.equal(requests.length, 0, "credential metadata failure must not reach the upstream origin");
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("API forwarder surfaces actionable local Nous validation errors", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "nous-forwarder-validation-"));
  const port = await openPort();
  const forwarder = child("api-forwarder.mjs", {
    MODEL_ROUTER_REGISTRY: isolatedRegistry(testRoot, NOUS_BASE_URL),
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
    CODEX_ROUTER_API_PORT: String(port),
    CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
    NOUS_API_KEY: "TEST_NOUS_ENVIRONMENT_ONLY_KEY",
    CODEX_ROUTER_QUIET: "1",
  });
  try {
    await waitFor(`http://127.0.0.1:${port}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "responses/nous-deepseek-v4-1-flash",
        input: "hello",
        tools: [{ type: "web_search_preview", name: "raw-secret-tool" }],
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 400, forwarder.testErrors());
    assert.equal(body.error.type, "local_nous_direct_error");
    assert.equal(body.error.message, "tools[0] is not a supported function or custom tool.");
    assert.doesNotMatch(JSON.stringify(body), /raw-secret-tool/);
  } finally {
    await stopChild(forwarder);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("API forwarder turns Nous retry-shaped failures into one-contact terminal 400s", async () => {
  const requests = [];
  let upstreamStatus = 200;
  const upstream = await mockServer(async (request, response) => {
    requests.push({ url: request.url, body: await requestJson(request) });
    if (upstreamStatus !== 200) {
      const body = '{"error":"provider body"}';
      response.writeHead(upstreamStatus, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      });
      response.end(body);
      return;
    }
    const body = JSON.stringify(completion({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "unexpected-call",
        type: "function",
        function: { name: "not_requested", arguments: "{}" },
      }],
    }));
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    });
    response.end(body);
  });
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "nous-forwarder-terminal-"));
  const port = await openPort();
  const preload = nousFetchRewritePreload(testRoot, `http://127.0.0.1:${upstream.port}`);
  const forwarder = child("api-forwarder.mjs", {
    MODEL_ROUTER_REGISTRY: isolatedRegistry(testRoot, NOUS_BASE_URL),
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
    CODEX_ROUTER_API_PORT: String(port),
    CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
    NOUS_API_KEY: "TEST_NOUS_ENVIRONMENT_ONLY_KEY",
    CODEX_ROUTER_QUIET: "1",
    NODE_OPTIONS: `--import=${preload}`,
  });
  const bodyFor = (toolName = "requested") => ({
    model: "responses/nous-deepseek-v4-1-flash",
    input: "hello",
    reasoning: { effort: "max" },
    tools: [{
      type: "function",
      name: toolName,
      description: "Synthetic test tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    }],
  });
  try {
    await waitFor(`http://127.0.0.1:${port}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    const validationResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyFor()),
    });
    const validationBody = await validationResponse.json();
    assert.equal(validationResponse.status, 400, forwarder.testErrors());
    assert.deepEqual(validationBody.error, {
      type: "local_nous_direct_terminal",
      message: "Nous Direct returned an invalid response; automatic retry is disabled.",
      retryable: false,
      original_status: 502,
      original_class: "local_nous_direct_error",
    });
    assert.equal(requests.length, 1, "response validation failure must contact Nous once");
    assert.doesNotMatch(JSON.stringify(validationBody), /provider body|not_requested/);

    for (const status of [429, 503]) {
      upstreamStatus = status;
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INTERNAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodyFor(`requested_${status}`)),
      });
      const terminal = await response.json();
      assert.equal(response.status, 400, forwarder.testErrors());
      assert.equal(terminal.error.type, "local_nous_direct_terminal");
      assert.equal(terminal.error.original_status, status, JSON.stringify(terminal));
      assert.equal(terminal.error.original_class, "nous_upstream_http_error");
      assert.equal(terminal.error.retryable, false);
      assert.doesNotMatch(JSON.stringify(terminal), /provider body/);
      assert.equal(requests.length, status === 429 ? 2 : 3, "upstream retry-shaped failure must contact Nous once");
    }
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("router leaves Nous reasoning intact, flattens namespace tools, and cannot retry an empty turn", async () => {
  const gatewayRequests = [];
  const emptySse = [
    'event: response.created',
    'data: {"type":"response.created","sequence_number":0,"response":{"id":"empty"}}',
    "",
    'event: response.completed',
    'data: {"type":"response.completed","sequence_number":1,"response":{"id":"empty","output":[]}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    gatewayRequests.push(await requestJson(request));
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.end(emptySse);
  });
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "nous-router-"));
  const stateDir = path.join(testRoot, "state");
  const port = await openPort();
  const router = child("router.mjs", {
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_PORT: String(port),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
    CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
    CODEX_ROUTER_SHOW_ALL_MODELS: "1",
    CODEX_ROUTER_EMPTY_COMPLETION_RETRY: "1",
    NOUS_API_KEY: "TEST_NOUS_ENVIRONMENT_ONLY_KEY",
    CODEX_ROUTER_QUIET: "1",
  });
  const reasoning = {
    type: "reasoning",
    summary: [{ type: "summary_text", text: "EXACT REASONING" }],
  };
  try {
    await waitFor(`${callerBaseUrl(port, CALLER_KEY)}/models`, router);
    const response = await fetch(`${callerBaseUrl(port, CALLER_KEY)}/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer caller-session", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "nous/deepseek/deepseek-v4.1-flash",
        stream: true,
        reasoning: { effort: "max" },
        input: [
          reasoning,
          { type: "function_call", call_id: "call_history", name: "send_message", namespace: "collaboration", arguments: '{"target":"/root"}' },
          { type: "function_call_output", call_id: "call_history", output: "sent" },
          { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
          { type: "agent_message", author: "/root", recipient: "/root/synthetic-child", content: [
            { type: "input_text", text: "Message Type: NEW_TASK\nSender: /root\nPayload:\n" },
            { type: "encrypted_content", encrypted_content: "SYNTHETIC_TASK_PAYLOAD" },
          ] },
        ],
        tools: [
          {
            type: "namespace",
            name: "collaboration",
            tools: [
              {
                type: "function",
                name: "send_message",
                inputSchema: { type: "object", properties: { target: { type: "string" } } },
              },
            ],
          },
        ],
      }),
    });
    assert.equal(response.status, 200, router.testErrors());
    await response.text();
    assert.equal(gatewayRequests.length, 1, "Nous Direct empty completion was retried");
    assert.deepEqual(gatewayRequests[0].input[0], reasoning);
    assert.equal(gatewayRequests[0].input[1].name, "collaboration__send_message");
    assert.equal(gatewayRequests[0].input[1].namespace, undefined);
    assert.equal(gatewayRequests[0].tools[0].name, "collaboration__send_message");
    const chat = toNousChatRequest(gatewayRequests[0], MODEL.upstreamModel, { internalKey: INTERNAL_ROUTER_KEY });
    assert.deepEqual(JSON.parse(chat.messages.at(-1).content), {
      type: "agent_message", author: "/root", recipient: "/root/synthetic-child",
      content: "Message Type: NEW_TASK\nSender: /root\nPayload:\nSYNTHETIC_TASK_PAYLOAD",
    });
    assert.equal(chat.messages.at(-1).role, "user");
    assert.ok(gatewayRequests[0].input[4].content.every(part => part.type === "input_text"));
    for (const compact of ["response", "v1", "v2"]) {
      const input = [{
        type: "agent_message", author: "/root", recipient: "/root/synthetic-child", content: [
          { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
          { type: "encrypted_content", encrypted_content: "FIRST_SYNTHETIC_PART" },
          { type: "encrypted_content", encrypted_content: "SECOND_SYNTHETIC_PART" },
        ],
      }];
      if (compact === "v2") input.push({ type: "compaction_trigger" });
      const suffix = compact === "v1" ? "/responses/compact" : "/responses";
      const ambiguous = await fetch(`${callerBaseUrl(port, CALLER_KEY)}${suffix}`, {
        method: "POST", headers: { Authorization: "Bearer caller-session", "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL.slug, input }),
      });
      assert.equal(ambiguous.status, 400, compact);
      assert.equal((await ambiguous.json()).error.type, "local_nous_agent_input_unsupported", compact);
      assert.equal(gatewayRequests.length, 1, `${compact}: ambiguous encrypted input reached the gateway`);
    }
    assert.deepEqual(gatewayRequests[0].tools[0].parameters, {
      type: "object",
      properties: { target: { type: "string" } },
    });
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(testRoot, { recursive: true, force: true });
  }
});
