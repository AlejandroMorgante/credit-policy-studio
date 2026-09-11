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
  savedPolicy: null,
  editorDirty: false,
  saving: false,
  editorLoading: false,
  insertion: null,
  connecting: null,
  formBaseline: null,
};
const draftHistory = { past: [], future: [], current: null, group: null };
const HISTORY_LIMIT = 100;
const viewportState = {
  x: 0,
  y: 0,
  scale: 1,
  initialized: false,
  pointers: new Map(),
  lastPoint: null,
  pinchDistance: null,
  dragged: false,
};
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 1.5;
const NODE_WIDTH = 188;
const NODE_HEIGHT = 80;
const LEVEL_GAP = 136;
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
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

function applyViewportTransform() {
  $("#tree-stage").style.transform = `translate3d(${viewportState.x}px, ${viewportState.y}px, 0) scale(${viewportState.scale})`;
  $("#zoom-level").textContent = `${Math.round(viewportState.scale * 100)}%`;
  $$(".link-label-group").forEach((group) => {
    const x = Number(group.dataset.anchorX);
    const y = Number(group.dataset.anchorY);
    const inverseScale = 1 / viewportState.scale;
    group.setAttribute("transform", `translate(${x} ${y}) scale(${inverseScale}) translate(${-x} ${-y})`);
  });
}

function fitTree() {
  const viewport = $("#tree-viewport");
  const stage = $("#tree-stage");
  const stageWidth = Number.parseFloat(stage.style.width);
  const stageHeight = Number.parseFloat(stage.style.height);
  if (!viewport.clientWidth || !stageWidth || !stageHeight) return;
  viewportState.scale = clampZoom(Math.min(1, (viewport.clientWidth - 52) / stageWidth, (viewport.clientHeight - 72) / stageHeight));
  viewportState.x = (viewport.clientWidth - stageWidth * viewportState.scale) / 2;
  viewportState.y = Math.max(26, (viewport.clientHeight - stageHeight * viewportState.scale) / 2 - 12);
  viewportState.initialized = true;
  applyViewportTransform();
}

