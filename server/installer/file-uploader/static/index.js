let canSubmit = true;

// ── localStorage key for persisting in-flight task across page reloads ──────
const STORAGE_KEY = "wfr_upload_task_id";

function applyDbcSelectMode() {
	const select = document.getElementById("dbc-select");
	const input = document.getElementById("dbc-input");
	if (!select || !input) return;
	const v = select.value;
	if (v === "custom") {
		input.disabled = false;
	} else {
		input.disabled = true;
		input.value = "";
		const label = document.getElementById("dbc-name-label");
		if (label) label.innerText = "";
	}
}

async function loadDbcList() {
	const select = document.getElementById("dbc-select");
	const hint = document.getElementById("dbc-list-hint");
	if (!select || !hint) return;
	select.innerHTML = "";
	hint.innerText = "Loading team DBC list…";
	try {
		const res = await fetch("/dbc/list");
		const data = await res.json();
		const optDefault = document.createElement("option");
		optDefault.value = "default";
		optDefault.textContent = "Default (container DBC)";
		const optCustom = document.createElement("option");
		optCustom.value = "custom";
		optCustom.textContent = "Custom upload…";

		if (!data.token_configured) {
			select.appendChild(optDefault);
			select.appendChild(optCustom);
			select.value = "default";
			hint.innerText =
				data.message ||
				"Set GITHUB_DBC_TOKEN on the server to list DBCs from Western-Formula-Racing/DBC.";
			applyDbcSelectMode();
			return;
		}

		if (data.error) {
			hint.innerText = data.error;
		} else {
			hint.innerText = "";
		}

		const items = data.items || [];
		for (const path of items) {
			const opt = document.createElement("option");
			opt.value = "github:" + path;
			opt.textContent = path;
			select.appendChild(opt);
		}
		select.appendChild(optCustom);

		if (items.length === 0) {
			select.value = "custom";
			hint.innerText =
				(hint.innerText ? hint.innerText + " " : "") +
				"No .dbc files in repo; upload a custom file.";
		} else {
			select.value = "github:" + items[0];
		}
		applyDbcSelectMode();
	} catch (e) {
		console.error(e);
		hint.innerText = "Could not load team DBC list.";
		const optDefault = document.createElement("option");
		optDefault.value = "default";
		optDefault.textContent = "Default (container DBC)";
		const optCustom = document.createElement("option");
		optCustom.value = "custom";
		optCustom.textContent = "Custom upload…";
		select.appendChild(optDefault);
		select.appendChild(optCustom);
		select.value = "default";
		applyDbcSelectMode();
	}
}

function appendDbcToForm(form) {
	const select = document.getElementById("dbc-select");
	const dbcFile = document.getElementById("dbc-input")?.files?.[0];
	if (!select) return;
	const v = select.value;
	if (v.startsWith("github:")) {
		form.append("dbc_github_path", v.slice(7));
	} else if (v === "custom" && dbcFile) {
		form.append("dbc", dbcFile);
	}
}

async function parseUploadResponse(res) {
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return { error: text || res.statusText, _notJson: true };
	}
}

// ── "Safe to close" banner ───────────────────────────────────────────────────
function showSafeToCloseBanner(fileName, season) {
	let banner = document.getElementById("safe-to-close-banner");
	if (!banner) {
		banner = document.createElement("div");
		banner.id = "safe-to-close-banner";
		banner.style.cssText = `
			position: fixed; bottom: 24px; right: 24px; z-index: 999;
			background: #1a2e1a; border: 1px solid #4caf50; border-radius: 10px;
			padding: 14px 20px; color: #a5d6a7; font-size: 0.9em;
			box-shadow: 0 4px 20px rgba(0,0,0,0.5); max-width: 320px;
			line-height: 1.5;
		`;
		document.body.appendChild(banner);
	}
	banner.innerHTML = `
		<div style="font-weight:600; margin-bottom:4px;">✅ Upload running on server</div>
		<div style="opacity:0.85;">${fileName ? `<b>${fileName}</b> → ${season}<br>` : ""}
		You can safely <b>close this tab</b>.<br>
		You'll be notified on <b>Slack</b> when done.</div>
	`;
	banner.style.display = "block";
}

function hideSafeToCloseBanner() {
	const b = document.getElementById("safe-to-close-banner");
	if (b) b.style.display = "none";
}

