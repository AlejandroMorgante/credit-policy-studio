import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { insertNode, connectBranch, connectionTargets, assertValidGraph, reachableNodes, issues, remove } from "../../web/policy-editor.mjs";
import { positionedLayout, draggedPosition, fitViewport, NODE_WIDTH, NODE_HEIGHT } from "../../web/tree-layout.mjs";

const sample = () => JSON.parse(readFileSync(new URL("../../policies/credit_policy_v1.json", import.meta.url)));
const decision = (id) => ({ id, type: "decision", label: "Revisión", decision: "REVIEW", risk_band: "C", credit_limit: 0, reason_code: "TEST" });
const condition = (id, falseId) => ({ id, type: "condition", label: "Ingreso mínimo", combination: "none", validations: [{ field: "variable_1", operator: "gte", value: 1000 }], true_node: "", false_node: falseId });

test("inserting a condition before the root preserves the previous tree on Sí", () => {
  const policy = sample();
  const before = structuredClone(policy);
  const result = insertNode(policy, { anchorId: policy.root_node, placement: "before", node: condition("new-rule", "new-result"), fallback: decision("new-result") });
  assert.equal(result.policy.root_node, "new-rule");
  assert.equal(result.policy.nodes["new-rule"].true_node, policy.root_node);
  assert.equal(reachableNodes(result.policy).size, Object.keys(policy.nodes).length + 2);
  assert.deepEqual(policy, before);
  assertValidGraph(result.policy);
});

test("inserting on one branch does not reconnect another parent of a shared result", () => {
  const policy = sample();
  policy.nodes.affordability.false_node = "reject-bureau";
  delete policy.nodes["review-affordability"];
  const result = insertNode(policy, { anchorId: "bureau-floor", placement: "false_node", node: condition("new-rule", "new-result"), fallback: decision("new-result") });
  assert.equal(result.policy.nodes["bureau-floor"].false_node, "new-rule");
  assert.equal(result.policy.nodes.affordability.false_node, "reject-bureau");
  assert.equal(result.policy.nodes["new-rule"].true_node, "reject-bureau");
  assertValidGraph(result.policy);
});

test("a result replaces only its branch and preserves detached work until explicitly removed", () => {
  const policy = sample();
  const result = insertNode(policy, { anchorId: "bureau-floor", placement: "true_node", node: decision("new-result") });
  assert.equal(Object.keys(result.policy.nodes).length, Object.keys(policy.nodes).length + 1);
  assert.equal(result.policy.nodes["bureau-floor"].true_node, "new-result");
  assert.throws(() => assertValidGraph(result.policy), /sin conectar/);
});

test("connection changes keep shared descendants and reject cycles without mutations", () => {
  const policy = sample();
  const snapshot = structuredClone(policy);
  assert.throws(() => connectBranch(policy, "tenure", "true_node", "bureau-floor"), /ciclo/);
  assert.deepEqual(policy, snapshot);
  const result = connectBranch(policy, "bureau-floor", "false_node", "approve-prime");
  assert.ok(result.policy.nodes["approve-prime"]);
  assert.ok(result.policy.nodes["reject-bureau"]);
  assert.throws(() => assertValidGraph(result.policy), /sin conectar/);
  assert.ok(!connectionTargets(policy, "tenure").some((node) => ["bureau-floor", "tenure", "income"].includes(node.id)));
});

test("a pre-existing detached branch keeps the descendants it references", () => {
  const policy = sample();
  policy.nodes.detached = { ...condition("detached", "reject-bureau"), true_node: "affordability" };
  const result = connectBranch(policy, "bureau-floor", "true_node", "reject-bureau");
  assert.deepEqual(Object.keys(result.policy.nodes), Object.keys(policy.nodes));
  assert.throws(() => assertValidGraph(result.policy), /sin conectar/);
});

test("rejects duplicate IDs and trying to insert a terminal before another node", () => {
  const policy = sample();
  assert.throws(() => insertNode(policy, { anchorId: policy.root_node, placement: "true_node", node: decision("income") }), /ya existe/);
  assert.throws(() => insertNode(policy, { anchorId: policy.root_node, placement: "before", node: decision("new") }), /rama/);
});

