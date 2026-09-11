// SPDX-License-Identifier: MIT
const branches = ["true_node", "false_node"];
const hasNode = (policy, id) => typeof id === "string" && Object.hasOwn(policy.nodes, id);
const edges = (node) => node?.type === "condition"
  ? branches.map((branch) => ({ branch, target: node[branch] }))
  : [];
const children = (policy, id) => edges(policy.nodes[id])
  .map(({ target }) => target).filter((target) => hasNode(policy, target));

function reachable(policy, start) {
  const visited = new Set();
  const pending = [start];
  while (pending.length) {
    const id = pending.pop();
    if (!hasNode(policy, id) || visited.has(id)) continue;
    visited.add(id);
    pending.push(...children(policy, id));
  }
  return visited;
}

function canConnect(policy, source, target) {
  return target === null || (hasNode(policy, target)
    && !reachable(policy, target).has(source));
}

function connect(policy, source, branch, target) {
  if (policy.nodes[source]?.type !== "condition" || !branches.includes(branch)) {
    throw new Error("La conexión debe salir de una rama Sí o No de una condición.");
  }
  if (!canConnect(policy, source, target)) {
    throw new Error("La conexión no es válida: el destino no existe o forma un ciclo.");
  }
  policy.nodes[source][branch] = target;
}


function incoming(policy, target) {
  return Object.values(policy.nodes).flatMap((node) => edges(node)
    .filter((edge) => edge.target === target).map((edge) => ({ source: node.id, ...edge })));
}

function remove(policy, id, replacementRoot = null) {
  if (!hasNode(policy, id)) throw new Error("El módulo ya no existe.");
  if (Object.keys(policy.nodes).length === 1) throw new Error("Debe quedar al menos un módulo.");
  if (policy.root_node === id) {
    if (replacementRoot === id || !hasNode(policy, replacementRoot)) {
      throw new Error("Elegí otro módulo como inicio antes de eliminar éste.");
    }
    policy.root_node = replacementRoot;
  }
  incoming(policy, id).forEach(({ source, branch }) => { policy.nodes[source][branch] = null; });
  delete policy.nodes[id];
}

function issues(policy) {
  const messages = [];
  const connected = reachable(policy, policy.root_node);
  if (!hasNode(policy, policy.root_node)) messages.push("Elegí un módulo de inicio.");
  Object.values(policy.nodes).forEach((node) => {
    if (!connected.has(node.id)) messages.push(`${node.label}: módulo sin conectar al inicio.`);
    edges(node).forEach(({ branch, target }) => {
      if (!hasNode(policy, target)) {
        messages.push(`${node.label}: falta conectar la rama ${branch === "true_node" ? "Sí" : "No"}.`);
      } else if (!canConnect(policy, node.id, target)) {
        messages.push(`${node.label}: la conexión forma un ciclo.`);
      }
    });
  });
  return messages;
}


// Both the editor and layout consume the same graph traversal.
export function reachableNodes(policy, roots = [policy.root_node]) {
  return new Set(roots.flatMap((root) => [...reachable(policy, root)]));
}

export function connectionTargets(policy, sourceId) {
  return Object.values(policy.nodes).filter((node) => canConnect(policy, sourceId, node.id));
}

function assertDraftGraph(policy) {
  if (!hasNode(policy, policy.root_node)) throw new Error("El árbol necesita un nodo de inicio.");
  for (const [id, node] of Object.entries(policy.nodes)) {
    if (id !== node.id) throw new Error("La identidad de un nodo no coincide con el árbol.");
    for (const { target } of edges(node)) {
      if (!canConnect(policy, id, target)) throw new Error("Esta conexión vuelve a una regla anterior o no tiene un destino válido.");
    }
  }
}

export function assertValidGraph(policy) {
  assertDraftGraph(policy);
  const pending = issues(policy);
  if (pending.length) throw new Error(pending[0]);
}

export function connectBranch(policy, sourceId, branch, targetId) {
  const next = structuredClone(policy);
  connect(next, sourceId, branch, targetId);
  return { policy: next, selected: sourceId };
}

export { branches, edges, hasNode, issues, remove };

export function insertNode(policy, { anchorId, placement, node, fallback = null }) {
  const anchor = policy.nodes[anchorId];
  if (!anchor) throw new Error("Seleccioná dónde agregar el nodo.");
  if (!["detached", "before", "true_node", "false_node"].includes(placement)) throw new Error("Elegí una ubicación válida.");
  if (placement !== "before" && placement !== "detached" && anchor.type !== "condition") throw new Error("Los resultados no tienen ramas.");
  if (node.type === "decision" && placement === "before") {
    throw new Error("Un resultado debe estar conectado a la rama de una condición.");
  }
  if (!node.id || policy.nodes[node.id] || (fallback && (!fallback.id || policy.nodes[fallback.id] || fallback.id === node.id))) {
    throw new Error("El identificador del nuevo nodo ya existe.");
  }
  const next = structuredClone(policy);
  const destination = placement === "detached" ? null : placement === "before" ? anchorId : anchor[placement];
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
  } else if (placement !== "detached") {
    next.nodes[anchorId][placement] = node.id;
  }
  assertDraftGraph(next);
  return { policy: next, selected: node.id };
}