function focusTree() {
  fitTree();
  if (viewportState.scale >= 0.72) return;
  const viewport = $("#tree-viewport");
  const stage = $("#tree-stage");
  const stageWidth = Number.parseFloat(stage.style.width);
  viewportState.scale = 0.72;
  viewportState.x = (viewport.clientWidth - stageWidth * viewportState.scale) / 2;
  viewportState.y = 30;
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
  const { x, depth, width, connected } = PolicyGraph.layout(state.policy);
  const nodeCounts = Object.fromEntries((state.dashboard?.nodes || []).map((n) => [n.node_id, n.count]));
  const pathCounts = new Map((state.dashboard?.paths || []).map((p) => [`${p.source}:${p.target}`, Number(p.count)]));
  const maxPathCount = Math.max(1, ...pathCounts.values());
  const height = (Math.max(...Object.values(depth)) + 1) * LEVEL_GAP + 48;
  const stage = $("#tree-stage");
  stage.style.width = `${width}px`; stage.style.height = `${height}px`;
  const nodes = $("#tree-nodes"); nodes.innerHTML = "";
  const svg = $("#tree-links"); svg.setAttribute("viewBox", `0 0 ${width} ${height}`); svg.innerHTML = "";

  Object.values(state.policy.nodes).forEach((node) => {
    const button = document.createElement("button");
    const decisionClass = node.type === "decision" ? ` decision ${node.decision}` : "";
    button.className = `tree-node${decisionClass}${state.selected === node.id ? " selected" : ""}${connected.has(node.id) ? "" : " disconnected"}`;
    button.dataset.nodeId = node.id;
    button.title = node.label;
    button.style.left = `${x[node.id]}px`; button.style.top = `${24 + depth[node.id] * LEVEL_GAP}px`;
    const type = document.createElement("span");
    type.className = "type";
    type.textContent = `${node.id === state.policy.root_node ? "Inicio · " : ""}${node.type === "condition" ? "Condición" : node.decision}${connected.has(node.id) ? "" : " · Sin conectar"}`;
    const label = document.createElement("strong");
    label.textContent = node.label;
    button.append(type, label);
    if (state.mode === "impact") {
      const count = document.createElement("span");
      count.className = "impact-badge";
      count.textContent = nodeCounts[node.id] || 0;
      type.append(count);
    }
    button.addEventListener("click", () => {
      if (viewportState.dragged) return;
      if (state.connecting) {
        changeConnection(state.connecting.source, state.connecting.branch, node.id);
        return;
      }
      if (!captureNodeForm()) return;
      selectNode(node.id);
    }); nodes.appendChild(button);

    PolicyGraph.edges(node).forEach(({ branch: branchKey, target: child }, index) => {
      if (state.mode === "edit") {
        const port = document.createElement("button");
        port.className = `branch-port${child ? "" : " pending"}`;
        port.type = "button";
        port.dataset.source = node.id;
        port.dataset.branch = branchKey;
        port.textContent = `${index === 0 ? "Sí" : "No"} →`;
        port.setAttribute("aria-label", `Conectar rama ${index === 0 ? "Sí" : "No"} de ${node.label}`);
        port.style.left = `${x[node.id] + index * (NODE_WIDTH / 2)}px`;
        port.style.top = `${24 + depth[node.id] * LEVEL_GAP + NODE_HEIGHT + 3}px`;
        port.disabled = editorLocked();
        port.addEventListener("click", () => startConnection(node.id, branchKey));
        nodes.append(port);
      }
      if (typeof child !== "string" || !Object.hasOwn(state.policy.nodes, child)) return;
      const startX = x[node.id] + (state.mode === "edit" ? index * NODE_WIDTH / 2 + 41 : NODE_WIDTH / 2);
      const startY = 24 + depth[node.id] * LEVEL_GAP + NODE_HEIGHT + (state.mode === "edit" ? 28 : 0);
      const endX = x[child] + NODE_WIDTH / 2, endY = 24 + depth[child] * LEVEL_GAP;
      const middle = startY + (endY - startY) / 2;
      const ns = "http://www.w3.org/2000/svg";
      const path = document.createElementNS(ns, "path");
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
      if (state.mode === "impact") svg.appendChild(labelGroup);
    });
  });
  if (!viewportState.initialized) requestAnimationFrame(fitTree);
}

function setupViewportInteractions() {
  const viewport = $("#tree-viewport");
  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, viewportState.scale * Math.exp(-event.deltaY * 0.0015));
  }, { passive: false });

  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    viewport.setPointerCapture(event.pointerId);
    viewportState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewportState.lastPoint = { x: event.clientX, y: event.clientY };
    viewportState.dragged = false;
    viewport.classList.add("dragging");
  });

  viewport.addEventListener("pointermove", (event) => {
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
  viewport.addEventListener("dblclick", (event) => {
    if (!event.target.closest(".tree-node")) fitTree();
  });
  viewport.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { state.connecting = null; syncDraftUi(); }
    else if (event.key === "+" || event.key === "=") zoomFromCenter(1.15);
    else if (event.key === "-") zoomFromCenter(1 / 1.15);
    else if (event.key === "0") fitTree();
    else return;
    event.preventDefault();
  });
  $("#zoom-in").addEventListener("click", () => zoomFromCenter(1.18));
  $("#zoom-out").addEventListener("click", () => zoomFromCenter(1 / 1.18));
  $("#zoom-reset").addEventListener("click", fitTree);
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
  renderConnections(node);
  state.formBaseline = readNodeForm();
  draftHistory.current = editorSnapshot();
  draftHistory.group = null;
  renderTree();
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
  if (editorLocked()) return;
  addValidationRow();
  markEditorDirty();
  syncEditorLock();
  $("#node-validations").lastElementChild.querySelector("select").focus();
});
$("#node-validations").addEventListener("click", (event) => {
  if (editorLocked() || !event.target.closest(".remove-validation")) return;
  event.target.closest(".validation-row").remove();
  markEditorDirty();
  syncEditorLock();
});
$("#node-validations").addEventListener("change", (event) => {
  if (!event.target.matches("[data-validation-operator]")) return;
  const row = event.target.closest(".validation-row");
  const previous = row.querySelector("[data-validation-value]");
  const value = previous.type === "number" && previous.value !== "" ? Number(previous.value) : undefined;
  renderValidationThreshold(row, value);
  markEditorDirty();
  syncEditorLock();
});

