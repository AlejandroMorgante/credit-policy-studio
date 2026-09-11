import { setupEditorControls } from "./editor-controls.mjs";
import { edges, hasNode } from "./policy-editor.mjs";
import { positionedLayout, draggedPosition, fitViewport, NODE_WIDTH, NODE_HEIGHT } from "./tree-layout.mjs";

const state = {
  policy: null,
  selected: null,
  dashboard: null,
  mode: "edit",
  versions: [],
  runs: [],
  activeVersion: null,
  editingVersion: null,
  editorDraft: null,
  editorSelected: null,
  pendingPromotionVersion: null,
  dashboardRequest: 0,
  layout: null,
  minimap: null,
  focusMode: false,
  inspectorBeforeFocus: true,
  positionKey: null,
  nodePositions: {},
  nodeDrag: null,
  lastMove: null,
  saving: false,
  loadingPolicy: false,
  editorDirty: false,
  savedPolicy: null,
  formBaseline: null,
  connecting: null,
};
const viewportState = {
  x: 0,
  y: 0,
  scale: 1,
  initialized: false,
  pointers: new Map(),
  lastPoint: null,
  pinchDistance: null,
  dragged: false,
  viewportWidth: 0,
  viewportHeight: 0,
};
let editorControls;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 2;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const fieldLabels = {
  score_1: "Score de buró",
  score_2: "Score de capacidad",
  score_3: "Score de comportamiento",
  variable_1: "Ingreso mensual",
  variable_2: "Deuda mensual",
  variable_3: "Antigüedad laboral (meses)",
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function nodeTypeLabel(node) {
  return node.type === "condition" ? "Condición" : {
    APPROVED: "Aprobación", REVIEW: "Revisión", REJECTED: "Rechazo",
  }[node.decision];
}

function setInspectorVisible(visible) {
  $(".workspace-grid").classList.toggle("inspector-hidden", !visible);
  $("#inspector").hidden = !visible;
  const button = $("#toggle-inspector");
  button.setAttribute("aria-expanded", String(visible));
  button.setAttribute("aria-label", `${visible ? "Ocultar" : "Mostrar"} panel de detalles`);
  button.title = button.getAttribute("aria-label");
  if (state.policy) syncEditorLock();
}

$("#toggle-inspector").addEventListener("click", () => {
  setInspectorVisible($("#inspector").hidden);
});

function setFocusMode(enabled) {
  if (enabled === state.focusMode) return;
  if (enabled) state.inspectorBeforeFocus = !$("#inspector").hidden;
  state.focusMode = enabled;
  document.body.classList.toggle("focus-mode", enabled);
  setInspectorVisible(enabled ? false : state.inspectorBeforeFocus);
  const button = $("#focus-mode-button");
  button.setAttribute("aria-pressed", String(enabled));
  button.setAttribute("aria-label", enabled ? "Salir del modo enfoque" : "Activar modo enfoque");
  button.title = enabled ? "Salir del modo enfoque (Escape)" : "Modo enfoque · ampliar árbol";
  button.querySelector("path").setAttribute("d", enabled
    ? "M3 9h6V3m0 6L3 3m18 12h-6v6m0-6 6 6"
    : "M8 3H3v5m0-5 6 6m7 12h5v-5m0 5-6-6");
  $("#focus-version-context").hidden = !enabled;
  syncVersionUi();
  // Keep the selected node visible when a sidebar changes the available width.
  requestAnimationFrame(() => {
    if (enabled) focusNode();
    button.focus({ preventScroll: true });
  });
}

$("#focus-mode-button").addEventListener("click", () => setFocusMode(!state.focusMode));

function loadNodePositions() {
  const key = `credit-policy-layout:${state.policy.metadata.policy_id}:${state.policy.metadata.version}`;
  if (key === state.positionKey) return;
  state.positionKey = key;
  state.nodePositions = {};
  state.lastMove = null;
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) || "{}");
    Object.entries(saved).forEach(([id, position]) => {
      if (state.policy.nodes[id] && Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
        state.nodePositions[id] = { x: position.x, y: position.y };
      }
    });
  } catch { /* A missing or obsolete layout falls back to the automatic layout. */ }
}

function storeNodePositions() {
  try { window.localStorage.setItem(state.positionKey, JSON.stringify(state.nodePositions)); }
  catch { toast("La distribución se mantiene en esta sesión; el navegador no pudo guardarla.", true); }
}

$("#auto-layout").addEventListener("click", () => {
  if (!Object.keys(state.nodePositions).length) { fitTree(); return; }
  state.lastMove = structuredClone(state.nodePositions);
  state.nodePositions = {};
  storeNodePositions();
  renderTree();
  fitTree();
  toast("Distribución automática aplicada");
});
$("#undo-layout").addEventListener("click", () => {
  if (!state.lastMove) return;
  state.nodePositions = state.lastMove;
  state.lastMove = null;
  storeNodePositions();
  renderTree();
  toast("Distribución anterior restaurada");
});

function renderMinimap() {
  if (!state.layout) return;
  const { width, height, x, y, minX, minY } = state.layout;
  const scale = Math.min(164 / width, 88 / height);
  const offsetX = (180 - width * scale) / 2 - minX * scale;
  const offsetY = (104 - height * scale) / 2 - minY * scale;
  state.minimap = { scale, offsetX, offsetY };
  const group = $("#minimap-content");
  group.setAttribute("transform", `translate(${offsetX} ${offsetY}) scale(${scale})`);
  group.innerHTML = Object.values(state.policy.nodes).map((node) => {
    const links = edges(node).map(({ target }) => target).filter((child) => hasNode(state.policy, child)).map((child) =>
      `<path d="M${x[node.id] + NODE_WIDTH / 2},${y[node.id] + NODE_HEIGHT} L${x[child] + NODE_WIDTH / 2},${y[child]}"/>`
    ).join("");
    return `${links}<rect x="${x[node.id]}" y="${y[node.id]}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="12" class="mini-node${node.id === state.selected ? " selected" : ""}"/>`;
  }).join("");
  updateMinimapWindow();
}

function updateMinimapWindow() {
  if (!state.minimap) return;
  const { scale, offsetX, offsetY } = state.minimap;
  const viewport = $("#tree-viewport");
  const rect = $("#minimap-window");
  rect.setAttribute("x", offsetX - viewportState.x / viewportState.scale * scale);
  rect.setAttribute("y", offsetY - viewportState.y / viewportState.scale * scale);
  rect.setAttribute("width", viewport.clientWidth / viewportState.scale * scale);
  rect.setAttribute("height", viewport.clientHeight / viewportState.scale * scale);
}