test("pending connections and disconnected insertion are allowed only in drafts", () => {
  const policy = sample();
  const pending = connectBranch(policy, policy.root_node, "true_node", null).policy;
  assert.equal(pending.nodes[policy.root_node].true_node, null);
  assert.equal(Object.keys(pending.nodes).length, Object.keys(policy.nodes).length);
  assert.throws(() => assertValidGraph(pending), /rama/);
  const result = insertNode(pending, { anchorId: policy.root_node, placement: "detached", node: condition("new-rule", null) });
  assert.equal(result.policy.nodes["new-rule"].true_node, null);
  assert.ok(issues(result.policy).length > 0);
  const layout = positionedLayout(result.policy);
  assert.equal(layout.connected.has("new-rule"), false);
  for (const id of Object.keys(result.policy.nodes)) {
    assert.ok(Number.isFinite(layout.x[id]) && Number.isFinite(layout.y[id]));
  }
});

test("deletion preserves descendants, clears incoming edges and requires a replacement root", () => {
  const policy = sample();
  const descendants = reachableNodes(policy, ["affordability"]);
  remove(policy, "affordability");
  assert.equal(policy.nodes["bureau-floor"].true_node, null);
  for (const id of descendants) if (id !== "affordability") assert.ok(policy.nodes[id]);
  assert.throws(() => remove(policy, policy.root_node), /inicio/);
  remove(policy, policy.root_node, "income");
  assert.equal(policy.root_node, "income");
  assert.throws(() => remove({ root_node: "only", nodes: { only: decision("only") } }, "only"), /al menos/);
});

test("inserting before a shared node redirects all parents without duplicating descendants", () => {
  const policy = sample();
  policy.nodes.affordability.false_node = "reject-bureau";
  const result = insertNode(policy, {
    anchorId: "reject-bureau", placement: "before",
    node: condition("new-rule", null),
  });
  assert.equal(result.policy.nodes["bureau-floor"].false_node, "new-rule");
  assert.equal(result.policy.nodes.affordability.false_node, "new-rule");
  assert.equal(result.policy.nodes["new-rule"].true_node, "reject-bureau");
  assert.equal(Object.keys(result.policy.nodes).length, Object.keys(policy.nodes).length + 1);
});

test("dragging follows the pointer at different zooms and leaves policy rules intact", () => {
  const policy = sample();
  const snapshot = structuredClone(policy);
  for (const scale of [.1, .5, 1, 2]) {
    const start = { x: 300, y: 200 };
    const moved = draggedPosition(start, 80, -60, scale);
    assert.equal((moved.x - start.x) * scale, 80);
    assert.equal((moved.y - start.y) * scale, -60);
    const layout = positionedLayout(policy, { income: moved });
    assert.equal(layout.x.income, moved.x);
    assert.equal(layout.y.income, moved.y);
  }
  assert.deepEqual(policy, snapshot);
});

test("encuadrar includes nodes dragged beyond the top and left of the original canvas", () => {
  const policy = sample();
  const layout = positionedLayout(policy, { income: { x: -2000, y: -1200 }, tenure: { x: 4000, y: 1600 } });
  const view = fitViewport(layout.width, layout.height, 800, 500);
  view.x -= layout.minX * view.scale;
  view.y -= layout.minY * view.scale;
  for (const id of Object.keys(policy.nodes)) {
    assert.ok(layout.x[id] * view.scale + view.x >= 0);
    assert.ok(layout.y[id] * view.scale + view.y >= 0);
    assert.ok((layout.x[id] + NODE_WIDTH) * view.scale + view.x <= 800);
    assert.ok((layout.y[id] + NODE_HEIGHT) * view.scale + view.y <= 500);
  }
});

test("clearing saved positions restores the automatic layout", () => {
  const policy = sample();
  const automatic = positionedLayout(policy);
  const restored = positionedLayout(policy, {});
  assert.deepEqual(restored.x, automatic.x);
  assert.deepEqual(restored.y, automatic.y);
  assert.equal(restored.width, automatic.width);
  assert.equal(restored.height, automatic.height);
});
