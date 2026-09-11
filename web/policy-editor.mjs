const childrenOf = (node) => node.type === "condition" ? [node.true_node, node.false_node] : [];

export function reachableNodes(policy, roots = [policy.root_node]) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id) || !policy.nodes[id]) continue;
    seen.add(id);
    stack.push(...childrenOf(policy.nodes[id]));
  }
  return seen;
}

export function assertValidGraph(policy) {
  if (!policy.nodes[policy.root_node]) throw new Error("El árbol necesita un nodo de inicio.");
  const incoming = Object.fromEntries(Object.keys(policy.nodes).map((id) => [id, 0]));
  for (const [id, node] of Object.entries(policy.nodes)) {
    if (node.id !== id) throw new Error("La identidad de un nodo no coincide con el árbol.");
    for (const target of childrenOf(node)) {
      if (!policy.nodes[target]) throw new Error("Todas las ramas deben tener un destino.");
      incoming[target]++;
    }
  }
  const queue = Object.keys(incoming).filter((id) => incoming[id] === 0);
  for (let index = 0; index < queue.length; index++) {
    childrenOf(policy.nodes[queue[index]]).forEach((target) => {
      if (--incoming[target] === 0) queue.push(target);
    });
  }
  if (queue.length !== Object.keys(policy.nodes).length) {
    throw new Error("Esta conexión vuelve a una regla anterior. Elegí otro destino.");
  }
}

// Connecting a branch to an ancestor would create a cycle.
export function connectionTargets(policy, sourceId) {
  return Object.values(policy.nodes).filter((node) => !reachableNodes(policy, [node.id]).has(sourceId));
}

function discardDetachedBranches(previous, next) {
  const previouslyReachable = reachableNodes(previous);
  // Keep any pre-existing detached work and the nodes it still references.
  const detachedRoots = Object.keys(previous.nodes).filter((id) => !previouslyReachable.has(id));
  const retained = reachableNodes(next, [next.root_node, ...detachedRoots]);
  const removed = [];
  for (const id of previouslyReachable) {
    if (!retained.has(id)) {
      delete next.nodes[id];
      removed.push(id);
    }
  }
  return removed;
}

export function connectBranch(policy, sourceId, branch, targetId) {
  if (!["true_node", "false_node"].includes(branch) || policy.nodes[sourceId]?.type !== "condition") {
    throw new Error("Seleccioná una rama de una condición.");
  }
  const next = structuredClone(policy);
  next.nodes[sourceId][branch] = targetId;
  // Check before removing anything so a cycle can never hide disconnected data.
  assertValidGraph(next);
  const removed = discardDetachedBranches(policy, next);
  assertValidGraph(next);
  return { policy: next, selected: sourceId, removed };
}

export function insertNode(policy, { anchorId, placement, node, fallback = null }) {
  const anchor = policy.nodes[anchorId];
  if (!anchor) throw new Error("Seleccioná dónde agregar el nodo.");
  if (!["before", "true_node", "false_node"].includes(placement)) throw new Error("Elegí una ubicación válida.");
  if (placement !== "before" && anchor.type !== "condition") throw new Error("Los resultados no tienen ramas.");
  if (node.type === "decision" && placement === "before") {
    throw new Error("Un resultado debe estar conectado a la rama de una condición.");
  }
  if (!node.id || policy.nodes[node.id] || (fallback && (!fallback.id || policy.nodes[fallback.id] || fallback.id === node.id))) {
    throw new Error("El identificador del nuevo nodo ya existe.");
  }
  const next = structuredClone(policy);
  const destination = placement === "before" ? anchorId : anchor[placement];
  next.nodes[node.id] = structuredClone(node);
  if (node.type === "condition") next.nodes[node.id].true_node = destination;
  if (fallback) next.nodes[fallback.id] = structuredClone(fallback);
  if (placement === "before") {
    if (next.root_node === anchorId) next.root_node = node.id;
    for (const existing of Object.values(next.nodes)) {
      if (existing.id === node.id) continue;
      for (const branch of ["true_node", "false_node"]) {
        if (existing[branch] === anchorId) existing[branch] = node.id;
      }
    }
  } else {
    next.nodes[anchorId][placement] = node.id;
  }
  assertValidGraph(next);
  const removed = discardDetachedBranches(policy, next);
  assertValidGraph(next);
  return { policy: next, selected: node.id, removed };
}