// ── Drop zone helpers ────────────────────────────────────────────────────────
const DROP_SVG = `<svg id="file-upload-img" aria-hidden="true"
	xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 16">
	<path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"
	stroke-width="2"
	d="M13 13h3a3 3 0 0 0 0-6h-.025A5.56 5.56 0 0 0 16 6.5 5.5 5.5 0 0 0 5.207 5.021C5.137
	5.017 5.071 5 5 5a4 4 0 0 0 0 8h2.167M10 15V6m0 0L8 8m2-2 2 2"/>
</svg>
<h3>Click to upload CSV or ZIP, or drag and drop</h3>`;

const SPINNER_HTML = `<svg class="spinner" viewBox="0 0 50 50">
	<circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle>
</svg>
<h3>Uploading… (safe to close tab)</h3>`;

function setDropZoneState(state) {
	const dz = document.getElementById("drop_zone");
	if (!dz) return;
	dz.innerHTML = state === "uploading" ? SPINNER_HTML : DROP_SVG;
	if (state === "idle") {
		dz.addEventListener("drop", dropHandler);
		dz.addEventListener("dragover", dragOverHandler);
	}
}

// ── Progress handling ────────────────────────────────────────────────────────
function handleProgress(task_id, fileName, season) {
	canSubmit = false;
	localStorage.setItem(STORAGE_KEY, task_id);
	setDropZoneState("uploading");

	// Show safe-to-close banner immediately
	if (fileName || season) showSafeToCloseBanner(fileName, season);

	const eventSource = new EventSource(`/progress/${task_id}`);

	eventSource.onmessage = (e) => {
		const data = JSON.parse(e.data);

		// Update progress bar
		document.getElementById("progress-bar").style.width = `${data.pct}%`;
		document.getElementById("progress-bar_pct").innerText = data.pct + "%";
		document.getElementById("progress-bar_count").innerText =
			data.sent != null ? `${data.sent.toLocaleString()} / ${data.total.toLocaleString()} rows` : "";

		// Show banner with file info if we now have it
		if (data.name && !fileName) showSafeToCloseBanner(data.name, data.season || season);

		// Disable inputs while uploading
		["drop_zone-input", "season-select", "dbc-select", "dbc-input"].forEach((id) => {
			const el = document.getElementById(id);
			if (el) el.disabled = true;
		});

		if (data.done) {
			eventSource.close();
			localStorage.removeItem(STORAGE_KEY);
			hideSafeToCloseBanner();

			document.getElementById("progress-bar_pct").innerText = "Done ✓";
			document.getElementById("progress-bar_count").innerText =
				data.total ? `${data.total.toLocaleString()} rows written` : "Complete";

			["drop_zone-input", "season-select", "dbc-select", "dbc-input"].forEach((id) => {
				const el = document.getElementById(id);
				if (el) el.disabled = false;
			});

			applyDbcSelectMode();
			canSubmit = true;
			setDropZoneState("idle");

			document.getElementById("task-id-label").innerText = "";
			document.getElementById("file-name-label").innerText = "";
		}
	};

	eventSource.onerror = () => {
		// SSE disconnected (browser was closed and reopened, or network blip).
		// The server-side upload is still running. Re-connect after a pause.
		eventSource.close();
		setTimeout(() => {
			// Check if still in-flight by polling health
			fetch("/health")
				.then((r) => r.json())
				.then((h) => {
					const tasks = Object.entries(h.progress_array || {});
					const match = tasks.find(([id]) => id === task_id);
					if (match && !match[1].done) {
						// Still running — reconnect silently
						handleProgress(task_id);
					} else {
						// Gone — clean up
						localStorage.removeItem(STORAGE_KEY);
						hideSafeToCloseBanner();
						canSubmit = true;
						setDropZoneState("idle");
					}
				})
				.catch(() => {
					// Server unreachable — just reset UI
					localStorage.removeItem(STORAGE_KEY);
					hideSafeToCloseBanner();
					canSubmit = true;
					setDropZoneState("idle");
				});
		}, 3000);
	};
}