function editorLocked() {
  return state.saving || state.editorLoading || state.mode !== "edit" || state.editingVersion === state.activeVersion;
}

// Keep raw inputs as well as the graph, so incomplete thresholds can also be undone.
function readNodeForm() {
  if (!state.policy?.nodes[state.selected]) return null;
  const form = { label: $("#node-label").value };
  if (state.policy.nodes[state.selected].type === "condition") {
    form.combination = $("#node-combination").value;
    form.validations = $$(".validation-row").map((row) => ({
      field: row.querySelector("[data-validation-field]").value,
      operator: row.querySelector("[data-validation-operator]").value,
      value: row.querySelector("[data-validation-value]").value,
    }));
  } else {
    form.decision = $("#node-decision").value;
    form.band = $("#node-band").value;
    form.limit = $("#node-limit").value;
    form.reason = $("#node-reason").value;
  }
  return form;
}

function editorSnapshot() {
  return { policy: structuredClone(state.policy), selected: state.selected, form: readNodeForm() };
}

function resetDraftHistory() {
  draftHistory.past = [];
  draftHistory.future = [];
  draftHistory.group = null;
  draftHistory.current = editorSnapshot();
  syncDraftUi();
}

function updateDraftDirty() {
  state.editorDirty = JSON.stringify(state.policy) !== JSON.stringify(state.savedPolicy)
    || JSON.stringify(readNodeForm()) !== JSON.stringify(state.formBaseline);
}

function recordDraftEdit(before = draftHistory.current, group = null) {
  const after = editorSnapshot();
  if (before && JSON.stringify(before) !== JSON.stringify(after)) {
    // Continuous typing in one field is one step; a new action invalidates redo.
    if (!group || group !== draftHistory.group || !draftHistory.past.length) {
      draftHistory.past.push(before);
      if (draftHistory.past.length > HISTORY_LIMIT) draftHistory.past.shift();
    }
    draftHistory.future = [];
    draftHistory.group = group;
  }
  draftHistory.current = after;
  updateDraftDirty();
  syncDraftUi();
}

function moveDraftHistory(direction) {
  if (editorLocked() || $("dialog[open]")) return;
  const source = direction === "undo" ? draftHistory.past : draftHistory.future;
  const destination = direction === "undo" ? draftHistory.future : draftHistory.past;
  if (!source.length) return;
  destination.push(editorSnapshot());
  const snapshot = source.pop();
  state.policy = structuredClone(snapshot.policy);
  state.connecting = null;
  selectNode(snapshot.selected);
  const form = snapshot.form;
  $("#node-label").value = form.label;
  if (form.validations) {
    $("#node-combination").value = form.combination;
    $("#node-validations").replaceChildren();
    form.validations.forEach((validation) => {
      addValidationRow({ field: validation.field, operator: validation.operator });
      $("#node-validations").lastElementChild.querySelector("[data-validation-value]").value = validation.value;
    });
  } else {
    $("#node-decision").value = form.decision;
    $("#node-band").value = form.band;
    $("#node-limit").value = form.limit;
    $("#node-reason").value = form.reason;
  }
  draftHistory.current = editorSnapshot();
  updateDraftDirty();
  syncEditorLock();
  focusSelectedNode();
}

function markEditorDirty(group = null) {
  if (editorLocked()) return;
  recordDraftEdit(draftHistory.current, group);
}

