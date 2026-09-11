import { edges, hasNode, reachableNodes } from "./policy-editor.mjs";

export const NODE_WIDTH = 216;
export const NODE_HEIGHT = 96;
export const LEVEL_GAP = 156;
const COLUMN_GAP = 256;
const PADDING = 32;

// Lay out each node once, including policies whose branches share a result.
// Iterative traversal keeps deep policies from exhausting the call stack.
export function hierarchy(policy) {
  const ids = Object.keys(policy.nodes);
  const children = (id) => {
    return [...new Set(edges(policy.nodes[id]).map(({ target }) => target))]
      .filter((child) => hasNode(policy, child));
  };
  const incoming = Object.fromEntries(ids.map((id) => [id, 0]));
  const depth = Object.fromEntries(ids.map((id) => [id, 0]));
  ids.forEach((id) => children(id).forEach((child) => incoming[child]++));
  const queue = ids.filter((id) => incoming[id] === 0);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    children(id).forEach((child) => {
      depth[child] = Math.max(depth[child], depth[id] + 1);
      if (--incoming[child] === 0) queue.push(child);
    });
  }

  const connected = reachableNodes(policy);
  const detachedLevel = Math.max(0, ...[...connected].map((id) => depth[id])) + 1;
  ids.filter((id) => !connected.has(id)).forEach((id) => { depth[id] = detachedLevel; });

  // Use a spanning tree for horizontal order, while keeping every graph edge.
  const seen = new Set();
  const ordered = [];
  const layoutChildren = {};
  const stack = [policy.root_node, ...ids.filter((id) => id !== policy.root_node)].reverse();
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
    layoutChildren[id] = children(id).filter((child) => !seen.has(child));
    stack.push(...layoutChildren[id].toReversed());
  }
  const x = {};
  let column = 0;
  ordered.toReversed().forEach((id) => {
    const kids = layoutChildren[id].filter((child) => x[child] !== undefined);
    x[id] = kids.length
      ? kids.reduce((sum, child) => sum + x[child], 0) / kids.length
      : PADDING + column++ * COLUMN_GAP;
  });
  // Mirror the reverse traversal so the "Sí" branch stays on the left.
  const right = Math.max(...Object.values(x));
  ids.forEach((id) => { x[id] = right - x[id] + PADDING; });
  // Shared children can give unrelated parents the same center. Separate peers.
  const levels = new Map();
  ids.forEach((id) => {
    if (!levels.has(depth[id])) levels.set(depth[id], []);
    levels.get(depth[id]).push(id);
  });
  levels.forEach((peers) => {
    peers.sort((a, b) => x[a] - x[b]);
    peers.forEach((id, index) => {
      if (index) x[id] = Math.max(x[id], x[peers[index - 1]] + COLUMN_GAP);
    });
  });
  return {
    x, depth, children, connected,
    width: Math.max(...Object.values(x)) + NODE_WIDTH + PADDING,
    height: Math.max(...Object.values(depth)) * LEVEL_GAP + NODE_HEIGHT + PADDING * 2,
  };
}

export function fitViewport(width, height, viewportWidth, viewportHeight) {
  const availableWidth = Math.max(1, viewportWidth - 64);
  const availableHeight = Math.max(1, viewportHeight - 88);
  const scale = Math.min(1, availableWidth / width, availableHeight / height);
  return {
    scale,
    x: (viewportWidth - width * scale) / 2,
    y: (viewportHeight - height * scale - 32) / 2,
  };
}

export function positionedLayout(policy, positions = {}) {
  const layout = hierarchy(policy);
  const y = {};
  for (const id of Object.keys(policy.nodes)) {
    const position = positions[id];
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
      layout.x[id] = position.x;
      y[id] = position.y;
    } else {
      y[id] = PADDING + layout.depth[id] * LEVEL_GAP;
    }
  }
  const minX = Math.min(...Object.values(layout.x)) - PADDING;
  const minY = Math.min(...Object.values(y)) - PADDING;
  return {
    ...layout, y, minX, minY,
    width: Math.max(...Object.values(layout.x)) + NODE_WIDTH + PADDING - minX,
    height: Math.max(...Object.values(y)) + NODE_HEIGHT + PADDING - minY,
  };
}

export function draggedPosition(start, deltaX, deltaY, scale) {
  return { x: start.x + deltaX / scale, y: start.y + deltaY / scale };
}