$("#minimap").addEventListener("click", (event) => {
  if (!state.minimap) return;
  if (event.detail === 0) { fitTree(); return; }
  const svg = $("#minimap-svg");
  const matrix = svg.getScreenCTM();
  if (!matrix) return;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  const { scale, offsetX, offsetY } = state.minimap;
  const viewport = $("#tree-viewport");
  viewportState.x = viewport.clientWidth / 2 - (point.x - offsetX) / scale * viewportState.scale;
  viewportState.y = viewport.clientHeight / 2 - (point.y - offsetY) / scale * viewportState.scale;
  applyViewportTransform();
});

function renderNodeSearch() {
  if (!state.policy) return;
  const normalize = (value) => String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const query = normalize($("#node-search").value.trim());
  const matches = Object.values(state.policy.nodes).filter((node) => {
    const fields = (node.validations || [node]).map((rule) => fieldLabels[rule.field] || "");
    return normalize([node.label, node.id, nodeTypeLabel(node), ...fields].join(" ")).includes(query);
  });
  $("#node-search-count").textContent = matches.length
    ? `${matches.length} ${matches.length === 1 ? "nodo encontrado" : "nodos encontrados"}`
    : "No encontramos nodos. Probá con otro nombre o variable.";
  $("#node-search-results").replaceChildren(...matches.map((node) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "node-search-result";
    button.innerHTML = `<span class="search-node-icon" aria-hidden="true">${node.type === "condition" ? "◇" : "○"}</span><span><strong>${escapeHtml(node.label)}</strong><small>${nodeTypeLabel(node)} · Nivel ${state.layout.depth[node.id] + 1}</small></span><span class="search-arrow" aria-hidden="true">↗</span>`;
    button.addEventListener("click", async () => {
      $("#node-search-dialog").close();
      if (!await requestNodeSelection(node.id)) return;
      requestAnimationFrame(() => {
        focusNode(node.id);
        $$(".tree-node").find((element) => element.dataset.nodeId === node.id)?.focus({ preventScroll: true });
      });
    });
    return button;
  }));
}

function openNodeSearch() {
  if (!state.layout || state.loadingPolicy) return;
  $("#node-search").value = "";
  renderNodeSearch();
  $("#node-search-dialog").showModal();
  $("#node-search").focus();
}

