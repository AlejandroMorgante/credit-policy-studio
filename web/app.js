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
};
const MIN_ZOOM = 0.55;
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

function hierarchy(policy) {
  const children = (id) => {
    const node = policy.nodes[id];
    if (node.type === "condition") return [node.true_node, node.false_node];
    if (node.type === "derive") return [node.next_node];
    return [];
  };
  const depth = {};
  const visitDepth = (id, level) => {
    depth[id] = Math.max(depth[id] ?? 0, level);
    children(id).forEach((child) => visitDepth(child, level + 1));
  };
  visitDepth(policy.root_node, 0);
  let leafIndex = 0;
  const x = {};
  const assignX = (id) => {
    const kids = children(id);
    if (!kids.length) return (x[id] = 36 + leafIndex++ * 200);
    const values = kids.map(assignX);
    return (x[id] = values.reduce((a, b) => a + b, 0) / values.length);
  };
  assignX(policy.root_node);
  return { x, depth, children, width: Math.max(1080, leafIndex * 200 + 72) };
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
  const { x, depth, children, width } = hierarchy(state.policy);
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
    button.className = `tree-node${decisionClass}${state.selected === node.id ? " selected" : ""}`;
    button.style.left = `${x[node.id]}px`; button.style.top = `${24 + depth[node.id] * LEVEL_GAP}px`;
    const count = state.mode === "impact" ? `<span class="impact-badge">${nodeCounts[node.id] || 0}</span>` : "";
    const typeLabel = node.type === "condition" ? "Condición" : (node.type === "derive" ? "Cálculo" : node.decision);
    button.innerHTML = `<span class="type"><span>${typeLabel}</span>${count}</span><strong>${node.label}</strong>`;
    button.addEventListener("click", () => {
      if (viewportState.dragged) return;
      selectNode(node.id);
    }); nodes.appendChild(button);

    children(node.id).forEach((child, index) => {
      const startX = x[node.id] + NODE_WIDTH / 2, startY = 24 + depth[node.id] * LEVEL_GAP + NODE_HEIGHT;
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
      const branchLabel = node.type === "derive" ? "Sigue" : (index === 0 ? "Sí" : "No");
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
      } else {
        const label = document.createElementNS(ns, "text");
        label.setAttribute("x", `${labelX}`);
        label.setAttribute("y", `${labelY}`);
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("class", "link-label");
        label.textContent = branchLabel;
        labelGroup.appendChild(label);
      }
      svg.appendChild(labelGroup);
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
    if (event.button !== 0 || event.target.closest(".canvas-controls") || event.target.closest(".tree-node")) return;
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
    if (event.key === "+" || event.key === "=") zoomFromCenter(1.15);
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
  $("#node-tag").textContent = node.type === "condition" ? "CONDICIÓN" : (node.type === "derive" ? "CÁLCULO" : "RESULTADO");
  $("#node-label").value = node.label;
  const condition = node.type === "condition";
  $("#condition-fields").hidden = !condition; $("#decision-fields").hidden = condition;
  if (condition) {
    $("#node-field").value = node.field || ""; $("#node-operator").value = node.operator || "eq"; $("#node-value").value = node.expression ? "" : node.value;
  } else if (node.type === "decision") {
    $("#node-decision").value = node.decision; $("#node-band").value = node.risk_band; $("#node-limit").value = node.credit_limit;
  }
  $$("#node-form input, #node-form select, #node-form button").forEach((control) => { control.disabled = node.type === "derive" || Boolean(node.expression); });
  renderTree();
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

async function refreshDashboard(runId = null, policyVersion = state.policy?.metadata.version) {
  const query = new URLSearchParams();
  if (runId) query.set("run_id", runId);
  else if (policyVersion) query.set("policy_version", policyVersion);
  state.dashboard = await api(`/api/dashboard?${query.toString()}`);
  updateMetrics(state.dashboard);
  renderTree();
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
  const selectedNode = state.policy?.nodes[state.selected];
  const locked = state.mode === "impact" || isProductive || selectedNode?.type === "derive" || Boolean(selectedNode?.expression);
  $$("#node-form input, #node-form select, #node-form button").forEach((control) => {
    control.disabled = locked;
  });
  const kind = $("#editor-version-kind");
  const guidance = $("#editor-guidance");
  if (!kind || !guidance) return;
  kind.textContent = isProductive ? "Productiva · sólo lectura" : "Candidata · editable";
  guidance.classList.toggle("locked", isProductive);
  guidance.innerHTML = isProductive
    ? "<strong>Versión productiva protegida</strong><span>Podés inspeccionarla o crear una candidata a partir de ella, pero no modificarla.</span>"
    : "<strong>Candidata editable</strong><span>Aplicar guarda el cambio en esta versión. Producción no se modifica.</span>";
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
  state.policy = await api(`/api/policies/${encodeURIComponent(version)}`);
  state.editingVersion = version;
  state.selected = state.policy.root_node;
  state.editorDraft = structuredClone(state.policy);
  state.editorSelected = state.selected;
  window.localStorage.setItem("credit-policy-editor-version", version);
  $("#editor-version-select").value = version;
  viewportState.initialized = false;
  selectNode(state.selected);
  syncVersionUi();
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
  const options = Object.entries(fieldLabels).map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  $("#node-field").innerHTML = options;
  state.policy = await api("/api/policy");
  await loadVersions({ evaluationVersion: state.policy.metadata.version });
  await loadEditorVersion(state.editingVersion);
  await loadRuns($("#version-select").value);
  if (new URLSearchParams(window.location.search).get("view") === "impact") await setMode("impact");
}

$("#node-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.editingVersion === state.activeVersion) {
    toast("La versión productiva es de solo lectura", true);
    return;
  }
  const policy = structuredClone(state.policy);
  const node = policy.nodes[state.selected]; node.label = $("#node-label").value.trim();
  if (node.type === "condition") { node.field = $("#node-field").value; node.operator = $("#node-operator").value; node.value = Number($("#node-value").value); }
  else { node.decision = $("#node-decision").value; node.risk_band = $("#node-band").value; node.credit_limit = Number($("#node-limit").value); }
  const button = $(".apply-button");
  button.disabled = true;
  button.textContent = "Guardando…";
  try {
    await api(`/api/policies/${encodeURIComponent(state.editingVersion)}`, {
      method: "PUT",
      body: JSON.stringify({ policy }),
    });
    state.policy = policy;
    state.editorDraft = structuredClone(policy);
    state.editorSelected = node.id;
    selectNode(node.id);
    await loadVersions({ editingVersion: state.editingVersion });
    toast(`Cambio guardado en la candidata ${state.editingVersion}`);
  } catch (error) {
    toast(`No se pudo guardar el cambio: ${error.message}`, true);
  } finally {
    button.textContent = "Aplicar cambios";
    syncEditorLock();
  }
});

