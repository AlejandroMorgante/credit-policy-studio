// SPDX-License-Identifier: MIT
import { insertNode, connectBranch, connectionTargets, issues as graphIssues, remove } from "./policy-editor.mjs";

export function setupEditorControls({ state, api, toast, renderTree, selectNode, focusNode, revealInspector, syncEditorLock, syncVersionUi, readValidations, addValidationRow, fieldLabels, escapeHtml, requestNodeSelection }) {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const draftHistory = { past: [], future: [], current: null, group: null };
  const HISTORY_LIMIT = 100;
  let pendingNode = null;
  let pendingConnection = null;
  let guardPromise = null;
  const locked = () => state.mode !== "edit" || state.editingVersion === state.activeVersion || state.saving || state.loadingPolicy;
  const branchName = (branch) => branch === "true_node" ? "Sí" : "No";
  const retainedNote = () => " Los módulos anteriores se conservan en el borrador; conectalos o eliminalos si quedan fuera del recorrido.";

  function syncControls() {
    $(".apply-button").disabled = locked() || !state.editorDirty;
    $(".apply-button").textContent = state.saving ? "Guardando…" : "Guardar política";
    $("#add-node-button").disabled = locked();
    $$(".connection-action, .branch-port").forEach((button) => { button.disabled = locked(); });
    $("#set-root").disabled = locked() || state.selected === state.policy?.root_node;
    $("#delete-module").disabled = locked() || Object.keys(state.policy?.nodes || {}).length <= 1;
    const status = $("#editor-save-status");
    status.textContent = state.loadingPolicy ? "Cargando versión…" : state.saving ? "Guardando…" : locked() ? "Solo lectura" : state.editorDirty ? "Borrador sin guardar" : "Guardado";
    status.dataset.status = state.saving ? "saving" : state.editorDirty ? "dirty" : "saved";
    $("#undo-draft").disabled = locked() || !draftHistory.past.length;
    $("#redo-draft").disabled = locked() || !draftHistory.future.length;
    $("#discard-draft").disabled = locked() || !state.editorDirty;
    $("#draft-history").hidden = state.mode !== "edit";
    $("#draft-status").hidden = state.mode !== "edit" || (!state.editorDirty && !state.connecting);
  }

  function onSelection() {
    state.formBaseline = readNodeForm();
    draftHistory.current = editorSnapshot();
    draftHistory.group = null;
    renderConnections();
    syncDraftUi();
  }

  function resetHistory() {
    state.savedPolicy = structuredClone(state.policy);
    state.editorDirty = false;
    state.connecting = null;
    resetDraftHistory();
  }

  async function saveNode() {
    if (locked() || !readyToSave()) return false;
    const policy = structuredClone(state.policy);
    const selected = state.selected;
    state.saving = true;
    syncEditorLock();
    try {
      await api(`/api/policies/${encodeURIComponent(state.editingVersion)}`, {
        method: "PUT", body: JSON.stringify({ policy }),
      });
      state.editorDraft = structuredClone(policy);
      state.editorSelected = selected;
      renderTree();
      selectNode(selected);
      resetHistory();
      syncVersionUi();
      toast("Política guardada en la candidata");
      return true;
    } finally {
      state.saving = false;
      syncEditorLock();
    }
  }
  $("#node-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try { await saveNode(); } catch (error) { toast(`No se pudo guardar: ${error.message}`, true); }
  });
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
    if (locked() || $("dialog[open]")) return;
    const source = direction === "undo" ? draftHistory.past : draftHistory.future;
    const destination = direction === "undo" ? draftHistory.future : draftHistory.past;
    if (!source.length) return;
    destination.push(editorSnapshot());
    const snapshot = source.pop();
    state.policy = structuredClone(snapshot.policy);
    state.connecting = null;
    renderTree();
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
    focusNode();
  }

  function markEditorDirty(group = null) {
    if (locked()) return;
    recordDraftEdit(draftHistory.current, group);
  }

  function syncDraftUi() {
    syncControls();
    const status = $("#draft-status");
    status.replaceChildren();
    if (status.hidden) return;
    const text = document.createElement("span");
    const issues = graphIssues(state.policy);
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
    if (locked() || !state.policy?.nodes[state.selected]) return true;
    if (!$("#node-form").checkValidity()) { revealInspector(); $("#node-form").reportValidity(); return false; }
    const node = state.policy.nodes[state.selected];
    const before = JSON.stringify(node);
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
    if (JSON.stringify(node) !== before) renderTree();
    return true;
  }

  function readyToSave() {
    if (!captureNodeForm()) return false;
    const issues = graphIssues(state.policy);
    if (!issues.length) return true;
    toast(`Completá el árbol antes de guardar: ${issues[0]}`, true);
    syncDraftUi();
    return false;
  }

  function changeStructure(change, selected = state.selected, replacement = null) {
    if (locked() || !captureNodeForm()) return false;
    const before = editorSnapshot();
    const policy = structuredClone(replacement || state.policy);
    try { selected = change(policy) || selected; }
    catch (error) { toast(error.message, true); renderConnections(); syncEditorLock(); return false; }
    state.policy = policy;
    state.connecting = null;
    renderTree();
    selectNode(selected);
    recordDraftEdit(before);
    return true;
  }

  function changeConnection(source, branch, target) {
    changeStructure((policy) => { Object.assign(policy, connectBranch(policy, source, branch, target).policy); }, source);
  }

  function startConnection(source, branch) {
    if (locked() || !captureNodeForm()) return;
    selectNode(source);
    state.connecting = { source, branch };
    syncDraftUi();
  }

  $("#node-form").addEventListener("input", (event) => {
    if (event.target.matches("input")) markEditorDirty(event.target);
  });
  $("#node-form").addEventListener("change", (event) => {
    if (event.target.matches("select")) markEditorDirty();
    draftHistory.group = null;
  });
  $("#node-form").addEventListener("click", (event) => {
    if (event.target.closest("#add-validation, .remove-validation")) markEditorDirty();
  });
  $("#undo-draft").addEventListener("click", () => moveDraftHistory("undo"));
  $("#redo-draft").addEventListener("click", () => moveDraftHistory("redo"));
  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing || locked() || $("dialog[open]")) return;
    const key = event.key.toLowerCase();
    if (key !== "z" && !(key === "y" && event.ctrlKey && !event.shiftKey)) return;
    // Other text fields keep their native undo stack (e.g. version creation dialogs).
    if (event.target.closest("input, textarea, select, [contenteditable]") && !event.target.closest("#node-form")) return;
    event.preventDefault();
    moveDraftHistory(key === "y" || event.shiftKey ? "redo" : "undo");
  });
  async function guard() {
    if (state.saving || state.loadingPolicy) return false;
    if (state.mode !== "edit" || !state.editorDirty) return true;
    if (guardPromise) return guardPromise;
    guardPromise = (async () => {
      const dialog = $("#unsaved-dialog");
      dialog.returnValue = "";
      const choice = new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true }));
      dialog.showModal();
      const result = await choice;
      if (result === "discard") { discardDraft(); return true; }
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
  function renderConnections() {
    const node = state.policy?.nodes[state.selected];
    const container = $("#node-connections");
    container.replaceChildren();
    if (node?.type !== "condition") return;
    for (const branch of ["true_node", "false_node"]) {
      const target = state.policy.nodes[node[branch]];
      const row = document.createElement("div");
      row.className = "connection-row";
      row.dataset.branch = branch;
      row.innerHTML = `<span class="branch-badge">${branchName(branch)}</span><button class="connection-target" type="button" title="Ir a ${escapeHtml(target?.label || "Sin conectar")}">${escapeHtml(target?.label || "Sin conectar")}</button><button class="connection-action icon-button" type="button" data-action="connect" aria-label="Cambiar destino de la rama ${branchName(branch)}" title="Cambiar destino"><svg viewBox="0 0 24 24"><path d="M5 5h6v6m-6 8h6v-6m0-2 8-6m-8 8 8 6"/></svg></button><button class="connection-action icon-button" type="button" data-action="insert" aria-label="Agregar nodo en la rama ${branchName(branch)}" title="Agregar nodo en esta rama">+</button>`;
      row.querySelector(".connection-target").addEventListener("click", async () => {
        if (target && await requestNodeSelection(target.id)) focusNode(target.id);
      });
      row.querySelector('[data-action="insert"]').addEventListener("click", () => openNewNode(branch));
      row.querySelector('[data-action="connect"]').addEventListener("click", () => openConnection(branch));
      container.append(row);
    }
  }

  async function openNewNode(branch = null) {
    if (locked() || !captureNodeForm()) return;
    pendingNode = { anchorId: state.selected, id: `node-${crypto.randomUUID()}`, fallbackId: `result-${crypto.randomUUID()}` };
    $("#new-node-form").reset();
    $("#new-node-value").value = "0";
    $("#new-node-context").textContent = `En «${state.policy.nodes[state.selected].label}»`;
    $("#new-node-error").hidden = true;
    $("#new-node-field").replaceChildren(...Object.entries(fieldLabels).map(([id, label]) => new Option(label, id)));
    updateNewNodeForm(branch || "detached");
    $("#new-node-dialog").showModal();
    $("#new-node-label").focus();
  }
  $("#add-node-button").addEventListener("click", () => openNewNode());

  function updateNewNodeForm(preferredPlacement = null) {
    if (!pendingNode) return;
    const anchor = state.policy.nodes[pendingNode.anchorId];
    const condition = $('[name="new-node-type"]:checked').value === "condition";

    const placement = $("#new-node-placement");
    const previous = preferredPlacement || placement.value;
    const options = [new Option("Sin conectar (borrador)", "detached")];
    if (condition) options.push(new Option("Antes de este nodo", "before"));
    if (anchor.type === "condition") {
      options.push(new Option("En su rama Sí", "true_node"), new Option("En su rama No", "false_node"));
    }
    placement.replaceChildren(...options);
    placement.value = options.some((option) => option.value === previous) ? previous : options[0].value;
    const fallback = $("#new-node-fallback");
    const previousFallback = fallback.value;
    fallback.replaceChildren(new Option("Sin conectar (pendiente)", "pending"), new Option("Nuevo resultado", "new"), ...connectionTargets(state.policy, anchor.id).map((node) => new Option(node.label, `existing:${node.id}`)));
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
      true_node: "", false_node: newFallback ? result.id : $("#new-node-fallback").value === "pending" ? null : $("#new-node-fallback").value.slice(9),
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
      const placement = $("#new-node-placement").value;
      $("#new-node-preview").textContent = node.type === "condition"
        ? `Si se cumple, continúa hacia «${(result.policy.nodes[node.true_node]?.label || "Sin conectar")}». Si no, va a «${(result.policy.nodes[node.false_node]?.label || "Sin conectar")}».`
        : placement === "detached"
          ? "El resultado quedará sin conectar en el borrador."
          : `La rama ${branchName(placement)} termina en este resultado.${retainedNote()}`;
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
      if (!changeStructure(() => result.selected, result.selected, result.policy)) return;
      $("#new-node-dialog").close();
      requestAnimationFrame(() => focusNode(result.selected));
    } catch (error) {
      $("#new-node-error").textContent = error.message;
      $("#new-node-error").hidden = false;
    }
  });

  async function openConnection(branch) {
    if (locked() || !captureNodeForm()) return;
    pendingConnection = { source: state.selected, branch };
    const node = state.policy.nodes[state.selected];
    $("#connect-node-context").textContent = `Rama ${branchName(branch)} de «${node.label}»`;
    $("#connect-node-target").replaceChildren(new Option("Sin conectar", ""), ...connectionTargets(state.policy, node.id).map((target) => new Option(target.label, target.id)));
    $("#connect-node-target").value = node[branch];
    $("#connect-node-error").hidden = true;
    updateConnectionPreview();
    $("#connect-node-dialog").showModal();
  }
  function connectionOperation() {
    return connectBranch(state.policy, pendingConnection.source, pendingConnection.branch, $("#connect-node-target").value || null);
  }
  function updateConnectionPreview() {
    try { connectionOperation(); $("#connect-node-preview").textContent = `Se actualiza sólo esta rama.${retainedNote()}`; }
    catch (error) { $("#connect-node-preview").textContent = error.message; }
  }
  $("#connect-node-target").addEventListener("change", updateConnectionPreview);
  $("#connect-node-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (locked()) return;
    try {
      const result = connectionOperation();
      if (!changeStructure(() => result.selected, result.selected, result.policy)) return;
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

  function discardDraft() {
    state.policy = structuredClone(state.savedPolicy);
    state.editorDraft = structuredClone(state.policy);
    state.editorDirty = false;
    state.connecting = null;
    renderTree();
    selectNode(state.policy.nodes[state.selected] ? state.selected : state.policy.root_node);
    resetDraftHistory();
  }
  $("#discard-draft").addEventListener("click", () => $("#discard-dialog").showModal());
  $("#confirm-discard").addEventListener("click", () => {
    if (locked()) return;
    discardDraft();
    $("#discard-dialog").close();
  });
  $("#set-root").addEventListener("click", () => changeStructure((policy) => { policy.root_node = state.selected; }));
  $("#delete-module").addEventListener("click", () => {
    if (locked() || !captureNodeForm()) return;
    $("#delete-module-detail").textContent = `Eliminar «${state.policy.nodes[state.selected].label}» del borrador.`;
    const isRoot = state.selected === state.policy.root_node;
    $("#replacement-root-field").hidden = !isRoot;
    const select = $("#replacement-root");
    select.replaceChildren(new Option("Elegí el nuevo inicio", ""),
      ...Object.values(state.policy.nodes).filter((node) => node.id !== state.selected).map((node) => new Option(node.label, node.id)));
    select.required = isRoot;
    $("#delete-module-dialog").showModal();
  });
  $("#delete-module-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (changeStructure((policy) => {
      remove(policy, state.selected, $("#replacement-root").value || null);
      return policy.root_node;
    })) $("#delete-module-dialog").close();
  });
  $$("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.closeDialog}`).close()));
  return { guard, onSelection, syncControls, resetHistory, captureNodeForm, readyToSave, markEditorDirty, startConnection, changeConnection, cancelConnection: () => { state.connecting = null; syncDraftUi(); } };
}