$("#find-node-button").addEventListener("click", openNodeSearch);
$("#node-search-close").addEventListener("click", () => $("#node-search-dialog").close());
$("#node-search").addEventListener("input", renderNodeSearch);
$("#node-search").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "Enter") {
    event.preventDefault();
    const first = $(".node-search-result");
    if (event.key === "Enter") first?.click();
    else first?.focus();
  }
});
$("#node-search-results").addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === "ArrowDown" ? event.target.nextElementSibling : event.target.previousElementSibling;
  (next || $("#node-search")).focus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.nodeDrag) {
    event.preventDefault();
    finishNodeDrag(true);
    return;
  }
  if (event.key === "Escape" && state.connecting) {
    event.preventDefault();
    editorControls.cancelConnection();
    return;
  }
  if (state.saving || state.loadingPolicy) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !$("dialog[open]")) {
    event.preventDefault();
    openNodeSearch();
  }
  if (event.key === "Escape" && state.focusMode && !$("dialog[open]")) {
    event.preventDefault();
    setFocusMode(false);
  }
});

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${error ? " error" : ""}`;
  window.setTimeout(() => { element.className = "toast"; }, 2800);
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `${response.status} ${response.statusText}`);
  }
  return response.json();
}

function clampZoom(scale) {
  const viewport = $("#tree-viewport");
  const fittedScale = state.layout ? fitViewport(
    state.layout.width, state.layout.height, viewport.clientWidth, viewport.clientHeight,
  ).scale : MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(Math.min(MIN_ZOOM, fittedScale), scale));
}

function applyViewportTransform() {
  $("#tree-stage").style.transform = `translate3d(${viewportState.x}px, ${viewportState.y}px, 0) scale(${viewportState.scale})`;
  $("#zoom-level").textContent = `${Math.round(viewportState.scale * 100)}%`;
  updateMinimapWindow();
  $$(".link-label-group").forEach((group) => {
    const x = Number(group.dataset.anchorX);
    const y = Number(group.dataset.anchorY);
    const inverseScale = Math.min(1.5, 1 / viewportState.scale);
    group.setAttribute("transform", `translate(${x} ${y}) scale(${inverseScale}) translate(${-x} ${-y})`);
  });
}

function fitTree() {
  const viewport = $("#tree-viewport");
  if (!state.layout || !viewport.clientWidth || !viewport.clientHeight) return;
  Object.assign(viewportState, fitViewport(
    state.layout.width, state.layout.height, viewport.clientWidth, viewport.clientHeight,
  ));
  viewportState.x -= state.layout.minX * viewportState.scale;
  viewportState.y -= state.layout.minY * viewportState.scale;
  viewportState.viewportWidth = viewport.clientWidth;
  viewportState.viewportHeight = viewport.clientHeight;
  viewportState.initialized = true;
  applyViewportTransform();
}

function focusNode(id = state.selected) {
  if (!state.layout || !state.policy.nodes[id]) return;
  const viewport = $("#tree-viewport");
  viewportState.scale = 1;
  viewportState.x = viewport.clientWidth / 2 - state.layout.x[id] - NODE_WIDTH / 2;
  viewportState.y = viewport.clientHeight / 2 - state.layout.y[id] - NODE_HEIGHT / 2;
  viewportState.viewportWidth = viewport.clientWidth;
  viewportState.viewportHeight = viewport.clientHeight;
  applyViewportTransform();
}

function zoomAt(clientX, clientY, nextScale) {
  const viewport = $("#tree-viewport");
  const rect = viewport.getBoundingClientRect();
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  const worldX = (localX - viewportState.x) / viewportState.scale;
  const worldY = (localY - viewportState.y) / viewportState.scale;
  viewportState.scale = clampZoom(nextScale);
  viewportState.x = localX - worldX * viewportState.scale;
  viewportState.y = localY - worldY * viewportState.scale;
  applyViewportTransform();
}

function zoomFromCenter(factor) {
  const viewport = $("#tree-viewport");
  const rect = viewport.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, viewportState.scale * factor);
}

function renderTree() {
  if (!state.policy) return;
  loadNodePositions();
  state.layout = positionedLayout(state.policy, state.nodePositions);
  const { x, y, width, height, minX, minY } = state.layout;
  $("#tree-size").textContent = `${Object.keys(state.policy.nodes).length} nodos`;
  $("#undo-layout").hidden = !state.lastMove;
  const nodeCounts = Object.fromEntries((state.dashboard?.nodes || []).map((n) => [n.node_id, n.count]));
  const pathCounts = new Map((state.dashboard?.paths || []).map((p) => [`${p.source}:${p.target}`, Number(p.count)]));
  const maxPathCount = Math.max(1, ...pathCounts.values());
  const stage = $("#tree-stage");
  stage.style.width = `${width}px`; stage.style.height = `${height}px`;
  const nodes = $("#tree-nodes"); nodes.innerHTML = "";
  const svg = $("#tree-links");
  svg.setAttribute("viewBox", `${minX} ${minY} ${width} ${height}`);
  svg.style.left = `${minX}px`; svg.style.top = `${minY}px`;
  svg.innerHTML = "";

  Object.values(state.policy.nodes).forEach((node) => {
    const button = document.createElement("button");
    const decisionClass = node.type === "decision" ? ` decision ${node.decision}` : "";
    button.className = `tree-node${decisionClass}${state.selected === node.id ? " selected" : ""}${state.layout.connected.has(node.id) ? "" : " disconnected"}`;
    button.style.left = `${x[node.id]}px`; button.style.top = `${y[node.id]}px`;
    const count = state.mode === "impact" ? `<span class="impact-badge">${nodeCounts[node.id] || 0}</span>` : "";
    button.type = "button";
    button.dataset.nodeId = node.id;
    button.setAttribute("aria-pressed", String(state.selected === node.id));
    button.title = node.label;
    button.innerHTML = `<span class="type"><span>${node.id === state.policy.root_node ? "Inicio · " : ""}${nodeTypeLabel(node)}${state.layout.connected.has(node.id) ? "" : " · Sin conectar"}</span>${count}</span><strong>${escapeHtml(node.label)}</strong>`;
    button.addEventListener("click", async () => {
      if (viewportState.dragged) return;
      if (!await requestNodeSelection(node.id)) return;
      if (viewportState.scale < 0.65) focusNode(node.id);
    });
    button.addEventListener("focus", () => {
      if (button.matches(":focus-visible")) focusNode(node.id);
    });
    nodes.appendChild(button);

    edges(node).forEach(({ branch, target: child }, index) => {
      if (state.mode === "edit") {
        const port = document.createElement("button");
        port.type = "button";
        port.className = `branch-port${child === null ? " pending" : ""}`;
        port.dataset.source = node.id;
        port.dataset.branch = branch;
        port.textContent = `${index === 0 ? "Sí" : "No"} →`;
        port.setAttribute("aria-label", `Conectar rama ${index === 0 ? "Sí" : "No"} de ${node.label}`);
        port.style.left = `${x[node.id] + index * NODE_WIDTH / 2}px`;
        port.style.top = `${y[node.id] + NODE_HEIGHT + 3}px`;
        port.addEventListener("click", () => editorControls.startConnection(node.id, branch));
        nodes.append(port);
      }
      if (!hasNode(state.policy, child)) return;
      const { startX, startY } = connectionStart(node.id, branch);
      const endX = x[child] + NODE_WIDTH / 2, endY = y[child];
      const middle = startY + (endY - startY) / 2;
      const ns = "http://www.w3.org/2000/svg";
      const path = document.createElementNS(ns, "path");
      path.dataset.source = node.id;
      path.dataset.target = child;
      path.dataset.branch = branch;
      path.setAttribute("d", `M ${startX} ${startY} C ${startX} ${middle}, ${endX} ${middle}, ${endX} ${endY}`);
      const flowCount = pathCounts.get(`${node.id}:${child}`) || 0;
      const hasImpact = state.mode === "impact" && flowCount > 0;
      path.setAttribute("class", `tree-link${hasImpact ? " active" : ""}`);
      if (hasImpact) path.style.strokeWidth = `${1.25 + (flowCount / maxPathCount) * 0.75}px`;
      svg.appendChild(path);
      const labelX = state.mode === "impact" ? (startX + endX) / 2 : startX + (endX - startX) * 0.2;
      const labelY = state.mode === "impact" ? middle : startY + 24;
      const labelGroup = document.createElementNS(ns, "g");
      labelGroup.setAttribute("class", `link-label-group ${state.mode}`);
      labelGroup.dataset.anchorX = `${labelX}`;
      labelGroup.dataset.anchorY = `${labelY}`;
      const branchLabel = index === 0 ? "Sí" : "No";
      if (state.mode === "impact") {
        const countLabel = document.createElementNS(ns, "text");
        countLabel.setAttribute("x", `${labelX + 3}`);
        countLabel.setAttribute("y", `${labelY + 3}`);
        countLabel.setAttribute("text-anchor", "start");
        countLabel.setAttribute("class", "flow-count");
        countLabel.textContent = flowCount.toLocaleString("es-AR");
        const branch = document.createElementNS(ns, "text");
        branch.setAttribute("x", `${labelX - 3}`);
        branch.setAttribute("y", `${labelY + 3}`);
        branch.setAttribute("text-anchor", "end");
        branch.setAttribute("class", "link-label");
        branch.textContent = branchLabel;
        labelGroup.append(branch, countLabel);
      }
      svg.appendChild(labelGroup);
    });
  });
  renderMinimap();
  editorControls?.syncControls();
  if (!viewportState.initialized) requestAnimationFrame(fitTree);
  else applyViewportTransform();
}

function connectionStart(source, branch) {
  const index = branch === "true_node" ? 0 : 1;
  return {
    startX: state.layout.x[source] + (state.mode === "edit" ? index * NODE_WIDTH / 2 + 48 : NODE_WIDTH / 2),
    startY: state.layout.y[source] + NODE_HEIGHT + (state.mode === "edit" ? 28 : 0),
  };
}

function paintNodeDrag() {
  const drag = state.nodeDrag;
  if (!drag?.active) return;
  const position = draggedPosition(drag.start, drag.dx, drag.dy, drag.scale);
  state.layout.x[drag.id] = position.x;
  state.layout.y[drag.id] = position.y;
  drag.element.style.left = `${position.x}px`;
  drag.element.style.top = `${position.y}px`;
  $$(".branch-port").filter((port) => port.dataset.source === drag.id).forEach((port) => {
    port.style.left = `${position.x + (port.dataset.branch === "true_node" ? 0 : NODE_WIDTH / 2)}px`;
    port.style.top = `${position.y + NODE_HEIGHT + 3}px`;
  });
  $$("#tree-links .tree-link").forEach((path) => {
    const { source, target, branch } = path.dataset;
    const { startX, startY } = connectionStart(source, branch);
    const endX = state.layout.x[target] + NODE_WIDTH / 2;
    const endY = state.layout.y[target];
    const middle = startY + (endY - startY) / 2;
    path.setAttribute("d", `M ${startX} ${startY} C ${startX} ${middle}, ${endX} ${middle}, ${endX} ${endY}`);
    const group = path.nextElementSibling;
    const nextX = state.mode === "impact" ? (startX + endX) / 2 : startX + (endX - startX) * 0.2;
    const nextY = state.mode === "impact" ? middle : startY + 24;
    const dx = nextX - Number(group.dataset.anchorX);
    const dy = nextY - Number(group.dataset.anchorY);
    group.querySelectorAll("text").forEach((label) => {
      label.setAttribute("x", Number(label.getAttribute("x")) + dx);
      label.setAttribute("y", Number(label.getAttribute("y")) + dy);
    });
    group.dataset.anchorX = nextX;
    group.dataset.anchorY = nextY;
  });
  renderMinimap();
  applyViewportTransform();
  drag.frame = null;
}

async function finishNodeDrag(cancelled = false) {
  const drag = state.nodeDrag;
  if (!drag) return;
  if (drag.frame) cancelAnimationFrame(drag.frame);
  if (drag.active && !cancelled) {
    paintNodeDrag();
    state.lastMove = structuredClone(state.nodePositions);
    state.nodePositions[drag.id] = {
      x: Math.round(state.layout.x[drag.id]), y: Math.round(state.layout.y[drag.id]),
    };
    storeNodePositions();
  }
  state.nodeDrag = null;
  $("#tree-viewport").classList.remove("moving-node");
  if (drag.active) renderTree();
  viewportState.dragged = true;
  window.setTimeout(() => { viewportState.dragged = false; }, 0);
  if (!cancelled && await requestNodeSelection(drag.id)) {
    if (!drag.active && viewportState.scale < 0.65) focusNode(drag.id);
  }
}

function setupViewportInteractions() {
  const viewport = $("#tree-viewport");
  viewport.addEventListener("wheel", (event) => {
    if (state.nodeDrag) { event.preventDefault(); return; }
    if (event.target.closest(".minimap, .canvas-controls")) return;
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, viewportState.scale * Math.exp(-event.deltaY * 0.0015));
  }, { passive: false });

  viewport.addEventListener("pointerdown", (event) => {
    if (state.saving || state.loadingPolicy) return;
    if (event.button !== 0 || event.target.closest(".canvas-controls, .minimap, .branch-port")) return;
    const node = event.target.closest(".tree-node");
    if (state.connecting && node) return;
    if (node) {
      if (state.nodeDrag || viewportState.pointers.size) return;
      event.preventDefault();
      const id = node.dataset.nodeId;
      state.nodeDrag = {
        id, element: node, pointerId: event.pointerId, active: false,
        clientX: event.clientX, clientY: event.clientY, dx: 0, dy: 0,
        start: { x: state.layout.x[id], y: state.layout.y[id] }, scale: viewportState.scale,
      };
      viewport.setPointerCapture(event.pointerId);
      return;
    }
    if (state.nodeDrag) return;
    viewport.setPointerCapture(event.pointerId);
    viewportState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewportState.lastPoint = { x: event.clientX, y: event.clientY };
    viewportState.dragged = false;
    viewport.classList.add("dragging");
  });

  viewport.addEventListener("pointermove", (event) => {
    const drag = state.nodeDrag;
    if (drag?.pointerId === event.pointerId) {
      drag.dx = event.clientX - drag.clientX;
      drag.dy = event.clientY - drag.clientY;
      if (!drag.active && Math.hypot(drag.dx, drag.dy) < 5) return;
      drag.active = true;
      drag.element.classList.add("moving");
      viewport.classList.add("moving-node");
      if (!drag.frame) drag.frame = requestAnimationFrame(paintNodeDrag);
      return;
    }
    if (!viewportState.pointers.has(event.pointerId)) return;
    viewportState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...viewportState.pointers.values()];
    if (points.length === 1 && viewportState.lastPoint) {
      const dx = event.clientX - viewportState.lastPoint.x;
      const dy = event.clientY - viewportState.lastPoint.y;
      if (Math.abs(dx) + Math.abs(dy) > 1) viewportState.dragged = true;
      viewportState.x += dx;
      viewportState.y += dy;
      viewportState.lastPoint = { x: event.clientX, y: event.clientY };
      applyViewportTransform();
    } else if (points.length === 2) {
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      const midpoint = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      if (viewportState.pinchDistance) zoomAt(midpoint.x, midpoint.y, viewportState.scale * distance / viewportState.pinchDistance);
      viewportState.pinchDistance = distance;
      viewportState.dragged = true;
    }
  });

  const releasePointer = (event) => {
    if (state.nodeDrag?.pointerId === event.pointerId) {
      finishNodeDrag(event.type === "pointercancel" || event.type === "lostpointercapture");
      return;
    }
    viewportState.pointers.delete(event.pointerId);
    viewportState.pinchDistance = null;
    viewportState.lastPoint = viewportState.pointers.size === 1 ? [...viewportState.pointers.values()][0] : null;
    if (!viewportState.pointers.size) {
      viewport.classList.remove("dragging");
      window.setTimeout(() => { viewportState.dragged = false; }, 0);
    }
  };
  viewport.addEventListener("pointerup", releasePointer);
  viewport.addEventListener("pointercancel", releasePointer);
  viewport.addEventListener("lostpointercapture", releasePointer);
  viewport.addEventListener("dblclick", (event) => {
    if (!event.target.closest("button")) fitTree();
  });
  viewport.addEventListener("keydown", (event) => {
    if (event.target.closest(".canvas-controls, .minimap")) return;
    if (event.key === "+" || event.key === "=") zoomFromCenter(1.15);
    else if (event.key === "-") zoomFromCenter(1 / 1.15);
    else if (event.key === "0") fitTree();
    else if (event.key.toLowerCase() === "f") focusNode();
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      const step = event.shiftKey ? 160 : 60;
      viewportState.x += event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
      viewportState.y += event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
      applyViewportTransform();
    } else return;
    event.preventDefault();
  });
  $("#zoom-in").addEventListener("click", () => zoomFromCenter(1.18));
  $("#zoom-out").addEventListener("click", () => zoomFromCenter(1 / 1.18));
  $("#zoom-reset").addEventListener("click", () => zoomFromCenter(1 / viewportState.scale));
  $("#fit-tree").addEventListener("click", fitTree);
  $("#focus-node").addEventListener("click", () => focusNode());
  $("#locate-node").addEventListener("click", () => focusNode());
  viewportState.viewportWidth = viewport.clientWidth;
  viewportState.viewportHeight = viewport.clientHeight;
  new ResizeObserver(() => {
    if (viewportState.initialized) {
      viewportState.x += (viewport.clientWidth - viewportState.viewportWidth) / 2;
      viewportState.y += (viewport.clientHeight - viewportState.viewportHeight) / 2;
      applyViewportTransform();
    }
    viewportState.viewportWidth = viewport.clientWidth;
    viewportState.viewportHeight = viewport.clientHeight;
  }).observe(viewport);
  const toolbar = $(".canvas-toolbar");
  new ResizeObserver(() => {
    $(".workspace-grid").style.setProperty("--canvas-toolbar-height", `${toolbar.offsetHeight}px`);
  }).observe(toolbar);
}

async function requestNodeSelection(id) {
  if (state.saving || state.loadingPolicy) return false;
  if (state.connecting) {
    editorControls.changeConnection(state.connecting.source, state.connecting.branch, id);
    return false;
  }
  if (id === state.selected) { setInspectorVisible(true); return true; }
  if (!editorControls.captureNodeForm()) return false;
  selectNode(id);
  return true;
}

function selectNode(id) {
  state.selected = id;
  const node = state.policy.nodes[id];
  $("#inspector-title").textContent = node.label;
  $("#node-tag").textContent = node.type === "condition" ? "CONDICIÓN" : "RESULTADO";
  $("#node-label").value = node.label;
  const condition = node.type === "condition";
  $("#condition-fields").hidden = !condition; $("#decision-fields").hidden = condition;
  if (condition) {
    $("#node-combination").value = node.combination || "none";
    $("#node-validations").replaceChildren();
    (node.validations || [node]).forEach(addValidationRow);
  } else {
    $("#node-decision").value = node.decision; $("#node-band").value = node.risk_band; $("#node-limit").value = node.credit_limit;
    $("#node-reason").value = node.reason_code;
  }
  if (!state.layout || !$("#tree-nodes").children.length) renderTree();
  $$(".tree-node").forEach((button) => {
    const selected = button.dataset.nodeId === id;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  renderMinimap();
  $("#node-location").textContent = id === state.policy.root_node
    ? "Inicio de la política"
    : `Nivel ${(state.layout?.depth[id] || 0) + 1} de la política`;
  setInspectorVisible(true);
  editorControls?.onSelection();
  syncEditorLock();
}

function renderValidationThreshold(row, value) {
  const operator = row.querySelector("[data-validation-operator]").value;
  const isNullCheck = ["is_null", "has_value"].includes(operator);
  const control = document.createElement(isNullCheck ? "select" : "input");
  control.dataset.validationValue = "";
  control.required = true;
  if (isNullCheck) {
    control.add(new Option("Sí", "true"));
    control.add(new Option("No", "false"));
    control.value = String(typeof value === "boolean" ? value : true);
  } else {
    control.type = operator === "in" ? "text" : "number";
    if (operator === "in") {
      control.placeholder = "[600, 700, 800]";
      control.value = Array.isArray(value) ? JSON.stringify(value) : "";
      control.addEventListener("input", () => control.setCustomValidity(""));
    } else {
      control.step = "any";
      control.value = typeof value === "number" ? value : "";
    }
  }
  row.querySelector("[data-validation-value]").replaceWith(control);
}

function addValidationRow(validation = { field: "score_1", operator: "gte", value: 0 }) {
  const row = $("#validation-template").content.firstElementChild.cloneNode(true);
  const field = row.querySelector("[data-validation-field]");
  Object.entries(fieldLabels).forEach(([value, label]) => field.add(new Option(label, value)));
  field.value = validation.field;
  row.querySelector("[data-validation-operator]").value = validation.operator;
  renderValidationThreshold(row, validation.value);
  $("#node-validations").append(row);
}

function readValidations() {
  return $$(".validation-row").map((row) => {
    const field = row.querySelector("[data-validation-field]").value;
    const operator = row.querySelector("[data-validation-operator]").value;
    const control = row.querySelector("[data-validation-value]");
    let value;
    if (["is_null", "has_value"].includes(operator)) value = control.value === "true";
    else if (operator === "in") {
      try {
        value = JSON.parse(control.value);
        if (!Array.isArray(value)) throw new Error("Expected an array");
      } catch {
        control.setCustomValidity("Ingresá una lista JSON, por ejemplo [600, 700, 800].");
        control.reportValidity();
        throw new Error("El umbral debe ser una lista JSON válida");
      }
    } else value = Number(control.value);
    return { field, operator, value };
  });
}

$("#node-combination").addEventListener("change", syncEditorLock);
$("#add-validation").addEventListener("click", () => {
  if ($("#add-validation").disabled) return;
  addValidationRow();
  syncEditorLock();
  $("#node-validations").lastElementChild.querySelector("select").focus();
});
$("#node-validations").addEventListener("click", (event) => {
  if (!event.target.closest(".remove-validation") || event.target.closest(".remove-validation").disabled) return;
  event.target.closest(".validation-row").remove();
  syncEditorLock();
});
$("#node-validations").addEventListener("change", (event) => {
  if (!event.target.matches("[data-validation-operator]")) return;
  const row = event.target.closest(".validation-row");
  const previous = row.querySelector("[data-validation-value]");
  const value = previous.type === "number" && previous.value !== "" ? Number(previous.value) : undefined;
  renderValidationThreshold(row, value);
  syncEditorLock();
});

function updateMetrics(data) {
  const total = data.total || 0;
  const counts = Object.fromEntries((data.decisions || []).map((item) => [item.decision, Number(item.count)]));
  $("#metric-total").textContent = total.toLocaleString("es-AR");
  [["APPROVED", "approved"], ["REVIEW", "review"], ["REJECTED", "rejected"]].forEach(([key, id]) => {
    const count = counts[key] || 0;
    $(`#metric-${id}`).textContent = count.toLocaleString("es-AR");
    $(`#${id}-share`).textContent = total ? `${Math.round(count * 100 / total)}% del total` : "sin ejecuciones";
  });
  const run = data.latest_run;
  $("#run-context").textContent = run
    ? `Corrida ${run.run_id.slice(0, 8)} · ${run.processed_rows} usuarios · v${run.policy_version}`
    : "Esta versión todavía no tiene una corrida";
}