$("#validate-button").addEventListener("click", async () => {
  try { const result = await api("/api/policies/validate", { method: "POST", body: JSON.stringify({ policy: state.policy }) }); toast(`Política válida · ${result.nodes} nodos`); }
  catch (error) { toast(`No es válida: ${error.message}`, true); }
});

function openNewVersionDialog() {
  $("#publish-version").value = "";
  $("#publish-author").value = state.policy.metadata.created_by;
  $("#publish-dialog").showModal();
}

$("#publish-button").addEventListener("click", () => {
  openNewVersionDialog();
});

$("#publish-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault(); const policy = structuredClone(state.policy);
  policy.metadata.version = $("#publish-version").value.trim(); policy.metadata.created_by = $("#publish-author").value.trim(); policy.metadata.created_at = new Date().toISOString(); policy.metadata.status = "draft";
  try {
    await api("/api/policies/publish", { method: "POST", body: JSON.stringify({ policy }) });
    state.policy = policy;
    state.editingVersion = policy.metadata.version;
    state.editorDraft = structuredClone(policy);
    state.editorSelected = state.selected;
    window.localStorage.setItem("credit-policy-editor-version", policy.metadata.version);
    await loadVersions({ evaluationVersion: policy.metadata.version, editingVersion: policy.metadata.version });
    $("#publish-dialog").close(); renderTree(); toast(`Versión ${policy.metadata.version} creada · producción no cambió`);
  } catch (error) { toast(`No se pudo crear la versión: ${error.message}`, true); }
});

async function executeEvaluation() {
  const button = $("#run-button"); button.disabled = true; button.textContent = "Ejecutando…";
  try {
    const result = await api("/api/runs", { method: "POST", body: JSON.stringify({ instances: [{}], parameters: { limit: Number($("#run-limit").value), policy_version: state.policy.metadata.version } }) });
    await loadRuns(result.policy_version, result.run_id);
    toast(`${result.processed_rows} usuarios · versión ${result.policy_version}`);
  }
  catch (error) { toast(`Falló la ejecución: ${error.message}`, true); }
  finally { button.disabled = false; button.innerHTML = '<svg viewBox="0 0 24 24"><path d="m9 7 8 5-8 5z"></path></svg> Iniciar evaluación'; }
}

$("#run-button").addEventListener("click", async () => {
  if (state.mode !== "impact") await setMode("impact");
  await executeEvaluation();
});

async function setMode(mode) {
  if (mode === state.mode) return;
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
    : "Seleccioná un nodo para editar su regla.";
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
  try { await loadPolicyVersion(event.target.value); }
  catch (error) { toast(`No se pudo cargar la versión: ${error.message}`, true); }
});

$("#editor-version-select").addEventListener("change", async (event) => {
  try { await loadEditorVersion(event.target.value); }
  catch (error) { toast(`No se pudo abrir la versión para editar: ${error.message}`, true); }
});

$("#run-select").addEventListener("change", async (event) => {
  const version = $("#version-select").value;
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
});

function openPromotion(version) {
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
      const result = await api("/api/runs", { method: "POST", body: JSON.stringify({ instances: [{}], parameters: { limit, policy_version: state.policy.metadata.version } }) });
      await loadRuns(result.policy_version, result.run_id);
      toast(`${result.processed_rows} usuarios · política ${result.policy_version}`);
      return { run_id: result.run_id, policy_version: result.policy_version, processed_rows: result.processed_rows, decisions: result.decisions };
    },
  });
}

setupViewportInteractions();
initialize().then(registerWebMcp).catch((error) => toast(`No se pudo iniciar: ${error.message}`, true));
