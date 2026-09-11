// SPDX-License-Identifier: MIT
// Graph operations shared by the editor, layout, and browser checks.
const PolicyGraph = (() => {
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

  function add(policy, type, label, insertion = null) {
    if (!["condition", "decision"].includes(type)) throw new Error("Tipo de módulo no válido.");
    const id = `${type}-${crypto.randomUUID()}`;
    const node = type === "condition"
      ? { id, type, label, combination: "none", validations: [{ field: "score_1", operator: "gte", value: 0 }], true_node: null, false_node: null }
      : { id, type, label, decision: "REVIEW", risk_band: "UNASSIGNED", credit_limit: 0, reason_code: "MANUAL_REVIEW" };
    if (insertion) {
      const source = policy.nodes[insertion.source];
      if (source?.type !== "condition" || !branches.includes(insertion.branch)) {
        throw new Error("La rama de origen ya no existe.");
      }
      // Inserting a condition preserves the old path on Yes; No stays explicitly pending.
      if (type === "condition") node.true_node = source[insertion.branch];
      source[insertion.branch] = id;
    }
    policy.nodes[id] = node;
    return id;
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

  function layout(policy) {
    // One position per node, including disconnected drafts and shared destinations.
    const ids = Object.keys(policy.nodes);
    const depth = Object.fromEntries(ids.map((id) => [id, 0]));
    const indegree = Object.fromEntries(ids.map((id) => [id, 0]));
    ids.forEach((id) => children(policy, id).forEach((target) => indegree[target]++));
    const queue = ids.filter((id) => indegree[id] === 0);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      children(policy, id).forEach((target) => {
        depth[target] = Math.max(depth[target], depth[id] + 1);
        if (--indegree[target] === 0) queue.push(target);
      });
    }
    const connected = reachable(policy, policy.root_node);
    const layers = new Map();
    ids.forEach((id) => {
      // Keep disconnected modules in a separate row below the connected graph.
      if (!connected.has(id)) return;
      const row = layers.get(depth[id]) || [];
      row.push(id);
      layers.set(depth[id], row);
    });
    const detached = ids.filter((id) => !connected.has(id));
    const detachedLevel = Math.max(0, ...layers.keys()) + 1;
    if (detached.length) {
      detached.forEach((id) => { depth[id] = detachedLevel; });
      layers.set(detachedLevel, detached);
    }
    const width = Math.max(1080, ...[...layers.values()].map((row) => row.length * 220 + 72));
    const x = {};
    layers.forEach((row) => row.forEach((id, index) => {
      x[id] = (width - row.length * 220) / 2 + index * 220 + 16;
    }));
    return { x, depth, width, connected };
  }

  return { branches, edges, reachable, canConnect, connect, add, incoming, remove, issues, layout };
})();