function setMetricsLoading(loading, label = "Actualizando métricas…") {
  const element = $("#metrics-loading");
  element.hidden = !loading;
  $("#metrics-loading-label").textContent = label;
  $(".impact-summary").setAttribute("aria-busy", String(loading));
}

function setEvaluationState(stage) {
  const status = $("#evaluation-status");
  const button = $("#run-button");
  const states = {
    starting: ["Preparando evaluación…", "Validando la versión y el dataset."],
    running: ["Ejecutando evaluación…", "Procesando los usuarios con la versión seleccionada."],
    results: ["Cargando resultados…", "Actualizando métricas y recorridos."],
    success: ["Evaluación lista", "Las métricas corresponden a esta corrida."],
    error: ["No se pudo completar", "Revisá el mensaje de error e intentá nuevamente."],
  };
  if (!stage) {
    status.hidden = true;
    status.removeAttribute("data-stage");
    button.disabled = false;
    button.innerHTML = '<svg viewBox="0 0 24 24"><path d="m9 7 8 5-8 5z"></path></svg> Iniciar evaluación';
    return;
  }
  const [title, detail] = states[stage];
  status.hidden = false;
  status.dataset.stage = stage;
  $("#evaluation-status-title").textContent = title;
  $("#evaluation-status-detail").textContent = detail;
  const busy = ["starting", "running", "results"].includes(stage);
  button.disabled = busy;
  button.innerHTML = busy
    ? `<span class="spinner button-spinner" aria-hidden="true"></span>${title.replace("…", "")}`
    : '<svg viewBox="0 0 24 24"><path d="m9 7 8 5-8 5z"></path></svg> Iniciar evaluación';
}