function syncDraftUi() {
  const status = $("#draft-status");
  status.replaceChildren();
  $("#discard-draft").disabled = editorLocked() || !state.editorDirty;
  $("#undo-draft").disabled = editorLocked() || !draftHistory.past.length;
  $("#redo-draft").disabled = editorLocked() || !draftHistory.future.length;
  $("#draft-history").hidden = state.mode !== "edit";
  status.hidden = state.mode !== "edit" || (!state.editorDirty && !state.connecting);
  if (status.hidden) return;
  const text = document.createElement("span");
  const issues = PolicyGraph.issues(state.policy);
  text.textContent = state.connecting
    ? `Elegí el módulo de destino para ${state.connecting.branch === "true_node" ? "Sí" : "No"} de ${state.policy.nodes[state.connecting.source].label}.`
    : `Borrador sin guardar${issues.length ? ` · ${issues.length} pendientes` : " · listo para guardar"}.`;
  status.append(text);
  if (state.connecting) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "button secondary";
    cancel.textContent = "Cancelar conexión";
    cancel.addEventListener("click", () => { state.connecting = null; syncDraftUi(); });
    status.append(cancel);
  } else if (issues.length) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Ver pendientes";
    const list = document.createElement("ul");
    issues.forEach((issue) => { const item = document.createElement("li"); item.textContent = issue; list.append(item); });
    details.append(summary, list);
    status.append(details);
  }
}

function captureNodeForm() {
  if (editorLocked() || !state.policy?.nodes[state.selected]) return true;
  if (!$("#node-form").reportValidity()) return false;
  const node = state.policy.nodes[state.selected];
  let validations;
  if (node.type === "condition") {
    try { validations = readValidations(); }
    catch (error) { toast(error.message, true); return false; }
  }
  node.label = $("#node-label").value.trim();
  if (node.type === "condition") {
    const combination = $("#node-combination").value;
    if (!node.validations && combination === "none" && validations.length === 1) {
      Object.assign(node, validations[0]);
    } else {
      node.validations = validations;
      node.combination = combination;
      delete node.field; delete node.operator; delete node.value;
    }
  } else {
    node.decision = $("#node-decision").value;
    node.risk_band = $("#node-band").value;
    node.credit_limit = Number($("#node-limit").value);
    node.reason_code = $("#node-reason").value.trim();
  }
  state.formBaseline = readNodeForm();
  draftHistory.current = editorSnapshot();
  draftHistory.group = null;
  updateDraftDirty();
  syncDraftUi();
  return true;
}

function readyToSave() {
  if (!captureNodeForm()) return false;
  const issues = PolicyGraph.issues(state.policy);
  if (!issues.length) return true;
  toast(`Completá el árbol antes de guardar: ${issues[0]}`, true);
  syncDraftUi();
  return false;
}

function canLeaveEditor() {
  if (state.saving || state.editorLoading) return false;
  if (state.mode !== "edit") return true;
  if (!captureNodeForm()) return false;
  if (!state.editorDirty) return true;
  toast("Guardá la política o descartá el borrador antes de cambiar de versión o evaluar.", true);
  return false;
}

function renderConnections(node) {
  const panel = $("#node-connections");
  panel.replaceChildren();
  if (node.type !== "condition") return;
  const heading = document.createElement("h3");
  heading.textContent = "Conexiones";
  panel.append(heading);
  PolicyGraph.edges(node).forEach(({ branch, target }) => {
    const row = document.createElement("div");
    row.className = "connection-row";
    const label = document.createElement("label");
    label.textContent = branch === "true_node" ? "Si se cumple · Sí" : "Si no se cumple · No";
    const select = document.createElement("select");
    select.dataset.connection = branch;
    select.add(new Option("Sin conectar", ""));
    Object.values(state.policy.nodes).forEach((destination) => {
      const option = new Option(destination.label, destination.id);
      option.disabled = !PolicyGraph.canConnect(state.policy, node.id, destination.id);
      select.add(option);
    });
    select.value = target || "";
    select.addEventListener("change", () => changeConnection(node.id, branch, select.value || null));
    label.append(select);
    const add = document.createElement("button");
    add.type = "button";
    add.className = "button secondary full";
    add.dataset.insertBranch = branch;
    add.textContent = target ? "+ Insertar módulo en esta rama" : "+ Agregar módulo en esta rama";
    add.addEventListener("click", () => openModuleDialog({ source: node.id, branch }));
    row.append(label, add);
    panel.append(row);
  });
}

function changeStructure(change, selected = state.selected) {
  if (editorLocked() || !captureNodeForm()) return false;
  const before = editorSnapshot();
  const policy = structuredClone(state.policy);
  try { selected = change(policy) || selected; }
  catch (error) { toast(error.message, true); renderConnections(state.policy.nodes[state.selected]); syncEditorLock(); return false; }
  state.policy = policy;
  state.connecting = null;
  selectNode(selected);
  recordDraftEdit(before);
  return true;
}

