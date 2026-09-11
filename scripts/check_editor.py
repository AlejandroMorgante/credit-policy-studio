# SPDX-License-Identifier: MIT
"""Exercise the real editor in headless Chrome against an isolated local server.

Run with .venv/bin/python scripts/check_editor.py [--chrome /path/to/chrome].
Uses the existing development environment; creates no policies in the user's workspace.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

import httpx
import websockets

ROOT = Path(__file__).resolve().parents[1]


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def check_editor(base_url: str, browser_url: str, screenshot: Path | None = None) -> None:
    async with httpx.AsyncClient(timeout=5) as client:
        for _ in range(100):
            try:
                (await client.get(f"{base_url}/health")).raise_for_status()
                pages = (await client.get(f"{browser_url}/json")).json()
                page = next(p for p in pages if p["type"] == "page")
                break
            except (httpx.HTTPError, StopIteration):
                await asyncio.sleep(0.1)
        else:
            raise RuntimeError("The isolated server or Chrome did not start")

        production = (await client.get(f"{base_url}/api/policy")).json()
        candidate = json.loads(json.dumps(production))
        candidate["metadata"].update(version="browser-editor-check", status="draft")
        (
            await client.post(f"{base_url}/api/policies/publish", json={"policy": candidate})
        ).raise_for_status()

        async with websockets.connect(page["webSocketDebuggerUrl"]) as ws:
            counter = 0
            errors = []

            async def call(method, params=None):
                nonlocal counter
                counter += 1
                await ws.send(json.dumps({"id": counter, "method": method, "params": params or {}}))
                while True:
                    reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
                    if reply.get("method") == "Runtime.exceptionThrown":
                        errors.append(reply["params"])
                    if reply.get("id") == counter:
                        assert "error" not in reply, reply
                        return reply.get("result", {})

            async def js(expression):
                reply = await call(
                    "Runtime.evaluate",
                    {
                        "expression": "(async () => { "
                        "const script = document.querySelector('script[src*=\"app.js\"]'); "
                        "if (!script) return null; "
                        "const {state, setMode} = await import(script.src); "
                        "const PolicyGraph = await import('/assets/policy-editor.mjs'); "
                        "const $ = s => document.querySelector(s); "
                        "const $$ = s => [...document.querySelectorAll(s)]; "
                        f"return eval({json.dumps(expression)}); " + "})()",
                        "awaitPromise": True,
                        "returnByValue": True,
                    },
                )
                assert "exceptionDetails" not in reply, reply
                return reply["result"].get("value")

            async def expect(expression):
                if not await js(f"Boolean({expression})"):
                    detail = await js(
                        "({selected: state.selected, root: state.policy?.root_node, "
                        "saving: state.saving, loading: state.loadingPolicy, "
                        "setRootDisabled: $('#set-root')?.disabled, "
                        "formValid: $('#node-form')?.checkValidity(), "
                        "toast: $('#toast')?.textContent})"
                    )
                    raise AssertionError(f"{expression}: {detail}; errors: {errors}")

            async def wait(expression):
                for _ in range(100):
                    if await js(f"Boolean({expression})"):
                        return
                    await asyncio.sleep(0.05)
                details = await js(
                    "({url: location.href, ready: document.readyState, "
                    "reloadMarker: window.editorReloadCheck, "
                    "toast: document.querySelector('#toast')?.textContent})"
                )
                raise AssertionError(f"{expression}: {details}; browser errors: {errors}")

            async def change(selector, value):
                if selector.startswith("[data-connection="):
                    branch = selector.split('"')[1]
                    await click(f'[data-branch="{branch}"] [data-action="connect"]')
                    await expect('$("#connect-node-dialog").open')
                    await change("#connect-node-target", value)
                    await click('#connect-node-form button[type="submit"]')
                    await expect('!$("#connect-node-dialog").open')
                    return
                await js(f"""(() => {{
                    const element = document.querySelector({json.dumps(selector)});
                    element.value = {json.dumps(value)};
                    element.dispatchEvent(new Event('input', {{bubbles: true}}));
                    element.dispatchEvent(new Event('change', {{bubbles: true}}));
                }})()""")

            async def click(selector):
                await js(f"document.querySelector({json.dumps(selector)}).click()")

            async def add_module(label, node_type="condition", branch=None):
                await click(
                    f'[data-branch="{branch}"] [data-action="insert"]'
                    if branch
                    else "#add-node-button"
                )
                await expect('$("#new-node-dialog").open')
                await click(f'[name="new-node-type"][value="{node_type}"]')
                await change("#new-node-label", label)
                if node_type == "decision":
                    branch_label = "Sí" if branch == "true_node" else "No"
                    expected_preview = (
                        f"La rama {branch_label} termina en este resultado."
                        if branch
                        else "El resultado quedará sin conectar en el borrador."
                    )
                    await expect(
                        '$("#new-node-preview").textContent.startsWith('
                        f"{json.dumps(expected_preview)})"
                    )
                await click('#new-node-form button[type="submit"]')
                await expect('!$("#new-node-dialog").open')
                return await js("state.selected")

            async def save():
                await click(".apply-button")
                await wait("!state.saving && !state.editorDirty")
                await expect('$("#undo-draft").disabled && $("#redo-draft").disabled')

            async def shortcut(key, modifiers):
                await call(
                    "Input.dispatchKeyEvent",
                    {
                        "type": "keyDown",
                        "key": key,
                        "code": f"Key{key.upper()}",
                        "modifiers": modifiers,
                    },
                )

                await call(
                    "Input.dispatchKeyEvent",
                    {
                        "type": "keyUp",
                        "key": key,
                        "code": f"Key{key.upper()}",
                        "modifiers": modifiers,
                    },
                )

            async def drag_node(node_id, dx, dy):
                await click(f'[data-node-id="{node_id}"]')
                await click("#locate-node")
                point = await js(f"""(() => {{
                    const node = document.querySelector('[data-node-id="{node_id}"]');
                    const box = node.getBoundingClientRect();
                    return {{x: box.x + box.width / 2, y: box.y + box.height / 2}};
                }})()""")
                await call(
                    "Input.dispatchMouseEvent",
                    {
                        "type": "mousePressed",
                        "x": point["x"],
                        "y": point["y"],
                        "button": "left",
                        "clickCount": 1,
                    },
                )
                await call(
                    "Input.dispatchMouseEvent",
                    {
                        "type": "mouseMoved",
                        "x": point["x"] + dx,
                        "y": point["y"] + dy,
                        "button": "left",
                        "buttons": 1,
                    },
                )
                await call(
                    "Input.dispatchMouseEvent",
                    {
                        "type": "mouseReleased",
                        "x": point["x"] + dx,
                        "y": point["y"] + dy,
                        "button": "left",
                        "clickCount": 1,
                    },
                )
                await wait("!state.nodeDrag")

            await call("Runtime.enable")
            await call("Page.enable")
            await call(
                "Emulation.setDeviceMetricsOverride",
                {
                    "width": 1440,
                    "height": 1000,
                    "deviceScaleFactor": 1,
                    "mobile": False,
                },
            )
            await call("Page.navigate", {"url": base_url})
            await wait('typeof state !== "undefined" && state.savedPolicy && $(".validation-row")')
            await expect('state.editingVersion === "browser-editor-check" && !state.editorDirty')

            # Main's search, focus, minimap and visual layout undo remain independent of drafts.
            await shortcut("k", 4)
            await wait('$("#node-search-dialog").open')
            await change("#node-search", "income")
            await click(".node-search-result")
            await expect('state.selected === "income" && !state.editorDirty')
            await click("#focus-mode-button")
            await expect('state.focusMode && $("#inspector").hidden')
            await click("#toggle-inspector")
            await expect('!$("#inspector").hidden')
            await click("#focus-mode-button")
            await expect("!state.focusMode")
            before_drag = await js("JSON.stringify(state.policy)")
            await drag_node("income", 80, 30)
            await expect('state.nodePositions.income && !$("#undo-layout").hidden')
            await expect('!state.editorDirty && $("#undo-draft").disabled')
            await expect(f"JSON.stringify(state.policy) === {json.dumps(before_drag)}")
            await click("#auto-layout")
            await expect("!Object.keys(state.nodePositions).length")
            await click("#undo-layout")
            await expect("state.nodePositions.income && !state.editorDirty")
            await click("#auto-layout")
            await expect(
                '$$("svg path").every(path => !/NaN|undefined/.test(path.getAttribute("d") || ""))'
            )
            await click('[data-node-id="bureau-floor"]')

            # Undo/redo restores complete drafts, including invalid raw form inputs.
            await expect('$("#undo-draft").disabled && $("#redo-draft").disabled')
            original_label = await js('$("#node-label").value')
            await change('[data-connection="true_node"]', "")
            await expect('state.policy.nodes["bureau-floor"].true_node === null')
            await click("#undo-draft")
            await expect('!state.editorDirty && !$("#redo-draft").disabled')
            await click("#redo-draft")
            await expect('state.policy.nodes["bureau-floor"].true_node === null')
            await js('$("#tree-viewport").focus()')
            await shortcut("z", 2)  # Ctrl+Z
            await expect("!state.editorDirty")
            await shortcut("z", 10)  # Ctrl+Shift+Z
            await expect('state.policy.nodes["bureau-floor"].true_node === null')
            await shortcut("z", 4)  # Command+Z
            await expect("!state.editorDirty")
            await shortcut("z", 12)  # Command+Shift+Z
            await expect("state.editorDirty")
            await shortcut("z", 2)
            await shortcut("y", 2)  # Ctrl+Y
            await expect("state.editorDirty")
            await shortcut("z", 2)

            # Repeated input events in the same field form a single undo step.
            await js(
                '$("#node-label").focus(); $("#node-label").value = "typing"; '
                '$("#node-label").dispatchEvent(new Event("input", {bubbles: true})); '
                '$("#node-label").value = ""; '
                '$("#node-label").dispatchEvent(new Event("input", {bubbles: true}))'
            )
            await expect('$("#redo-draft").disabled')
            await shortcut("z", 4)
            await expect(f'$("#node-label").value === {json.dumps(original_label)}')
            await expect("!state.editorDirty")
            await shortcut("z", 12)
            await expect('$("#node-label").value === "" && state.editorDirty')
            await click("#undo-draft")

            await change("#node-combination", "AND")
            await click("#add-validation")
            await click("#undo-draft")
            await expect('$$(".validation-row").length === 1')
            await click("#redo-draft")
            await expect('$$(".validation-row").length === 2')
            await click(".validation-row:last-child .remove-validation")
            await click("#undo-draft")
            await expect('$$(".validation-row").length === 2')
            await change(".validation-row:last-child [data-validation-operator]", "in")
            await change(".validation-row:last-child [data-validation-value]", "[invalid")
            await click(".apply-button")
            await expect("state.editorDirty && !state.saving")
            await click("#undo-draft")
            await expect('$(".validation-row:last-child [data-validation-value]").value === ""')
            await click("#redo-draft")
            await expect(
                '$(".validation-row:last-child [data-validation-value]").value === "[invalid"'
            )
            await click("#discard-draft")
            await click("#confirm-discard")
            await expect(
                '!state.editorDirty && $("#undo-draft").disabled && $("#redo-draft").disabled'
            )

            history_node = await add_module("Undo inserted condition", branch="true_node")
            await click("#undo-draft")
            await expect(f"!state.policy.nodes[{json.dumps(history_node)}] && !state.editorDirty")
            await click("#redo-draft")
            await expect(f"state.selected === {json.dumps(history_node)}")
            await click("#set-root")
            await click("#undo-draft")
            await expect('state.policy.root_node === "bureau-floor"')
            await click("#redo-draft")
            await expect(f"state.policy.root_node === {json.dumps(history_node)}")
            await click("#undo-draft")
            await click("#delete-module")
            await click('#delete-module-form button[type="submit"]')
            await expect(f"!state.policy.nodes[{json.dumps(history_node)}]")
            await click("#undo-draft")
            await expect(
                f'state.policy.nodes["bureau-floor"].true_node === {json.dumps(history_node)}'
            )
            await expect('state.policy.nodes[state.selected].true_node === "affordability"')
            await click("#redo-draft")
            await expect(f"!state.policy.nodes[{json.dumps(history_node)}]")
            await click("#discard-draft")
            await click("#confirm-discard")
            remote = (await client.get(f"{base_url}/api/policies/browser-editor-check")).json()
            assert remote == candidate, "Undo/redo must never persist automatically"

            # No-op connections do not consume history. Dialog shortcuts stay native.
            await change('[data-connection="true_node"]', "affordability")
            await expect('$("#undo-draft").disabled && !state.editorDirty')
            await change("#node-label", "Before dialog")
            await click("#add-node-button")
            await shortcut("z", 4)
            await expect('$("#new-node-dialog").open && $("#node-label").value === "Before dialog"')
            await click("#new-node-cancel")
            await click("#undo-draft")
            await expect("!state.editorDirty")
            await change("#editor-version-select", production["metadata"]["version"])
            await wait("!state.loadingPolicy && state.editingVersion === state.activeVersion")
            await expect('$("#redo-draft").disabled')
            await change("#editor-version-select", "browser-editor-check")
            await wait('!state.loadingPolicy && state.editingVersion === "browser-editor-check"')
            for index in range(101):
                await change("#node-label", f"History limit {index}")
            for _ in range(100):
                await click("#undo-draft")
            await expect(
                '$("#undo-draft").disabled && $("#node-label").value === "History limit 0"'
            )
            await click("#discard-draft")
            await click("#confirm-discard")

            # Inspecting existing nodes must not dirty a legacy policy or prevent navigation.
            await click('[data-node-id="income"]')
            await expect("!state.editorDirty")
            await click('[data-node-id="bureau-floor"]')
            await change("#node-label", "Bureau edited before inserting")
            added = await add_module("Income present", branch="true_node")
            await expect(
                'state.policy.nodes["bureau-floor"].label === "Bureau edited before inserting"'
            )
            await expect('state.policy.nodes[state.selected].true_node === "affordability"')
            await expect("state.policy.nodes[state.selected].false_node === null")
            await click(".apply-button")
            await expect("state.editorDirty && !state.saving")
            remote = (await client.get(f"{base_url}/api/policies/browser-editor-check")).json()
            assert added not in remote["nodes"], "Incomplete drafts must not reach persistence"
            await click("#run-button")
            await wait('$("#unsaved-dialog").open')
            await click("#unsaved-stay")
            await expect('state.mode === "edit" && state.editorDirty')

            # All three combination modes, boolean thresholds, and repeated validations.
            await change("[data-validation-operator]", "has_value")
            await change("[data-validation-value]", "false")
            await change("#node-combination", "AND")
            await click("#add-validation")
            await expect(
                '$$(".validation-row").length === 2 && '
                '$("#node-combination option[value=none]").disabled'
            )
            await change("#node-combination", "OR")
            await click(".validation-row:last-child .remove-validation")
            await change("#node-combination", "none")
            await change("[data-validation-value]", "true")

            terminal = await add_module("Manual check", "decision", "false_node")
            await change("#node-reason", "EDITOR_MANUAL_CHECK")
            await click("#undo-draft")
            await expect('$("#node-reason").value === "POLICY_REVIEW"')
            await click("#redo-draft")
            await expect('$("#node-reason").value === "EDITOR_MANUAL_CHECK"')
            await save()
            await click(f'[data-node-id="{added}"]')
            await expect(
                '$("[data-validation-value]").value === "true" && $("#add-validation").disabled'
            )

            # The same cycle guard backs the dialog and canvas connections.
            await click('[data-branch="true_node"] [data-action="connect"]')
            await expect('!$("#connect-node-target option[value=\\"bureau-floor\\"]")')
            await click("#connect-node-cancel")
            await click(f'.branch-port[data-source="{added}"][data-branch="false_node"]')
            await click('[data-node-id="bureau-floor"]')
            await expect(
                f"state.policy.nodes[{json.dumps(added)}].false_node === {json.dumps(terminal)}"
            )
            await click("#draft-status button")
            await expect("!state.connecting")

            # Detached modules have finite, nonoverlapping positions and cannot be saved.
            detached = await add_module("Detached result", "decision")
            await expect(
                '$$(".tree-node").every(n => Number.isFinite(parseFloat(n.style.left)) && '
                "Number.isFinite(parseFloat(n.style.top)))"
            )
            await expect(f'$(\'[data-node-id="{detached}"]\').classList.contains("disconnected")')
            await click(f'.branch-port[data-source="{added}"][data-branch="false_node"]')
            await click(f'[data-node-id="{detached}"]')
            await expect(
                f"state.policy.nodes[{json.dumps(added)}].false_node === {json.dumps(detached)}"
            )
            await expect(
                'PolicyGraph.issues(state.policy).some(issue => issue.includes("Manual check"))'
            )
            await click(f'[data-node-id="{terminal}"]')
            await click("#delete-module")
            await click('#delete-module-form button[type="submit"]')
            await expect(f"!state.policy.nodes[{json.dumps(terminal)}]")
            await save()

            # A new root can link to the whole old graph without duplicating descendants.
            new_root = await add_module("New entry")
            await expect(f'state.policy.nodes[{json.dumps(new_root)}].label === "New entry"')
            await change('[data-connection="true_node"]', "bureau-floor")
            await expect(f"state.selected === {json.dumps(new_root)}")
            await change('[data-connection="false_node"]', "reject-bureau")
            await expect(f"state.selected === {json.dumps(new_root)}")
            await click("#set-root")
            await expect(f"state.policy.root_node === {json.dumps(new_root)}")
            await save()

            # Removing the root requires a replacement and preserves all remaining modules.
            await click("#delete-module")
            await change("#replacement-root", "bureau-floor")
            await click('#delete-module-form button[type="submit"]')
            await expect('state.policy.root_node === "bureau-floor"')
            await save()

            # Failed saves retain the draft and permit retry.
            await change("#node-label", "Retry after failure")
            await js(
                "window.originalFetch = window.fetch; window.fetch = (url, options) => "
                "options?.method === 'PUT' ? "
                "Promise.resolve(new Response('Test failure', {status: 503})) : "
                "window.originalFetch(url, options)"
            )
            await click(".apply-button")
            await wait('!state.saving && $("#toast").textContent.includes("No se pudo guardar")')
            await expect('state.editorDirty && $("#node-label").value === "Retry after failure"')
            await expect('!$("#undo-draft").disabled')
            await click("#undo-draft")
            await expect('$("#node-label").value !== "Retry after failure"')
            await click("#redo-draft")
            await expect('$("#node-label").value === "Retry after failure"')
            await js("window.fetch = window.originalFetch")
            await save()

            # Reload confirms persistence, and local discard restores the entire saved graph.
            await call(
                "Page.addScriptToEvaluateOnNewDocument",
                {
                    "source": "window.editorReloadCheck = true;",
                },
            )
            await call("Page.reload")
            await wait(
                'window.editorReloadCheck && typeof state !== "undefined" '
                '&& state.savedPolicy && $(".validation-row")'
            )
            await expect('state.policy.nodes["bureau-floor"].label === "Retry after failure"')
            if screenshot:
                capture = await call("Page.captureScreenshot", {"format": "png"})
                screenshot.write_bytes(base64.b64decode(capture["data"]))
            await add_module("Throw away")
            await click("#discard-draft")
            await click("#confirm-discard")
            await expect(
                "!state.editorDirty && "
                '!Object.values(state.policy.nodes).some(n => n.label === "Throw away")'
            )
            await click("#run-button")
            await wait('$("#evaluation-status").dataset.stage === "success"')
            await expect(
                '$$("#node-form input, #node-form select, #node-form button")'
                ".every(c => c.disabled)"
            )
            await expect('$("#undo-draft").disabled && $("#redo-draft").disabled')
            await js("setMode('edit')")
            await change("#editor-version-select", production["metadata"]["version"])
            await wait("state.editingVersion === state.activeVersion")
            await expect(
                '$("#add-node-button").disabled && $$(".branch-port").every(c => c.disabled)'
            )
            await expect('$("#undo-draft").disabled && $("#redo-draft").disabled')
            await click("#add-node-button")
            await shortcut("z", 2)
            await expect('!$("#new-node-dialog").open && state.policy.root_node === "bureau-floor"')
            assert (await client.get(f"{base_url}/api/policy")).json() == production
            assert not errors, errors
            print(
                "PASS: graph editing, condition validations, pending connections, cycles, "
                "root changes, deletion, save/reload/retry, discard, evaluation, "
                "productive lock, undo/redo, and keyboard shortcuts"
            )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--screenshot", type=Path, help="Optionally save a screenshot of the edited candidate"
    )
    parser.add_argument(
        "--chrome",
        default=(
            shutil.which("google-chrome")
            or shutil.which("chromium")
            or "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        ),
    )
    args = parser.parse_args()
    if not Path(args.chrome).is_file():
        parser.error("Chrome not found; supply --chrome /path/to/chrome")
    with tempfile.TemporaryDirectory(prefix="credit-policy-editor-") as directory:
        server_port, browser_port = free_port(), free_port()
        env = {
            **os.environ,
            "APP_ENV": "local",
            "LOCAL_POLICY_PATH": str(ROOT / "policies/credit_policy_v1.json"),
        }
        server = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "credit_policy_studio.api:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(server_port),
                "--log-level",
                "error",
            ],
            cwd=directory,
            env=env,
        )
        browser = None
        try:
            browser = subprocess.Popen(
                [
                    args.chrome,
                    "--headless",
                    "--disable-gpu",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-background-networking",
                    f"--remote-debugging-port={browser_port}",
                    f"--user-data-dir={directory}/chrome",
                    "about:blank",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            asyncio.run(
                check_editor(
                    f"http://127.0.0.1:{server_port}",
                    f"http://127.0.0.1:{browser_port}",
                    args.screenshot,
                )
            )
        finally:
            for process in (browser, server):
                if process is not None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


if __name__ == "__main__":
    main()
