import assert from "node:assert/strict";
import test from "node:test";
import { NOUS_HOSTED_SEARCH_NOTICE, prepareNousToolAvailability } from "../src/nous-tool-availability.mjs";

const exec = { type: "custom", name: "exec", format: { type: "text" } };
const search = { type: "web_search", user_location: { city: "PRIVATE_LOCATION" } };

test("automatic coding requests retain client tools with an explicit hosted-search notice", () => {
  const original = { input: "edit the scoped file", instructions: "Keep the task scoped.", tools: [exec, search], tool_choice: "auto" };
  const result = prepareNousToolAvailability(original);
  assert.deepEqual(result.payload.tools, [exec]);
  assert.equal(result.payload.instructions, `Keep the task scoped.\n\n${NOUS_HOSTED_SEARCH_NOTICE}`);
  assert.deepEqual(result.omitted, ["web_search"]);
  assert.equal(original.tools.length, 2);
  assert.equal(original.instructions, "Keep the task scoped.");
  assert.doesNotMatch(result.payload.instructions, /PRIVATE_LOCATION/);
});

test("forced hosted search and hosted-only required selection fail explicitly", () => {
  for (const choice of [{ type: "web_search" }, { type: "web_search_preview" }, "required"]) {
    const result = prepareNousToolAvailability({ tools: [search], tool_choice: choice });
    assert.equal(result.status, 400);
    assert.equal(result.error.type, "local_nous_tool_unavailable");
    assert.match(result.error.message, /standalone search.*not sent to Nous/);
    assert.equal(result.payload, undefined);
  }
});

test("declared client search functions and required client tools remain available", () => {
  const client = { type: "function", name: "web_search", parameters: { type: "object" } };
  for (const choice of ["required", { type: "function", name: "web_search" }, "none"]) {
    const result = prepareNousToolAvailability({ tools: [search, client], tool_choice: choice });
    assert.deepEqual(result.payload.tools, [client]);
    assert.deepEqual(result.payload.tool_choice, choice);
    assert.equal(result.error, undefined);
  }
});

test("unrelated tool types and malformed instruction data keep strict validation", () => {
  for (const payload of [
    { tools: [{ type: "computer_use" }] },
    { tools: [search], instructions: { private: "data" } },
    { input: "hello" },
  ]) assert.equal(prepareNousToolAvailability(payload).payload, payload);
});