async function refreshDashboard(runId = null, policyVersion = state.policy?.metadata.version) {
  const requestId = ++state.dashboardRequest;
  const query = new URLSearchParams();
  if (runId) query.set("run_id", runId);
  else if (policyVersion) query.set("policy_version", policyVersion);
  setMetricsLoading(true);
  try {
    const dashboard = await api(`/api/dashboard?${query.toString()}`);
    if (requestId !== state.dashboardRequest) return;
    state.dashboard = dashboard;
    updateMetrics(state.dashboard);
    renderTree();
  } finally {
    if (requestId === state.dashboardRequest) setMetricsLoading(false);
  }
}

function syncVersionUi() {
  const selectedVersion = state.mode === "edit"
    ? state.editingVersion
    : state.policy?.metadata.version;
  const isProductive = selectedVersion === state.activeVersion;
  const isHistoricalRun = state.mode === "impact" && Boolean($("#run-select")?.value);
  $("#production-context").textContent = `Producción · v${state.activeVersion || "—"}`;
  $("#focus-version-context").textContent = `${selectedVersion || "—"} · ${
    isHistoricalRun ? "Evaluación histórica" : isProductive ? "Productiva · solo lectura" : "Candidata"
  }`;
  $("#version-kind").textContent = isHistoricalRun
    ? "Revisión usada por la corrida"
    : (isProductive ? "Versión productiva" : "Versión candidata");
  $("#header-status").textContent = state.mode === "edit"
    ? (isProductive ? "Productiva" : "Candidata")
    : (isHistoricalRun ? "Histórica" : (isProductive ? "Productiva" : "Candidata"));
  $("#promote-button").hidden = state.mode !== "impact" || isProductive || isHistoricalRun;
  $("#publish-button").textContent = "Crear nueva versión";
  syncEditorLock();
}