// ── Submit ───────────────────────────────────────────────────────────────────
function submitCsvUpload(files) {
	const name_label = document.getElementById("file-name-label");
	const selected_season = document.getElementById("season-select").value;

	if (!selected_season) {
		alert("Please select a season from the dropdown");
		return;
	}
	if (!files || files.length === 0) {
		alert("No Files Selected");
		return;
	}

	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		const n = file.name.toLowerCase();
		const okCsv = file.type === "text/csv" || n.endsWith(".csv") || file.type === "application/csv";
		const okZip = n.endsWith(".zip") || file.type === "application/zip" || file.type === "application/x-zip-compressed";
		if (!okCsv && !okZip) {
			alert(`${file.name} must be .csv or .zip`);
			return;
		}
	}

	const sel = document.getElementById("dbc-select");
	if (sel && sel.value === "custom") {
		const dbcFile = document.getElementById("dbc-input")?.files?.[0];
		const hasGithub = Array.from(sel.options).some((o) => o.value.startsWith("github:"));
		if (!dbcFile) {
			if (hasGithub) {
				alert("Select a team DBC from the list, or choose a custom .dbc file.");
				return;
			}
		}
	}

	const fileNames = Array.from(files).map((f) => f.name);
	const displayName =
		files.length === 1
			? fileNames[0]
			: `${files.length} files: ${fileNames.slice(0, 3).join(", ")}${files.length > 3 ? "…" : ""}`;

	name_label.innerText = displayName;
	name_label.style.color = "white";

	const form = new FormData();
	for (let i = 0; i < files.length; i++) form.append("file", files[i]);
	form.append("season", selected_season);
	appendDbcToForm(form);

	fetch("/upload", { method: "POST", body: form })
		.then((res) => parseUploadResponse(res))
		.then((data) => {
			if (data.error) {
				alert(data.error);
				location.reload();
				return;
			}
			if (data.task_id) {
				document.getElementById("task-id-label").innerText = data.task_id;
				handleProgress(data.task_id, displayName, selected_season);
			} else {
				console.error("No task_id", data);
				name_label.innerText = "Error (check console)";
				name_label.style.color = "red";
			}
		})
		.catch((err) => {
			console.error(err);
			name_label.innerText = "Error (check console)";
			name_label.style.color = "red";
		});
}

// ── Event handlers ───────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
	const dz = document.getElementById("drop_zone");
	dz.addEventListener("drop", dropHandler);
	dz.addEventListener("dragover", dragOverHandler);

	document.getElementById("drop_zone-input").addEventListener("change", clickHandler);
	document.getElementById("dbc-input").addEventListener("change", (e) => {
		const file = e.target.files[0];
		document.getElementById("dbc-name-label").innerText = file ? file.name : "";
	});

	const dbcSelect = document.getElementById("dbc-select");
	if (dbcSelect) dbcSelect.addEventListener("change", applyDbcSelectMode);

	loadDbcList();

	// Reconnect to any in-flight task — check server-side state first,
	// fall back to localStorage so closing the tab doesn't lose the task.
	const serverTaskId = document.getElementById("task-id-label").innerText.trim();
	const storedTaskId = localStorage.getItem(STORAGE_KEY);
	const resumeId = serverTaskId || storedTaskId;

	if (resumeId) {
		// Verify the task is still active before reconnecting
		fetch("/health")
			.then((r) => r.json())
			.then((h) => {
				const match = (h.progress_array || {})[resumeId];
				if (match && !match.done) {
					handleProgress(resumeId, match.name, match.season);
				} else {
					localStorage.removeItem(STORAGE_KEY);
				}
			})
			.catch(() => localStorage.removeItem(STORAGE_KEY));
	}
});

function clickHandler(e) {
	e.preventDefault();
	if (!canSubmit) {
		alert("An upload is already running. You can close this tab — you'll be notified on Slack when done.");
		return;
	}
	submitCsvUpload(e.target.files);
}

function dropHandler(e) {
	e.preventDefault();
	if (!canSubmit) {
		alert("An upload is already running. You can close this tab — you'll be notified on Slack when done.");
		return;
	}
	submitCsvUpload(e.dataTransfer?.files);
}

function dragOverHandler(e) {
	e.preventDefault();
}

function createBucket() {
	const name = document.getElementById("new-bucket-input").value.trim();
	const msg = document.getElementById("create-bucket-msg");
	const btn = document.getElementById("create-bucket-btn");
	if (!name) {
		msg.innerText = "Enter a name first.";
		msg.style.color = "salmon";
		return;
	}
	btn.disabled = true;
	msg.style.color = "";
	msg.innerText = "Creating...";
	fetch("/create-season", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name }),
	})
		.then((res) => res.json())
		.then((data) => {
			if (data.error) {
				msg.innerText = data.error;
				msg.style.color = "salmon";
				btn.disabled = false;
				return;
			}
			const select = document.getElementById("season-select");
			const opt = document.createElement("option");
			opt.value = data.name;
			opt.innerText = data.name;
			opt.selected = true;
			select.appendChild(opt);
			document.getElementById("new-bucket-input").value = "";
			msg.innerText = "Created!";
			msg.style.color = "lightgreen";
			btn.disabled = false;
			setTimeout(() => { msg.innerText = ""; }, 3000);
		})
		.catch((err) => {
			msg.innerText = "Error (check console)";
			msg.style.color = "salmon";
			btn.disabled = false;
			console.error(err);
		});
}
