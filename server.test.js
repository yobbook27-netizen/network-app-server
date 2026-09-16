// Session 126, Part 1. Node's built-in test runner (`node --test`, Node 24) — no jest, no
// supertest, nothing new to install. `app` and `anthropic` are exported by server.js under a
// NODE_ENV=test guard (see the bottom of that file); `anthropic.messages.create` is replaced
// per test so nothing here ever calls the real API or spends real money.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { app, anthropic } from "./server.js";

let base;
let server;
let createCallCount = 0;
let lastCreateParams = null;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function fakeFact(text = "A fact.") {
  return {
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
    content: [
      {
        type: "text",
        text: JSON.stringify({ line: { text, url: "https://example.com/a", title: "Example" } }),
      },
    ],
  };
}

beforeEach(() => {
  createCallCount = 0;
  lastCreateParams = null;
  anthropic.messages.create = async (params) => {
    createCallCount++;
    lastCreateParams = params;
    return fakeFact();
  };
});

async function briefLines(body) {
  const res = await fetch(`${base}/api/brief-lines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test("a second request for the same company on the same day makes no model call", async () => {
  const first = await briefLines({ companies: ["Acme Cache Co"], date: "2030-01-01", installId: "device-a1" });
  assert.equal(first.status, 200);
  assert.equal(createCallCount, 1);
  assert.equal(lastCreateParams.model, "claude-haiku-4-5");

  // A different install, same company, same requested date — the company cache is shared
  // across users, so this must not call the model again.
  const second = await briefLines({ companies: ["Acme Cache Co"], date: "2030-01-01", installId: "device-a2" });
  assert.equal(second.status, 200);
  assert.equal(createCallCount, 1, "cache hit must not call the model a second time");
  assert.deepEqual(second.json.lines, first.json.lines);
});

test("a second request from the same install id on the same day returns 429", async () => {
  const first = await briefLines({ companies: ["Foo Corp"], installId: "device-b" });
  assert.equal(first.status, 200);

  const second = await briefLines({ companies: ["Bar Inc"], installId: "device-b" });
  assert.equal(second.status, 429);
  // The capped request must not have reached the model either.
  assert.equal(createCallCount, 1);
});

test("a catch-up call for today and a fetch-ahead call for tomorrow, same install, both succeed", async () => {
  // The scenario the cap must not break: a day nobody opened the app produces a same-real-day
  // pair of calls — today's catch-up (this open) and tomorrow's fetch-ahead (this background) —
  // for the SAME installId. Keying the cap on requestDate rather than the server's wall clock
  // is what keeps the second call from being 429'd. See the header on briefLinesCallDay.
  const today = await briefLines({ companies: ["Ahead Co"], date: "2031-05-05", installId: "device-d" });
  assert.equal(today.status, 200);
  const tomorrow = await briefLines({ companies: ["Ahead Co"], date: "2031-05-06", installId: "device-d" });
  assert.equal(tomorrow.status, 200);

  // And asking for the SAME content date again from that same install is still refused.
  const repeat = await briefLines({ companies: ["Ahead Co"], date: "2031-05-05", installId: "device-d" });
  assert.equal(repeat.status, 429);
});

test("the assembled response never exceeds two lines, even with many uncached companies", async () => {
  const { status, json } = await briefLines({
    companies: ["One Co", "Two Co", "Three Co", "Four Co"],
    date: "2030-02-02",
    installId: "device-c",
  });
  assert.equal(status, 200);
  assert.ok(json.lines.length <= 2, `expected at most 2 lines, got ${json.lines.length}`);
  // At most MAX_LIVE_SEARCHES (2) fresh model calls per incoming request, however many
  // companies were sent — the rest are left out rather than guessed.
  assert.ok(createCallCount <= 2, `expected at most 2 live searches, got ${createCallCount}`);
});