function syncEditorLock() {
  const isProductive = state.editingVersion === state.activeVersion;
  const locked = state.mode === "impact" || isProductive || state.saving || state.loadingPolicy;
  editorControls?.syncControls();
  $$("#node-form input, #node-form select, #node-form button").forEach((control) => {
    control.disabled = locked || Boolean(control.closest("#condition-fields[hidden], #decision-fields[hidden]"));
  });
  const rows = $$(".validation-row");
  const combination = $("#node-combination").value;
  $("#add-validation").disabled = locked || combination === "none";
  rows.forEach((row, index) => {
    row.querySelector("legend").textContent = `Validación ${index + 1}`;
    row.querySelector(".remove-validation").disabled = locked || rows.length === 1;
  });
  $('#node-combination option[value="none"]').disabled = rows.length > 1;
  $("#combination-help").textContent = combination === "none"
    ? "Una sola validación. Elegí AND u OR para agregar más."
    : `${combination === "AND" ? "Deben cumplirse todas las validaciones." : "Debe cumplirse al menos una validación."} Para usar Sin combinación, dejá una sola validación.`;
  const kind = $("#editor-version-kind");
  const guidance = $("#editor-guidance");
  if (!kind || !guidance) return;
  kind.textContent = isProductive ? "Productiva · sólo lectura" : "Candidata · editable";
  guidance.classList.toggle("locked", isProductive);
  guidance.innerHTML = isProductive
    ? "<strong>Versión en producción</strong><span>Creá una candidata para empezar a editar.</span>"
    : "<strong>Lista para editar</strong><span>Los cambios se guardan en esta candidata.</span>";
}

function renderVersionLibrary() {
  const container = $("#versions-list");
  if (!container) return;
  container.innerHTML = state.versions.map((item) => {
    const date = new Date(item.created_at).toLocaleDateString("es-AR");
    const version = escapeHtml(item.version);
    const current = item.version === state.policy?.metadata.version;
    return `<article class="version-item${item.active ? " productive" : ""}${current ? " current" : ""}">
      <div class="version-item-main"><i></i><div><strong>${version}${current ? ' <span class="current-version">· Abierta</span>' : ""}</strong><small>${date} · ${escapeHtml(item.created_by)}</small></div></div>
      <div class="version-item-actions"><span class="version-state">${item.active ? "Productiva" : "Candidata"}</span>
        <button class="button secondary" type="button" data-edit-version="${version}">${item.active ? "Ver" : "Editar"}</button>
        <button class="button secondary" type="button" data-evaluate-version="${version}">Evaluar</button>
        ${item.active ? "" : `<button class="button promote" type="button" data-promote-version="${version}">Productivizar</button>`}
      </div>
    </article>`;
  }).join("");
}

async function loadVersions({ evaluationVersion = null, editingVersion = state.editingVersion } = {}) {
  const priorEvaluation = $("#version-select").value;
  state.versions = await api("/api/policies");
  state.activeVersion = state.versions.find((item) => item.active)?.version || null;
  [$("#version-select"), $("#editor-version-select")].forEach((select) => {
    select.replaceChildren(...state.versions.map((item) => new Option(
      `${item.version} · ${item.active ? "Productiva" : "Candidata"}`, item.version,
    )));
  });
  const exists = (version) => state.versions.some((item) => item.version === version);
  const rememberedEditor = window.localStorage.getItem("credit-policy-editor-version");
  state.editingVersion = [editingVersion, rememberedEditor].find(exists)
    || state.versions.find((item) => !item.active)?.version
    || state.activeVersion;
  const selectedEvaluation = [evaluationVersion, priorEvaluation, state.editingVersion]
    .find(exists) || state.activeVersion;
  $("#editor-version-select").value = state.editingVersion;
  $("#version-select").value = selectedEvaluation;
  renderVersionLibrary();
  syncVersionUi();
}

