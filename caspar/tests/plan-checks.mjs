#!/usr/bin/env node
/**
 * Checks for the shared project plan (caspar/projectPlan.mjs, planTools.mjs) and
 * the checks that let a chain of agents STOP (caspar/acceptance.mjs).
 *
 * These cover the two things the platform had no answer for: what the team has
 * already produced (so nobody rebuilds it), and whether the work is finished
 * (so nobody invents more).
 *
 * Run: node caspar/tests/plan-checks.mjs
 */

import assert from "node:assert/strict";

import {
  PLAN_STATUS,
  addPlanTask,
  completePlanTask,
  donePlanTasks,
  foldPlanEvents,
  openPlanTasks,
  planIsUsable,
  renderPlanForPrompt,
  setPlanGoal,
} from "../projectPlan.mjs";
import { PLAN_TOOLS, runPlanTool } from "../planTools.mjs";
import {
  buildAcceptancePrompt,
  checkAcceptance,
  noteProgress,
  parseAcceptanceVerdict,
  progressFingerprint,
  resetProgress,
  shouldHaltChain,
} from "../acceptance.mjs";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";
let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    resetProgress();
    await fn();
    passed += 1;
    console.log(`${GREEN}✓${NC} ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`${RED}✗${NC} ${name}\n  ${String(err?.stack || err).split("\n").slice(0, 5).join("\n  ")}`);
  }
}

/** A bridge that records plan signals and replays them as a readable log. */
function makePlanBridge() {
  const rows = [];
  let clock = 1000;
  const bridge = {
    programId: "meter-prog",
    async call(op, input) {
      if (op === "signal") {
        clock += 1;
        rows.push({
          id: String(rows.length + 1),
          time: clock,
          tags: input.tags || [],
          data: JSON.parse(input.data || "{}"),
        });
        return { ok: true, persisted: true };
      }
      if (op === "readSignals") {
        const tagsAll = input.tagsAll || [];
        const tagsAny = input.tagsAny || [];
        const hits = rows.filter(
          (row) =>
            tagsAll.every((t) => row.tags.includes(t)) &&
            (!tagsAny.length || tagsAny.some((t) => row.tags.includes(t))),
        );
        // The node answers newest-first.
        return { ok: true, signals: hits.slice().reverse().map((r) => ({ ...r, data: JSON.stringify(r.data) })) };
      }
      return { ok: true };
    },
    async signalUser() {
      return { ok: true };
    },
    onSignal() {
      return () => {};
    },
  };
  return { bridge, rows };
}

const task = {
  spaceId: "space-1",
  threadId: "main",
  proxyProgramId: "writer-prog",
  self: { programId: "writer-prog", name: "Writer", handle: "writer" },
};

await check("a plan folds from its signals, oldest event first", () => {
  const plan = foldPlanEvents([
    { time: 4, data: { event: "complete", planTaskId: "t1", artifacts: ["/work/site/index.html"], summary: "page is live" } },
    { time: 3, data: { event: "claim", planTaskId: "t1", ownerName: "Builder" } },
    { time: 2, data: { event: "task", planTaskId: "t1", title: "Build the page", owner: "b" } },
    { time: 1, data: { event: "goal", goal: "Ship a landing page", acceptance: ["the page is live at a public URL"] } },
  ]);
  assert.equal(plan.goal, "Ship a landing page");
  assert.deepEqual(plan.acceptance, ["the page is live at a public URL"]);
  assert.equal(plan.tasks.get("t1").status, PLAN_STATUS.DONE);
  assert.equal(openPlanTasks(plan).length, 0);
  assert.equal(donePlanTasks(plan).length, 1);
  // A completion registers its artifacts for the whole team, not just its task.
  assert.ok(plan.artifacts.has("/work/site/index.html"));
});

await check("the rendered plan tells an agent what NOT to rebuild", () => {
  const plan = foldPlanEvents([
    { time: 1, data: { event: "goal", goal: "Ship a landing page", acceptance: ["live at a public URL"] } },
    { time: 2, data: { event: "task", planTaskId: "t1", title: "Build the page" } },
    { time: 3, data: { event: "complete", planTaskId: "t1", artifacts: ["/work/site/index.html"], ownerName: "Builder", summary: "page built" } },
    { time: 4, data: { event: "task", planTaskId: "t2", title: "Write the copy", owner: "writer-prog", ownerName: "Writer" } },
  ]);
  const text = renderPlanForPrompt(plan, { self: { programId: "writer-prog" } });
  assert.match(text, /ALREADY PRODUCED/);
  assert.match(text, /\/work\/site\/index\.html \(by Builder\)/);
  assert.match(text, /ALREADY DONE/);
  assert.match(text, /Build the page/);
  assert.match(text, /\[t2\] Write the copy — YOURS/);
});

await check("an empty plan renders nothing at all", () => {
  assert.equal(renderPlanForPrompt(foldPlanEvents([])), "");
  assert.equal(planIsUsable(foldPlanEvents([])), false);
});

await check("plan tools write and read back through the log", async () => {
  const { bridge } = makePlanBridge();
  await setPlanGoal(bridge, task, { goal: "Ship a landing page", acceptance: ["live at a public URL"] });
  const created = await addPlanTask(bridge, task, { title: "Write the copy", objective: "Draft hero + CTA" });
  assert.ok(created.ok && created.planTaskId);
  const mid = await runPlanTool(bridge, task, "read_plan", {});
  assert.equal(mid.goal, "Ship a landing page");
  assert.equal(mid.open.length, 1);
  assert.equal(mid.done.length, 0);

  await completePlanTask(bridge, task, {
    planTaskId: created.planTaskId,
    artifacts: ["/work/copy.md"],
    summary: "hero and CTA drafted",
  });
  const after = await runPlanTool(bridge, task, "read_plan", {});
  assert.equal(after.open.length, 0);
  assert.equal(after.done.length, 1);
  assert.deepEqual(after.artifacts.map((a) => a.path), ["/work/copy.md"]);
});

await check("assign_task refuses a handle nobody answers to, and says who is here", async () => {
  const { bridge } = makePlanBridge();
  const withRoster = { ...task, roster: [{ programId: "b-prog", name: "Builder", handle: "builder", kind: "agent" }] };
  const res = await runPlanTool(bridge, withRoster, "assign_task", { toHandle: "nobody", objective: "do a thing" });
  assert.equal(res.ok, false);
  assert.deepEqual(res.knownAgents, ["builder"]);
});

await check("assign_task records the task even when it cannot start the teammate", async () => {
  // No billing context on this run: the teammate cannot be launched. The work
  // must still land in the plan as visible open work — an assignment nobody can
  // pay for should not vanish.
  const { bridge } = makePlanBridge();
  const withRoster = { ...task, roster: [{ programId: "b-prog", name: "Builder", handle: "builder", kind: "agent" }] };
  const res = await runPlanTool(bridge, withRoster, "assign_task", {
    toHandle: "@builder",
    objective: "Build the page from copy.md",
    inputs: ["/work/copy.md"],
  });
  assert.equal(res.ok, true);
  assert.equal(res.started, false);
  assert.match(res.note, /Do not repeat the assignment/);
  const plan = await runPlanTool(bridge, withRoster, "read_plan", {});
  assert.equal(plan.open.length, 1);
  assert.equal(plan.open[0].owner, "Builder");
});

await check("every plan tool is declared with a schema the model can call", () => {
  for (const tool of PLAN_TOOLS) {
    assert.ok(tool.name && tool.description, `${tool.name} needs a description`);
    assert.equal(tool.inputSchema.type, "object");
    for (const required of tool.inputSchema.required || []) {
      assert.ok(tool.inputSchema.properties[required], `${tool.name}.${required} must be declared`);
    }
  }
});

await check("acceptance is refused until there is something to accept", async () => {
  const nothing = foldPlanEvents([]);
  assert.equal((await checkAcceptance(nothing)).complete, false);

  const noCriteria = foldPlanEvents([{ time: 1, data: { event: "goal", goal: "Ship it" } }]);
  assert.match((await checkAcceptance(noCriteria)).reason, /no acceptance criteria/);

  const stillOpen = foldPlanEvents([
    { time: 1, data: { event: "goal", goal: "Ship it", acceptance: ["live"] } },
    { time: 2, data: { event: "task", planTaskId: "t1", title: "Build" } },
  ]);
  assert.match((await checkAcceptance(stillOpen)).reason, /still open/);

  const nothingMade = foldPlanEvents([
    { time: 1, data: { event: "goal", goal: "Ship it", acceptance: ["live"] } },
    { time: 2, data: { event: "task", planTaskId: "t1", title: "Build" } },
    { time: 3, data: { event: "complete", planTaskId: "t1" } },
  ]);
  assert.match((await checkAcceptance(nothingMade)).reason, /nothing produced/);
});

await check("acceptance asks the model only once the structural gates pass", async () => {
  const plan = foldPlanEvents([
    { time: 1, data: { event: "goal", goal: "Ship a landing page", acceptance: ["live at a public URL"] } },
    { time: 2, data: { event: "task", planTaskId: "t1", title: "Build" } },
    { time: 3, data: { event: "complete", planTaskId: "t1", artifacts: ["https://preview.example/site"] } },
  ]);
  const prompt = buildAcceptancePrompt(plan);
  assert.match(prompt, /live at a public URL/);
  assert.match(prompt, /https:\/\/preview\.example\/site/);

  const llm = { provider: "xai", api_key: "k", models: ["grok-x"] };
  const said = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "DONE" } }] }) });
  assert.equal((await checkAcceptance(plan, { llm, fetchImpl: said })).complete, true);

  const notYet = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "MORE" } }] }) });
  assert.equal((await checkAcceptance(plan, { llm, fetchImpl: notYet })).complete, false);
});

await check("an unreadable verdict never halts a chain", async () => {
  assert.equal(parseAcceptanceVerdict("DONE"), "done");
  assert.equal(parseAcceptanceVerdict("  more \n"), "more");
  assert.equal(parseAcceptanceVerdict("I think perhaps"), "");
  const plan = foldPlanEvents([
    { time: 1, data: { event: "goal", goal: "Ship", acceptance: ["live"] } },
    { time: 2, data: { event: "task", planTaskId: "t1", title: "Build" } },
    { time: 3, data: { event: "complete", planTaskId: "t1", artifacts: ["/x"] } },
  ]);
  const llm = { provider: "xai", api_key: "k", models: ["grok-x"] };
  const waffle = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "hmm" } }] }) });
  assert.equal((await checkAcceptance(plan, { llm, fetchImpl: waffle })).complete, false);
  const dead = async () => {
    throw new Error("network down");
  };
  assert.equal((await checkAcceptance(plan, { llm, fetchImpl: dead })).complete, false);
});

await check("a chain that produces nothing three hops running is stopped", async () => {
  const churning = foldPlanEvents([
    { time: 1, data: { event: "goal", goal: "Ship", acceptance: ["live"] } },
    { time: 2, data: { event: "task", planTaskId: "t1", title: "Build" } },
  ]);
  assert.equal(noteProgress("root-a", churning).idleHops, 0);
  assert.equal(noteProgress("root-a", churning).idleHops, 1);
  assert.equal(noteProgress("root-a", churning).idleHops, 2);
  const third = noteProgress("root-a", churning);
  assert.equal(third.idleHops, 3);
  assert.equal(third.stagnant, true);
});

await check("producing something resets the stagnation count", async () => {
  const before = foldPlanEvents([
    { time: 1, data: { event: "goal", goal: "Ship", acceptance: ["live"] } },
    { time: 2, data: { event: "task", planTaskId: "t1", title: "Build" } },
  ]);
  const after = foldPlanEvents([
    { time: 1, data: { event: "goal", goal: "Ship", acceptance: ["live"] } },
    { time: 2, data: { event: "task", planTaskId: "t1", title: "Build" } },
    { time: 3, data: { event: "artifact", path: "/work/index.html" } },
  ]);
  assert.notEqual(progressFingerprint(before), progressFingerprint(after));
  noteProgress("root-b", before);
  noteProgress("root-b", before);
  assert.equal(noteProgress("root-b", after).idleHops, 0, "a real artifact clears the idle streak");
});

await check("a project that never plans is never judged stagnant", async () => {
  // Every space that predates the plan has an empty one. Judging those would
  // halt every chain at the third hop for having no plan to make progress on.
  const empty = foldPlanEvents([]);
  for (let i = 0; i < 6; i += 1) assert.equal(noteProgress("root-c", empty).stagnant, false);
  assert.equal((await shouldHaltChain(empty, { rootRunId: "root-c" })).halt, false);
});

await check("shouldHaltChain reports why it stopped, in words a person can read", async () => {
  const plan = foldPlanEvents([
    { time: 1, data: { event: "goal", goal: "Ship", acceptance: ["live"] } },
    { time: 2, data: { event: "task", planTaskId: "t1", title: "Build" } },
    { time: 3, data: { event: "complete", planTaskId: "t1", artifacts: ["/work/index.html"] } },
  ]);
  const llm = { provider: "xai", api_key: "k", models: ["grok-x"] };
  const done = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "DONE" } }] }) });
  const verdict = await shouldHaltChain(plan, { rootRunId: "root-d", llm, fetchImpl: done });
  assert.equal(verdict.halt, true);
  assert.equal(verdict.kind, "complete");
  assert.match(verdict.reason, /the work is finished/);
});

console.log(`\n${failures.length ? RED : GREEN}${passed} passed, ${failures.length} failed${NC}`);
process.exit(failures.length ? 1 : 0);
