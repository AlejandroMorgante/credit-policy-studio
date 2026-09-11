import { insertNode, connectBranch, connectionTargets, assertValidGraph } from "./policy-editor.mjs";

export function setupEditorControls({ state, api, toast, renderTree, selectNode, focusNode, revealInspector, syncEditorLock, syncVersionUi, readValidations, fieldLabels, escapeHtml, requestNodeSelection }) {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  let baseline = "";
  let history = [];
  let pendingNode = null;
  let pendingConnection = null;
  let guardPromise = null;
  const locked = () => state.mode !== "edit" || state.editingVersion === state.activeVersion || state.saving || state.loadingPolicy;
  const signature = () => JSON.stringify($$("#node-form input, #node-form select").map((control) => control.value));
  const branchName = (branch) => branch === "true_node" ? "Sí" : "No";
  const removedNote = (removed) => removed.length
    ? ` ${removed.length} ${removed.length === 1 ? "nodo queda" : "nodos quedan"} fuera del recorrido. Podés deshacer este cambio.`
    : " Podés deshacer este cambio.";

  function syncControls() {
    $(".apply-button").disabled = locked() || !state.editorDirty;
    $(".apply-button").textContent = state.saving ? "Guardando…" : "Aplicar cambios";
    $("#add-node-button").disabled = locked();
    $("#undo-policy-change").disabled = locked() || state.editorDirty || !history.length;
    $$(".connection-action").forEach((button) => { button.disabled = locked(); });
    const status = $("#editor-save-status");
    status.textContent = state.loadingPolicy ? "Cargando versión…" : state.saving ? "Guardando…" : locked() ? "Solo lectura" : state.editorDirty ? "Cambios sin guardar" : "Guardado";
    status.dataset.status = state.saving ? "saving" : state.editorDirty ? "dirty" : "saved";
  }

  function markDirty() {
    state.editorDirty = signature() !== baseline;
    syncControls();
  }
  $("#node-form").addEventListener("input", markDirty);
  $("#node-form").addEventListener("change", markDirty);
  $("#node-form").addEventListener("click", (event) => {
    if (event.target.closest("#add-validation, .remove-validation")) markDirty();
  });

  function onSelection() {
    baseline = signature();
    state.editorDirty = false;
    renderConnections();
    syncControls();
  }

  async function persist(policy, selected, { remember = true, message = "Cambios guardados" } = {}) {
    if (locked()) throw new Error("Elegí una candidata editable para guardar cambios.");
    if (policy.metadata.version !== state.editingVersion) throw new Error("La versión seleccionada cambió. Volvé a abrirla.");
    assertValidGraph(policy);
    const previous = { policy: structuredClone(state.policy), selected: state.selected };
    state.saving = true;
    const controls = $$("button, input, select").filter((control) => !control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    syncControls();
    try {
      await api(`/api/policies/${encodeURIComponent(policy.metadata.version)}`, {
        method: "PUT", body: JSON.stringify({ policy }),
      });
      if (remember) history = [...history.slice(-19), previous];
      state.policy = policy;
      state.editorDraft = structuredClone(policy);
      state.editorSelected = selected;
      renderTree();
      selectNode(selected);
      syncVersionUi();
      toast(message);
    } finally {
      state.saving = false;
      controls.forEach((control) => { control.disabled = false; });
      syncEditorLock();
      syncControls();
    }
  }

  async function saveNode() {
    revealInspector();
    if (!$("#node-form").reportValidity()) return false;
    const policy = structuredClone(state.policy);
    const node = policy.nodes[state.selected];
    node.label = $("#node-label").value.trim();
    if (!node.label) { toast("Ingresá un nombre para la caja", true); return false; }
    if (node.type === "condition") {
      node.validations = readValidations();
      node.combination = $("#node-combination").value;
      delete node.field; delete node.operator; delete node.value;
    } else {
      node.decision = $("#node-decision").value;
      node.risk_band = $("#node-band").value.trim();
      node.credit_limit = Number($("#node-limit").value);
      node.reason_code = $("#node-reason").value.trim();
    }
    await persist(policy, node.id);
    return true;
  }
  $("#node-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (locked()) return;
    try { await saveNode(); } catch (error) { toast(`No se pudo guardar: ${error.message}`, true); }
  });

  async function guard() {
    if (state.saving || state.loadingPolicy) return false;
    if (!state.editorDirty) return true;
    if (guardPromise) return guardPromise;
    guardPromise = (async () => {
      const dialog = $("#unsaved-dialog");
      dialog.returnValue = "";
      const choice = new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true }));
      dialog.showModal();
      const result = await choice;
      if (result === "discard") { selectNode(state.selected); return true; }
      if (result === "save") {
        try { return await saveNode(); }
        catch (error) { toast(`No se pudo guardar: ${error.message}`, true); }
      }
      return false;
    })();
    try { return await guardPromise; } finally { guardPromise = null; }
  }
  [["save", "save"], ["discard", "discard"], ["stay", "cancel"]].forEach(([id, value]) => {
    $(`#unsaved-${id}`).addEventListener("click", () => $("#unsaved-dialog").close(value));
  });
  $("#undo-policy-change").addEventListener("click", async () => {
    if (locked() || state.editorDirty || !history.length) return;
    const previous = history.at(-1);
    try {
      await persist(previous.policy, previous.selected, { remember: false, message: "Cambio anterior restaurado" });
      history.pop();
      syncControls();
      requestAnimationFrame(() => focusNode(previous.selected));
    } catch (error) { toast(`No se pudo deshacer: ${error.message}`, true); }
  });

  function renderConnections() {
    const node = state.policy?.nodes[state.selected];
    const container = $("#node-connections");
    container.replaceChildren();
    if (node?.type !== "condition") return;
    for (const branch of ["true_node", "false_node"]) {
      const target = state.policy.nodes[node[branch]];
      const row = document.createElement("div");
      row.className = "connection-row";
      row.innerHTML = `<span class="branch-badge">${branchName(branch)}</span><button class="connection-target" type="button" title="Ir a ${escapeHtml(target.label)}">${escapeHtml(target.label)}</button><button class="connection-action icon-button" type="button" data-action="connect" aria-label="Cambiar destino de la rama ${branchName(branch)}" title="Cambiar destino"><svg viewBox="0 0 24 24"><path d="M5 5h6v6m-6 8h6v-6m0-2 8-6m-8 8 8 6"/></svg></button><button class="connection-action icon-button" type="button" data-action="insert" aria-label="Agregar nodo en la rama ${branchName(branch)}" title="Agregar nodo en esta rama">+</button>`;
      row.querySelector(".connection-target").addEventListener("click", async () => {
        if (await requestNodeSelection(target.id)) focusNode(target.id);
      });
      row.querySelector('[data-action="insert"]').addEventListener("click", () => openNewNode(branch));
      row.querySelector('[data-action="connect"]').addEventListener("click", () => openConnection(branch));
      container.append(row);
    }
  }

  async function openNewNode(branch = null) {
    if (locked() || !await guard()) return;
    pendingNode = { anchorId: state.selected, id: `node-${crypto.randomUUID()}`, fallbackId: `result-${crypto.randomUUID()}` };
    $("#new-node-form").reset();
    $("#new-node-context").textContent = `En «${state.policy.nodes[state.selected].label}»`;
    $("#new-node-error").hidden = true;
    $("#new-node-field").replaceChildren(...Object.entries(fieldLabels).map(([id, label]) => new Option(label, id)));
    updateNewNodeForm(branch);
    $("#new-node-dialog").showModal();
    $("#new-node-label").focus();
  }
  $("#add-node-button").addEventListener("click", () => openNewNode());

  function updateNewNodeForm(preferredPlacement = null) {
    if (!pendingNode) return;
    const anchor = state.policy.nodes[pendingNode.anchorId];
    const condition = $('[name="new-node-type"]:checked').value === "condition";
    $('[name="new-node-type"][value="decision"]').disabled = anchor.type !== "condition";
    const placement = $("#new-node-placement");
    const previous = preferredPlacement || placement.value;
    const options = [];
    if (condition) options.push(new Option("Antes de este nodo", "before"));
    if (anchor.type === "condition") {
      options.push(new Option("En su rama Sí", "true_node"), new Option("En su rama No", "false_node"));
    }
    placement.replaceChildren(...options);
    placement.value = options.some((option) => option.value === previous) ? previous : options[0].value;
    const fallback = $("#new-node-fallback");
    const previousFallback = fallback.value;
    fallback.replaceChildren(new Option("Nuevo resultado", "new"), ...connectionTargets(state.policy, anchor.id).map((node) => new Option(node.label, `existing:${node.id}`)));
    if ([...fallback.options].some((option) => option.value === previousFallback)) fallback.value = previousFallback;
    $("#new-condition-fields").hidden = !condition;
    $("#new-result-fields").hidden = condition && fallback.value !== "new";
    $$("#new-condition-fields input, #new-condition-fields select, #new-result-fields input, #new-result-fields select").forEach((control) => { control.disabled = Boolean(control.closest("[hidden]")); });
    updateNewNodePreview();
  }

  function newNodeOperation() {
    const type = $('[name="new-node-type"]:checked').value;
    const label = $("#new-node-label").value.trim() || "Nuevo nodo";
    const decision = $("#new-node-decision").value;
    const result = {
      id: type === "decision" ? pendingNode.id : pendingNode.fallbackId, type: "decision",
      label: type === "decision" ? label : { APPROVED: "Aprobación", REVIEW: "Revisión manual", REJECTED: "Rechazo" }[decision],
      decision, risk_band: $("#new-node-band").value.trim() || "Sin clasificar",
      credit_limit: Number($("#new-node-limit").value),
      reason_code: $("#new-node-reason").value.trim() || `POLICY_${decision}`,
    };
    const newFallback = $("#new-node-fallback").value === "new";
    const node = type === "decision" ? result : {
      id: pendingNode.id, type: "condition", label, combination: "none",
      validations: [{ field: $("#new-node-field").value, operator: $("#new-node-operator").value, value: Number($("#new-node-value").value) }],
      true_node: "", false_node: newFallback ? result.id : $("#new-node-fallback").value.slice(9),
    };
    return insertNode(state.policy, {
      anchorId: pendingNode.anchorId, placement: $("#new-node-placement").value,
      node, fallback: type === "condition" && newFallback ? result : null,
    });
  }
  function updateNewNodePreview() {
    try {
      const result = newNodeOperation();
      const node = result.policy.nodes[result.selected];
      $("#new-node-preview").textContent = node.type === "condition"
        ? `Si se cumple, continúa hacia «${result.policy.nodes[node.true_node].label}». Si no, va a «${result.policy.nodes[node.false_node].label}».`
        : `La rama ${branchName($("#new-node-placement").value)} termina en este resultado.${removedNote(result.removed)}`;
    } catch (error) { $("#new-node-preview").textContent = error.message; }
  }
  $("#new-node-form").addEventListener("change", () => updateNewNodeForm());
  $("#new-node-form").addEventListener("input", updateNewNodePreview);
  $("#new-node-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (locked()) return;
    if (!$("#new-node-label").value.trim()) { $("#new-node-label").focus(); return; }
    try {
      const result = newNodeOperation();
      await persist(result.policy, result.selected, { message: "Nodo agregado a la candidata" });
      $("#new-node-dialog").close();
      requestAnimationFrame(() => focusNode(result.selected));
    } catch (error) {
      $("#new-node-error").textContent = error.message;
      $("#new-node-error").hidden = false;
    }
  });

  async function openConnection(branch) {
    if (locked() || !await guard()) return;
    pendingConnection = { source: state.selected, branch };
    const node = state.policy.nodes[state.selected];
    $("#connect-node-context").textContent = `Rama ${branchName(branch)} de «${node.label}»`;
    $("#connect-node-target").replaceChildren(...connectionTargets(state.policy, node.id).map((target) => new Option(target.label, target.id)));
    $("#connect-node-target").value = node[branch];
    $("#connect-node-error").hidden = true;
    updateConnectionPreview();
    $("#connect-node-dialog").showModal();
  }
  function connectionOperation() {
    return connectBranch(state.policy, pendingConnection.source, pendingConnection.branch, $("#connect-node-target").value);
  }
  function updateConnectionPreview() {
    try { $("#connect-node-preview").textContent = `Se actualiza sólo esta rama.${removedNote(connectionOperation().removed)}`; }
    catch (error) { $("#connect-node-preview").textContent = error.message; }
  }
  $("#connect-node-target").addEventListener("change", updateConnectionPreview);
  $("#connect-node-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (locked()) return;
    try {
      const result = connectionOperation();
      await persist(result.policy, result.selected, { message: "Conexión guardada" });
      $("#connect-node-dialog").close();
    } catch (error) {
      $("#connect-node-error").textContent = error.message;
      $("#connect-node-error").hidden = false;
    }
  });
  for (const prefix of ["new-node", "connect-node"]) {
    for (const action of ["close", "cancel"]) {
      $(`#${prefix}-${action}`).addEventListener("click", () => {
        if (!state.saving) $(`#${prefix}-dialog`).close();
      });
    }
    $(`#${prefix}-dialog`).addEventListener("cancel", (event) => {
      if (state.saving) event.preventDefault();
    });
  }
  return { guard, onSelection, syncControls, resetHistory: () => { history = []; } };
}