async function withPolicyLoading(load) {
  if (state.loadingPolicy) return false;
  state.loadingPolicy = true;
  const controls = $$("button, input, select").filter((control) => !control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  editorControls.syncControls();
  try {
    await load();
    return true;
  } catch (error) {
    $("#editor-version-select").value = state.editingVersion;
    if (state.mode === "impact") $("#version-select").value = state.policy.metadata.version;
    throw error;
  } finally {
    state.loadingPolicy = false;
    controls.forEach((control) => { control.disabled = false; });
    syncEditorLock();
  }
}

async function loadEditorVersion(version) {
  if (!await editorControls.guard()) { $("#editor-version-select").value = state.editingVersion; return false; }
  return withPolicyLoading(async () => {
    state.policy = await api(`/api/policies/${encodeURIComponent(version)}`);
    state.editingVersion = version;
    state.selected = state.policy.root_node;
    state.editorDraft = structuredClone(state.policy);
    state.editorSelected = state.selected;
    window.localStorage.setItem("credit-policy-editor-version", version);
    $("#editor-version-select").value = version;
    viewportState.initialized = false;
    renderTree();
    selectNode(state.selected);
    editorControls.resetHistory();
    syncVersionUi();
  });
}

async function loadPolicyVersion(version, policySha256 = null, loadHistory = true) {
  return withPolicyLoading(async () => {
    const revisionQuery = policySha256 ? `?policy_sha256=${encodeURIComponent(policySha256)}` : "";
    state.policy = await api(`/api/policies/${encodeURIComponent(version)}${revisionQuery}`);
    state.selected = state.policy.root_node;
    viewportState.initialized = false;
    renderTree();
    selectNode(state.selected);
    if (loadHistory) await loadRuns(version);
    syncVersionUi();
  });
}

async function loadRuns(version = state.policy?.metadata.version, preferredRunId = null) {
  const query = new URLSearchParams({ policy_version: version, limit: "50" });
  state.runs = await api(`/api/runs?${query.toString()}`);
  const select = $("#run-select");
  const emptyOption = '<option value="">Nueva evaluación · configuración actual</option>';
  if (!state.runs.length) {
    select.innerHTML = emptyOption;
    select.disabled = false;
    state.dashboard = { total: 0, decisions: [], nodes: [], paths: [], latest_run: null };
    updateMetrics(state.dashboard);
    renderTree();
    return;
  }
  select.disabled = false;
  select.innerHTML = emptyOption + state.runs.map((run, index) => {
    const date = new Date(run.completed_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
    return `<option value="${run.run_id}">${index === 0 ? "Última · " : ""}${date} · ${run.processed_rows} usuarios · ${run.run_id.slice(0, 8)}</option>`;
  }).join("");
  const selectedRunId = preferredRunId && state.runs.some((run) => run.run_id === preferredRunId) ? preferredRunId : "";
  select.value = selectedRunId;
  if (selectedRunId) await refreshDashboard(selectedRunId);
  else {
    state.dashboard = { total: 0, decisions: [], nodes: [], paths: [], latest_run: null };
    updateMetrics(state.dashboard);
    renderTree();
  }
}

async function initialize() {
  state.policy = await api("/api/policy");
  await loadVersions({ evaluationVersion: state.policy.metadata.version });
  await loadEditorVersion(state.editingVersion);
  await loadRuns($("#version-select").value);
  if (new URLSearchParams(window.location.search).get("view") === "impact") await setMode("impact");
  if (window.matchMedia("(max-width: 1000px)").matches) setInspectorVisible(false);
}

$("#validate-button").addEventListener("click", async () => {
  if (state.saving || state.loadingPolicy || !editorControls.readyToSave()) return;
  try { const result = await api("/api/policies/validate", { method: "POST", body: JSON.stringify({ policy: state.policy }) }); toast(`Política válida · ${result.nodes} nodos`); }
  catch (error) { toast(`No es válida: ${error.message}`, true); }
});

async function openNewVersionDialog() {
  if (state.saving || state.loadingPolicy || !editorControls.readyToSave()) return;
  $("#publish-version").value = "";
  $("#publish-author").value = state.policy.metadata.created_by;
  $("#publish-dialog").showModal();
}

$("#publish-button").addEventListener("click", () => {
  openNewVersionDialog();
});

$("#publish-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  if (state.saving || state.loadingPolicy || !editorControls.readyToSave()) return;
  const policy = structuredClone(state.policy);
  policy.metadata.version = $("#publish-version").value.trim(); policy.metadata.created_by = $("#publish-author").value.trim(); policy.metadata.created_at = new Date().toISOString(); policy.metadata.status = "draft";
  state.saving = true;
  $("#confirm-publish").disabled = true;
  syncEditorLock();
  try {
    await api("/api/policies/publish", { method: "POST", body: JSON.stringify({ policy }) });
    state.policy = policy;
    state.editingVersion = policy.metadata.version;
    editorControls.resetHistory();
    state.editorDraft = structuredClone(policy);
    state.editorSelected = state.selected;
    window.localStorage.setItem("credit-policy-editor-version", policy.metadata.version);
    await loadVersions({ evaluationVersion: policy.metadata.version, editingVersion: policy.metadata.version });
    $("#publish-dialog").close(); renderTree(); toast(`Versión ${policy.metadata.version} creada · producción no cambió`);
  } catch (error) { toast(`No se pudo crear la versión: ${error.message}`, true); }
  finally { state.saving = false; $("#confirm-publish").disabled = false; syncEditorLock(); }
});

async function executeEvaluation() {
  setEvaluationState("starting");
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  try {
    if (state.mode !== "impact" && !await setMode("impact")) { setEvaluationState(null); return; }
    setEvaluationState("running");
    const result = await api("/api/runs", { method: "POST", body: JSON.stringify({ instances: [{}], parameters: { limit: Number($("#run-limit").value), policy_version: state.policy.metadata.version } }) });
    setEvaluationState("results");
    await loadRuns(result.policy_version, result.run_id);
    setEvaluationState("success");
    toast(`${result.processed_rows} usuarios · versión ${result.policy_version}`);
    window.setTimeout(() => {
      if ($("#evaluation-status").dataset.stage === "success") setEvaluationState(null);
    }, 2800);
  }
  catch (error) {
    setEvaluationState("error");
    toast(`Falló la ejecución: ${error.message}`, true);
  }
}

$("#run-button").addEventListener("click", executeEvaluation);

async function setMode(mode) {
  if (state.saving || state.loadingPolicy) return false;
  if (mode === state.mode) return true;
  if (!await editorControls.guard()) return false;
  editorControls.cancelConnection();
  if (state.mode === "edit" && mode === "impact") {
    state.editorDraft = structuredClone(state.policy);
    state.editorSelected = state.selected;
    $("#version-select").value = state.editingVersion;
  }
  state.mode = mode;
  document.body.dataset.mode = mode;
  $$('.nav-item').forEach((item) => item.classList.toggle("active", (mode === "impact") === (item.dataset.view === "dashboard")));
  $("#view-title").textContent = mode === "impact" ? "Laboratorio de evaluación" : "Crédito de consumo";
  $("#canvas-subtitle").textContent = mode === "impact"
    ? "El volumen muestra por dónde recorrieron la política los usuarios analizados."
    : "Seleccioná un nodo para editar su regla.";
  if (mode === "impact") {
    const evaluationVersion = $("#version-select").value || state.activeVersion;
    await loadPolicyVersion(evaluationVersion);
  } else if (state.editorDraft) {
    state.policy = structuredClone(state.editorDraft);
    state.selected = state.editorSelected && state.policy.nodes[state.editorSelected]
      ? state.editorSelected
      : state.policy.root_node;
    renderTree();
    selectNode(state.selected);
  }
  syncVersionUi();
  viewportState.initialized = false;
  window.requestAnimationFrame(renderTree);
  return true;
}

$$('.nav-item').forEach((button) => button.addEventListener("click", async () => {
  try { await setMode(button.dataset.view === "dashboard" ? "impact" : "edit"); }
  catch (error) { toast(`No se pudo abrir la vista: ${error.message}`, true); }
}));

$("#version-select").addEventListener("change", async (event) => {
  setMetricsLoading(true, "Cargando versión…");
  try { await loadPolicyVersion(event.target.value); }
  catch (error) { toast(`No se pudo cargar la versión: ${error.message}`, true); }
  finally { setMetricsLoading(false); }
});

$("#editor-version-select").addEventListener("change", async (event) => {
  try { await loadEditorVersion(event.target.value); }
  catch (error) { toast(`No se pudo abrir la versión para editar: ${error.message}`, true); }
});

$("#run-select").addEventListener("change", async (event) => {
  const version = $("#version-select").value;
  setMetricsLoading(true, "Cargando corrida…");
  try {
    if (!event.target.value) {
      await loadPolicyVersion(version, null, false);
      state.dashboard = { total: 0, decisions: [], nodes: [], paths: [], latest_run: null };
      updateMetrics(state.dashboard);
      renderTree();
      return;
    }
    const run = state.runs.find((item) => item.run_id === event.target.value);
    await loadPolicyVersion(version, run?.policy_sha256 || null, false);
    await refreshDashboard(event.target.value);
    syncVersionUi();
  }
  catch (error) { toast(`No se pudo cargar la corrida: ${error.message}`, true); }
  finally { setMetricsLoading(false); }
});

async function openPromotion(version) {
  if (!await editorControls.guard()) return;
  state.pendingPromotionVersion = version;
  $("#promote-version").textContent = version;
  $("#promote-dialog").showModal();
}

$("#promote-button").addEventListener("click", () => openPromotion(state.policy.metadata.version));

$("#promote-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const version = state.pendingPromotionVersion;
  try {
    await api(`/api/policies/${encodeURIComponent(version)}/activate`, { method: "POST" });
    await loadVersions({
      evaluationVersion: state.policy.metadata.version,
      editingVersion: state.editingVersion,
    });
    $("#promote-dialog").close();
    toast(`Versión ${version} promovida a productiva`);
  } catch (error) { toast(`No se pudo promover: ${error.message}`, true); }
});

