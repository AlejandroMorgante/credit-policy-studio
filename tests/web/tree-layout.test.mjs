import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hierarchy, fitViewport, NODE_WIDTH, NODE_HEIGHT, LEVEL_GAP } from "../../web/tree-layout.mjs";

const loadPolicy = (name) => JSON.parse(readFileSync(new URL(`../../policies/${name}`, import.meta.url)));

function assertUsableLayout(policy, layout) {
  for (const node of Object.values(policy.nodes)) {
    const x = layout.x[node.id];
    const y = 32 + layout.depth[node.id] * LEVEL_GAP;
    assert.ok(Number.isFinite(x) && Number.isFinite(y), `${node.id} has a position`);
    assert.ok(x >= 0 && x + NODE_WIDTH <= layout.width);
    assert.ok(y >= 0 && y + NODE_HEIGHT <= layout.height);
    if (node.type === "condition") {
      for (const child of [node.true_node, node.false_node]) {
        assert.ok(layout.depth[child] > layout.depth[node.id], `${child} is below ${node.id}`);
      }
    }
  }
  const levels = new Map();
  for (const [id, depth] of Object.entries(layout.depth)) {
    if (!levels.has(depth)) levels.set(depth, []);
    levels.get(depth).push(layout.x[id]);
  }
  for (const positions of levels.values()) {
    positions.sort((a, b) => a - b);
    for (let i = 1; i < positions.length; i++) {
      assert.ok(positions[i] - positions[i - 1] >= NODE_WIDTH + 16, "Nodes do not overlap");
    }
  }
}

for (const filename of ["credit_policy_v1.json", "credit_policy_sql_demo.json"]) {
  test(`${filename}: all nodes fit without overlaps, including shared decisions`, () => {
    const policy = loadPolicy(filename);
    assertUsableLayout(policy, hierarchy(policy));
  });
}

test("encuadrar includes the entire 48-node SQL graph on short and narrow screens", () => {
  const layout = hierarchy(loadPolicy("credit_policy_sql_demo.json"));
  for (const [width, height] of [[260, 280], [600, 320], [900, 560], [1400, 800]]) {
    const view = fitViewport(layout.width, layout.height, width, height);
    assert.ok(view.scale > 0 && view.scale < 0.55, "Zoom is allowed below the old 55% floor");
    assert.ok(view.x >= 0 && view.y >= 0);
    assert.ok(view.x + layout.width * view.scale <= width);
    assert.ok(view.y + layout.height * view.scale <= height);
  }
});

test("deep graphs do not recurse or multiply shared result nodes", () => {
  const nodes = { result: { id: "result", type: "decision" } };
  for (let index = 0; index < 12000; index++) {
    const id = `rule-${index}`;
    nodes[id] = {
      id, type: "condition", false_node: "result",
      true_node: index === 11999 ? "result" : `rule-${index + 1}`,
    };
  }
  const policy = { root_node: "rule-0", nodes };
  const layout = hierarchy(policy);
  assert.equal(Object.keys(layout.x).length, 12001);
  assertUsableLayout(policy, layout);
});

test("a detached node still receives a finite, visible position", () => {
  const policy = loadPolicy("credit_policy_v1.json");
  policy.nodes.detached = { id: "detached", type: "decision" };
  assertUsableLayout(policy, hierarchy(policy));
});

test("a single result stays centered at its natural size", () => {
  const policy = { root_node: "result", nodes: { result: { id: "result", type: "decision" } } };
  const layout = hierarchy(policy);
  const view = fitViewport(layout.width, layout.height, 1200, 700);
  assert.equal(view.scale, 1);
  assert.equal(view.x + layout.width / 2, 600);
  assertUsableLayout(policy, layout);
});