function changeConnection(source, branch, target) {
  changeStructure((policy) => { PolicyGraph.connect(policy, source, branch, target); }, source);
}

function startConnection(source, branch) {
  if (editorLocked() || !captureNodeForm()) return;
  selectNode(source);
  state.connecting = { source, branch };
  syncDraftUi();
}

function openModuleDialog(insertion = null) {
  if (editorLocked() || !captureNodeForm()) return;
  state.insertion = insertion;
  $("#module-type").value = "condition";
  $("#module-label").value = "";
  $("#module-context").textContent = insertion
    ? `Rama ${insertion.branch === "true_node" ? "Sí" : "No"} de ${state.policy.nodes[insertion.source].label}.`
    : "El nuevo módulo aparecerá sin conectar. Conectalo a una rama existente o usalo como inicio.";
  $("#module-dialog").showModal();
}

$("#node-form").addEventListener("input", (event) => {
  if (event.target.matches("input")) markEditorDirty(event.target);
});
$("#node-form").addEventListener("change", (event) => {
  if (event.target.matches("select") && !event.target.matches("[data-connection], [data-validation-operator]")) markEditorDirty();
  draftHistory.group = null;
});
$("#undo-draft").addEventListener("click", () => moveDraftHistory("undo"));
$("#redo-draft").addEventListener("click", () => moveDraftHistory("redo"));
document.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing || editorLocked() || $("dialog[open]")) return;
  const key = event.key.toLowerCase();
  if (key !== "z" && !(key === "y" && event.ctrlKey && !event.shiftKey)) return;
  // Other text fields keep their native undo stack (e.g. version creation dialogs).
  if (event.target.closest("input, textarea, select, [contenteditable]") && !event.target.closest("#node-form")) return;
  event.preventDefault();
  moveDraftHistory(key === "y" || event.shiftKey ? "redo" : "undo");
});
$("#add-module").addEventListener("click", () => openModuleDialog());
$("#module-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (changeStructure((policy) => PolicyGraph.add(policy, $("#module-type").value, $("#module-label").value.trim(), state.insertion))) {
    $("#module-dialog").close();
    focusSelectedNode();
  }
});
$("#set-root").addEventListener("click", () => changeStructure((policy) => { policy.root_node = state.selected; }));
$("#delete-module").addEventListener("click", () => {
  if (editorLocked() || !captureNodeForm()) return;
  const node = state.policy.nodes[state.selected];
  const count = PolicyGraph.incoming(state.policy, node.id).length;
  $("#delete-module-detail").textContent = `Eliminar «${node.label}» del borrador. Tiene ${count} conexiones entrantes.`;
  $("#replacement-root-field").hidden = state.policy.root_node !== node.id;
  const select = $("#replacement-root");
  select.replaceChildren(new Option("Elegí el nuevo inicio", ""));
  Object.values(state.policy.nodes).filter((n) => n.id !== node.id).forEach((n) => select.add(new Option(n.label, n.id)));
  select.required = state.policy.root_node === node.id;
  $("#delete-module-dialog").showModal();
});
$("#delete-module-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (changeStructure((policy) => {
    PolicyGraph.remove(policy, state.selected, $("#replacement-root").value || null);
    return policy.root_node;
  })) $("#delete-module-dialog").close();
});
$("#discard-draft").addEventListener("click", () => $("#discard-dialog").showModal());
$("#confirm-discard").addEventListener("click", () => {
  if (editorLocked()) return;
  state.policy = structuredClone(state.savedPolicy);
  state.editorDraft = structuredClone(state.policy);
  state.editorDirty = false;
  state.connecting = null;
  selectNode(state.policy.nodes[state.selected] ? state.selected : state.policy.root_node);
  resetDraftHistory();
  $("#discard-dialog").close();
});
$$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.closeDialog}`).close()));
window.addEventListener("beforeunload", (event) => {
  if (state.editorDirty) { event.preventDefault(); event.returnValue = ""; }
});

function focusSelectedNode() {
  const node = [...$("#tree-nodes").querySelectorAll(".tree-node")].find((item) => item.dataset.nodeId === state.selected);
  if (!node) return;
  const viewport = $("#tree-viewport");
  viewportState.x = viewport.clientWidth / 2 - (Number.parseFloat(node.style.left) + NODE_WIDTH / 2) * viewportState.scale;
  viewportState.y = viewport.clientHeight / 2 - (Number.parseFloat(node.style.top) + NODE_HEIGHT / 2) * viewportState.scale;
  viewportState.initialized = true;
  applyViewportTransform();
}

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
    running: ["Ejecutando evaluación…", "Vertex AI está procesando los usuarios."],
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
  $("#version-pill").innerHTML = state.mode === "edit"
    ? `<i></i> ${isProductive ? "Solo lectura" : "Editando"} · v${selectedVersion || "—"}`
    : `<i></i> Evaluando · v${selectedVersion || "—"}`;
  $("#version-kind").textContent = isHistoricalRun
    ? "Revisión usada por la corrida"
    : (isProductive ? "Versión productiva" : "Versión candidata");
  $("#header-status").textContent = state.mode === "edit"
    ? (isProductive ? "Productiva · bloqueada" : "Candidata")
    : (isHistoricalRun ? "Histórica" : (isProductive ? "Productiva" : "Candidata"));
  $("#promote-button").hidden = state.mode !== "impact" || isProductive || isHistoricalRun;
  $("#publish-button").textContent = "Crear nueva versión";
  syncEditorLock();
}

function syncEditorLock() {
  const isProductive = state.editingVersion === state.activeVersion;
  const locked = editorLocked();
  $$("#node-form input, #node-form select, #node-form button").forEach((control) => {
    control.disabled = locked || Boolean(control.closest("[hidden]"));
  });
  const rows = $$(".validation-row");
  const combination = $("#node-combination").value;
  $("#add-validation").disabled = locked || combination === "none";
  rows.forEach((row, index) => {
    row.querySelector("legend").textContent = `Validación ${index + 1}`;
    row.querySelector(".remove-validation").disabled = locked || rows.length === 1;
  });
  $$('[data-structure-control], .branch-port').forEach((control) => { control.disabled = locked; });
  $("#set-root").disabled = locked || state.selected === state.policy?.root_node;
  $("#delete-module").disabled = locked || Object.keys(state.policy?.nodes || {}).length <= 1;
  $("#discard-draft").disabled = locked || !state.editorDirty;
  $("#editor-version-select").disabled = state.saving || state.editorLoading;
  $("#publish-button").disabled = state.saving || state.editorLoading;
  $("#add-module").hidden = state.mode !== "edit";
  syncDraftUi();
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
    ? "<strong>Versión productiva protegida</strong><span>Podés inspeccionarla o crear una candidata a partir de ella, pero no modificarla.</span>"
    : "<strong>Candidata editable</strong><span>Armá módulos y conexiones; Guardar política conserva el árbol completo.</span>";
}

function renderVersionLibrary() {
  const container = $("#versions-list");
  if (!container) return;
  container.innerHTML = state.versions.map((item) => {
    const date = new Date(item.created_at).toLocaleDateString("es-AR");
    return `<article class="version-item${item.active ? " productive" : ""}">
      <div class="version-item-main"><i></i><div><strong>v${item.version}</strong><small>${date} · ${item.created_by}</small></div></div>
      <div class="version-item-actions"><span class="version-state">${item.active ? "Productiva" : "Candidata"}</span>
        <button class="button secondary" type="button" data-edit-version="${item.version}">${item.active ? "Ver" : "Editar"}</button>
        <button class="button secondary" type="button" data-evaluate-version="${item.version}">Evaluar</button>
        ${item.active ? "" : `<button class="button promote" type="button" data-promote-version="${item.version}">Productivizar</button>`}
      </div>
    </article>`;
  }).join("");
}

async function loadVersions({ evaluationVersion = null, editingVersion = state.editingVersion } = {}) {
  const priorEvaluation = $("#version-select").value;
  state.versions = await api("/api/policies");
  state.activeVersion = state.versions.find((item) => item.active)?.version || null;
  const options = state.versions.map((item) =>
    `<option value="${item.version}">${item.version}${item.active ? " · Productiva" : " · Candidata"}</option>`
  ).join("");
  $("#version-select").innerHTML = options;
  $("#editor-version-select").innerHTML = options;
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

async function loadEditorVersion(version) {
  if (!canLeaveEditor()) { $("#editor-version-select").value = state.editingVersion; return false; }
  state.editorLoading = true;
  syncEditorLock();
  try {
    state.policy = await api(`/api/policies/${encodeURIComponent(version)}`);
    state.editingVersion = version;
    state.selected = state.policy.root_node;
    state.editorDraft = structuredClone(state.policy);
    state.editorSelected = state.selected;
    state.savedPolicy = structuredClone(state.policy);
    state.editorDirty = false;
    state.connecting = null;
    window.localStorage.setItem("credit-policy-editor-version", version);
    $("#editor-version-select").value = version;
    viewportState.initialized = false;
    selectNode(state.selected);
    resetDraftHistory();
    syncVersionUi();
    return true;
  } finally {
    state.editorLoading = false;
    $("#editor-version-select").value = state.editingVersion;
    syncEditorLock();
  }
}

async function loadPolicyVersion(version, policySha256 = null, loadHistory = true) {
  const revisionQuery = policySha256 ? `?policy_sha256=${encodeURIComponent(policySha256)}` : "";
  state.policy = await api(`/api/policies/${encodeURIComponent(version)}${revisionQuery}`);
  state.selected = state.policy.root_node;
  viewportState.initialized = false;
  selectNode(state.selected);
  if (loadHistory) await loadRuns(version);
  syncVersionUi();
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
}

$("#node-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (editorLocked()) {
    toast("La versión productiva es de solo lectura", true);
    return;
  }
  if (!readyToSave()) return;
  const policy = structuredClone(state.policy);
  const node = policy.nodes[state.selected];
  const button = $(".apply-button");
  state.saving = true;
  syncEditorLock();
  button.textContent = "Guardando…";
  try {
    await api(`/api/policies/${encodeURIComponent(state.editingVersion)}`, {
      method: "PUT",
      body: JSON.stringify({ policy }),
    });
    state.policy = policy;
    state.savedPolicy = structuredClone(policy);
    state.editorDirty = false;
    state.connecting = null;
    state.editorDraft = structuredClone(policy);
    state.editorSelected = node.id;
    selectNode(node.id);
    resetDraftHistory();
    await loadVersions({ editingVersion: state.editingVersion });
    toast(`Cambio guardado en la candidata ${state.editingVersion}`);
  } catch (error) {
    toast(`No se pudo guardar el cambio: ${error.message}`, true);
  } finally {
    state.saving = false;
    button.textContent = "Guardar política";
    syncEditorLock();
  }
});

$("#validate-button").addEventListener("click", async () => {
  if (state.saving || !readyToSave()) return;
  try { const result = await api("/api/policies/validate", { method: "POST", body: JSON.stringify({ policy: state.policy }) }); toast(`Política válida · ${result.nodes} nodos`); }
  catch (error) { toast(`No es válida: ${error.message}`, true); }
});

function openNewVersionDialog() {
  if (state.saving || !readyToSave()) return;
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
  if (state.saving || !readyToSave()) return;
  const policy = structuredClone(state.policy);
  policy.metadata.version = $("#publish-version").value.trim(); policy.metadata.created_by = $("#publish-author").value.trim(); policy.metadata.created_at = new Date().toISOString(); policy.metadata.status = "draft";
  state.saving = true;
  $("#confirm-publish").disabled = true;
  syncEditorLock();
  try {
    await api("/api/policies/publish", { method: "POST", body: JSON.stringify({ policy }) });
    state.policy = policy;
    state.editingVersion = policy.metadata.version;
    state.editorDraft = structuredClone(policy);
    state.editorSelected = state.selected;
    state.savedPolicy = structuredClone(policy);
    state.editorDirty = false;
    state.connecting = null;
    window.localStorage.setItem("credit-policy-editor-version", policy.metadata.version);
    resetDraftHistory();
    await loadVersions({ evaluationVersion: policy.metadata.version, editingVersion: policy.metadata.version });
    $("#publish-dialog").close(); renderTree(); toast(`Versión ${policy.metadata.version} creada · producción no cambió`);
  } catch (error) { toast(`No se pudo crear la versión: ${error.message}`, true); }
  finally { state.saving = false; $("#confirm-publish").disabled = false; syncEditorLock(); }
});

async function executeEvaluation() {
  if (!canLeaveEditor()) return;
  setEvaluationState("starting");
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  try {
    if (state.mode !== "impact") await setMode("impact");
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
  if (mode === state.mode) return;
  if (!canLeaveEditor()) return;
  state.connecting = null;
  if (state.mode === "edit" && mode === "impact") {
    state.editorDraft = structuredClone(state.policy);
    state.editorSelected = state.selected;
    $("#version-select").value = state.editingVersion;
  }
  state.mode = mode;
  document.body.dataset.mode = mode;
  $$('[data-tree-mode]').forEach((item) => item.classList.toggle("active", item.dataset.treeMode === mode));
  $$('.nav-item').forEach((item) => item.classList.toggle("active", (mode === "impact") === (item.dataset.view === "dashboard")));
  $("#view-title").textContent = mode === "impact" ? "Laboratorio de evaluación" : "Crédito de consumo";
  $("#canvas-subtitle").textContent = mode === "impact"
    ? "El volumen muestra por dónde recorrieron la política los usuarios analizados."
    : "Agregá módulos y conectá las ramas Sí y No.";
  if (mode === "impact") {
    const evaluationVersion = $("#version-select").value || state.activeVersion;
    await loadPolicyVersion(evaluationVersion);
  } else if (state.editorDraft) {
    state.policy = structuredClone(state.editorDraft);
    state.selected = state.editorSelected && state.policy.nodes[state.editorSelected]
      ? state.editorSelected
      : state.policy.root_node;
    selectNode(state.selected);
  }
  syncVersionUi();
  viewportState.initialized = false;
  window.requestAnimationFrame(renderTree);
}

$$('[data-tree-mode]').forEach((button) => button.addEventListener("click", async () => setMode(button.dataset.treeMode)));

$$('.nav-item').forEach((button) => button.addEventListener("click", async () => {
  await setMode(button.dataset.view === "dashboard" ? "impact" : "edit");
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

function openPromotion(version) {
  if (!canLeaveEditor()) return;
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

$("#versions-button").addEventListener("click", () => $("#versions-dialog").showModal());
$("#versions-close").addEventListener("click", () => $("#versions-dialog").close());
$("#new-version-button").addEventListener("click", () => {
  $("#versions-dialog").close();
  openNewVersionDialog();
});
$("#versions-list").addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-version]");
  const evaluateButton = event.target.closest("[data-evaluate-version]");
  const promoteButton = event.target.closest("[data-promote-version]");
  if (editButton) {
    const version = editButton.dataset.editVersion;
    $("#versions-dialog").close();
    if (state.mode !== "edit") await setMode("edit");
    await loadEditorVersion(version);
  } else if (evaluateButton) {
    const version = evaluateButton.dataset.evaluateVersion;
    $("#version-select").value = version;
    $("#versions-dialog").close();
    if (state.mode === "impact") await loadPolicyVersion(version);
    else await setMode("impact");
  } else if (promoteButton) {
    $("#versions-dialog").close();
    openPromotion(promoteButton.dataset.promoteVersion);
  }
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
      if (state.saving || !readyToSave()) throw new Error("El borrador tiene pendientes.");
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
      if (!canLeaveEditor()) throw new Error("Guardá o descartá el borrador antes de evaluar.");
      const result = await api("/api/runs", { method: "POST", body: JSON.stringify({ instances: [{}], parameters: { limit, policy_version: state.policy.metadata.version } }) });
      await loadRuns(result.policy_version, result.run_id);
      toast(`${result.processed_rows} usuarios · política ${result.policy_version}`);
      return { run_id: result.run_id, policy_version: result.policy_version, processed_rows: result.processed_rows, decisions: result.decisions };
    },
  });
}

setupViewportInteractions();
initialize().then(registerWebMcp).catch((error) => toast(`No se pudo iniciar: ${error.message}`, true));