$("#versions-button").addEventListener("click", () => {
  renderVersionLibrary();
  $("#versions-dialog").showModal();
});
$("#versions-close").addEventListener("click", () => $("#versions-dialog").close());
$("#new-version-button").addEventListener("click", () => {
  $("#versions-dialog").close();
  openNewVersionDialog();
});
$("#versions-list").addEventListener("click", async (event) => {
  try {
    const editButton = event.target.closest("[data-edit-version]");
    const evaluateButton = event.target.closest("[data-evaluate-version]");
    const promoteButton = event.target.closest("[data-promote-version]");
    if (editButton) {
      const version = editButton.dataset.editVersion;
      $("#versions-dialog").close();
      if (state.mode !== "edit" && !await setMode("edit")) return;
      await loadEditorVersion(version);
    } else if (evaluateButton) {
      const version = evaluateButton.dataset.evaluateVersion;
      $("#versions-dialog").close();
      if (state.mode !== "impact" && !await setMode("impact")) return;
      $("#version-select").value = version;
      await loadPolicyVersion(version);
    } else if (promoteButton) {
      $("#versions-dialog").close();
      openPromotion(promoteButton.dataset.promoteVersion);
    }
  } catch (error) { toast(`No se pudo abrir la versión: ${error.message}`, true); }
});

$("#help-button").addEventListener("click", () => $("#help-dialog").showModal());
$("#help-close").addEventListener("click", () => $("#help-dialog").close());

function registerWebMcp() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  context.registerTool({
    name: "validate_policy_draft",
    title: "Validar borrador de política",
    description: "Valida el árbol visible sin publicarlo ni cambiar la versión activa.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    async execute() {
      if (state.saving || state.loadingPolicy || !editorControls.readyToSave()) throw new Error("El borrador tiene pendientes.");
      const result = await api("/api/policies/validate", { method: "POST", body: JSON.stringify({ policy: state.policy }) });
      toast(`Política válida · ${result.nodes} nodos`);
      return result;
    },
  });
  context.registerTool({
    name: "run_credit_scoring",
    title: "Ejecutar evaluación crediticia",
    description: "Evalúa la versión seleccionada sobre una cantidad acotada de usuarios y muestra únicamente esa corrida.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 10000 } }, required: ["limit"], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute({ limit }) {
      if (!await editorControls.guard()) throw new Error("Guardá o descartá el borrador antes de evaluar.");
      const result = await api("/api/runs", { method: "POST", body: JSON.stringify({ instances: [{}], parameters: { limit, policy_version: state.policy.metadata.version } }) });
      await loadRuns(result.policy_version, result.run_id);
      toast(`${result.processed_rows} usuarios · política ${result.policy_version}`);
      return { run_id: result.run_id, policy_version: result.policy_version, processed_rows: result.processed_rows, decisions: result.decisions };
    },
  });
}

editorControls = setupEditorControls({
  state, api, toast, renderTree, selectNode, focusNode, syncEditorLock, syncVersionUi,
  readValidations, addValidationRow, fieldLabels, escapeHtml, requestNodeSelection,
  revealInspector: () => setInspectorVisible(true),
});
window.addEventListener("beforeunload", (event) => {
  if (state.editorDirty || state.saving) { event.preventDefault(); event.returnValue = ""; }
});
setupViewportInteractions();
initialize().then(registerWebMcp).catch((error) => toast(`No se pudo iniciar: ${error.message}`, true));

// The browser regression suite imports module state without adding window globals.
export { state, setMode };
