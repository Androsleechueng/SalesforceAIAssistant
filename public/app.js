const state = {
  cases: [],
  team: [],
  policies: [],
  selectedCaseId: null,
  filter: "all",
  chatBusy: false
};

const phases = ["Intake", "Phase 1", "Info Request", "Phase 2", "Remedies", "Decision", "Closed"];

const $ = (id) => document.getElementById(id);

function setChatBusy(isBusy) {
  state.chatBusy = isBusy;
  const controls = [
    $("chat-input"),
    document.querySelector(".send-button"),
    $("recommend-team"),
    $("ask-team"),
    $("ask-policy"),
    $("generate-grounds")
  ].filter(Boolean);

  for (const control of controls) {
    control.disabled = isBusy;
  }

  document.querySelector(".assistant-panel")?.classList.toggle("is-busy", isBusy);
}

function selectedCase() {
  return state.cases.find((item) => item.id === state.selectedCaseId) || state.cases[0];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inlineFormat(value) {
  return escapeHtml(value).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function renderFormattedText(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }

    const heading = line.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      closeList();
      html.push(`<h3>${inlineFormat(heading[2])}</h3>`);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        html.push("<ul>");
      }
      html.push(`<li>${inlineFormat(bullet[1])}</li>`);
      continue;
    }

    const numbered = line.match(/^\d+\.\s+(.+)$/);
    if (numbered) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        html.push("<ol>");
      }
      html.push(`<li>${inlineFormat(numbered[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${inlineFormat(line)}</p>`);
  }

  closeList();
  return html.join("");
}

function renderPath(caseRecord) {
  $("path-track").innerHTML = phases.map((phase) => {
    const active = phase === caseRecord.phase || (caseRecord.phase === "Intake" && phase === "Intake");
    return `<button class="path-step ${active ? "active" : ""}" type="button">${phase}</button>`;
  }).join("");
}

function renderCaseList() {
  const query = $("global-search").value.trim().toLowerCase();
  const filtered = state.cases.filter((caseRecord) => {
    const matchesFilter = state.filter === "all" || caseRecord.status === state.filter;
    const haystack = `${caseRecord.reference} ${caseRecord.subject} ${caseRecord.industry} ${caseRecord.parties.acquirer} ${caseRecord.parties.target}`.toLowerCase();
    return matchesFilter && (!query || haystack.includes(query));
  });
  $("case-count").textContent = `${filtered.length} shown`;
  $("case-list").innerHTML = filtered.map((caseRecord) => `
    <button class="case-card ${caseRecord.id === state.selectedCaseId ? "active" : ""}" data-case-id="${caseRecord.id}">
      <strong>${escapeHtml(caseRecord.reference)}</strong>
      <span>${escapeHtml(caseRecord.subject)}</span>
      <span>${escapeHtml(caseRecord.status)} / ${escapeHtml(caseRecord.phase)}</span>
    </button>
  `).join("");

  document.querySelectorAll(".case-card").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCaseId = button.dataset.caseId;
      render();
      addMessage("assistant", `Loaded ${selectedCase().reference}. What would you like to assess?`);
    });
  });
}

function statusColor(member) {
  if (member.capacity === "High") return "var(--green-600)";
  if (member.capacity === "Medium") return "var(--amber-600)";
  return "var(--red-600)";
}

function renderTeam(caseRecord, recommendations = null) {
  const names = recommendations ? recommendations.map((member) => member.name) : caseRecord.team;
  const members = names.length
    ? names.map((name) => state.team.find((member) => member.name === name) || recommendations?.find((member) => member.name === name)).filter(Boolean)
    : [];

  if (!members.length) {
    $("team-strip").innerHTML = `<div class="member-card"><strong>No team assigned</strong><span>Ask the assistant to recommend assignees based on case facts and past matters.</span></div>`;
    return;
  }

  $("team-strip").innerHTML = members.map((member) => `
    <article class="member-card">
      <div class="member-card-top">
        <strong>${escapeHtml(member.name)}</strong>
        ${recommendations ? "" : `<button class="remove-member" type="button" data-member-name="${escapeHtml(member.name)}" title="Remove team member" aria-label="Remove ${escapeHtml(member.name)}">x</button>`}
      </div>
      <span>${escapeHtml(member.role)} / ${member.yearsExperience} yrs</span>
      <span>${escapeHtml(member.industries.slice(0, 3).join(", "))}</span>
      <span style="color:${statusColor(member)}">Capacity: ${escapeHtml(member.capacity)}</span>
      ${member.score ? `<span>Fit score: ${member.score}</span>` : ""}
    </article>
  `).join("");

  document.querySelectorAll(".remove-member").forEach((button) => {
    button.addEventListener("click", async () => {
      await removeTeamMember(button.dataset.memberName);
    });
  });
}

function renderDetails() {
  const caseRecord = selectedCase();
  if (!caseRecord) return;

  $("summary-subject").textContent = caseRecord.subject;
  $("summary-status").textContent = caseRecord.status;
  $("summary-priority").textContent = caseRecord.priority;
  $("summary-origin").textContent = caseRecord.caseOrigin;
  $("field-reference").textContent = caseRecord.reference;
  $("field-type").textContent = caseRecord.transactionType;
  $("field-owner").textContent = caseRecord.owner || "Unassigned";
  $("field-priority").textContent = caseRecord.priority;
  $("field-status").textContent = caseRecord.status;
  $("field-industry").textContent = caseRecord.industry;
  $("field-start").textContent = caseRecord.commencementDate;
  $("field-due").textContent = caseRecord.dueDate;
  $("field-summary").textContent = caseRecord.summary;
  $("metric-share").textContent = `${caseRecord.marketShare.combined}%`;
  $("metric-cr3").textContent = `${caseRecord.marketShare.cr3}%`;
  $("market-product").textContent = caseRecord.marketDefinition.product;
  $("market-geography").textContent = caseRecord.marketDefinition.geography;
  $("issue-tags").innerHTML = caseRecord.keyIssues.map((issue) => `<span class="tag">${escapeHtml(issue)}</span>`).join("");

  renderPath(caseRecord);
  renderTeam(caseRecord);
}

function render() {
  renderCaseList();
  renderDetails();
}

function addMessage(role, text, recommendations) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.innerHTML = role === "assistant" ? renderFormattedText(text) : escapeHtml(text);

  if (recommendations?.length) {
    for (const member of recommendations) {
      const item = document.createElement("div");
      item.className = "recommendation";
      item.innerHTML = `<strong>${escapeHtml(member.name)} / score ${member.score}</strong><br>${escapeHtml(member.rationale)}`;
      node.appendChild(item);
    }
  }

  $("chat-log").appendChild(node);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
  return node;
}

function addStreamingMessage() {
  const node = document.createElement("div");
  node.className = "message assistant streaming";
  node.dataset.rawText = "";
  node.innerHTML = `<p class="typing">Thinking...</p>`;
  $("chat-log").appendChild(node);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
  return node;
}

function updateStreamingMessage(node, text, done = false) {
  node.dataset.rawText = text;
  node.innerHTML = text ? renderFormattedText(text) : `<p class="typing">Thinking...</p>`;
  node.classList.toggle("streaming", !done);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
}

function addDraftDownloadAction(node, content) {
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const button = document.createElement("button");
  button.className = "secondary-button";
  button.type = "button";
  button.textContent = "Download draft";
  button.addEventListener("click", () => {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${selectedCase().reference}-grounds-of-decision-draft.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
  actions.appendChild(button);
  node.appendChild(actions);
}

async function postJson(url, payload) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    throw new Error("Local server is not reachable. Restart it with npm start, then refresh this page.");
  }
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function removeTeamMember(memberName) {
  if (state.chatBusy) return;
  const caseRecord = selectedCase();
  const response = await postJson("/api/cases/team/remove", {
    caseId: caseRecord.id,
    memberName
  });
  const index = state.cases.findIndex((item) => item.id === response.case.id);
  if (index >= 0) state.cases[index] = response.case;
  render();
  addMessage("system", `${memberName} removed from ${response.case.reference}.`);
}

async function streamChat(payload, handlers) {
  let response;
  try {
    response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    throw new Error("Local server is not reachable. Restart it with npm start, then refresh this page.");
  }

  if (!response.ok) throw new Error(await response.text());

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const rawEvent of events) {
      const eventLine = rawEvent.split("\n").find((line) => line.startsWith("event:"));
      const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;

      const event = eventLine ? eventLine.slice(6).trim() : "message";
      const data = JSON.parse(dataLine.slice(5).trim());
      if (event === "start") handlers.onStart?.(data);
      if (event === "delta") handlers.onDelta?.(data.text || "");
      if (event === "notice") handlers.onNotice?.(data.text || "");
      if (event === "recommendations") handlers.onRecommendations?.(data.recommendations || []);
      if (event === "done") handlers.onDone?.(data);
    }
  }
}

async function streamSsePost(url, payload, handlers) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    throw new Error("Local server is not reachable. Restart it with npm start, then refresh this page.");
  }

  if (!response.ok) throw new Error(await response.text());

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const rawEvent of events) {
      const eventLine = rawEvent.split("\n").find((line) => line.startsWith("event:"));
      const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const event = eventLine ? eventLine.slice(6).trim() : "message";
      const data = JSON.parse(dataLine.slice(5).trim());
      handlers[event]?.(data);
    }
  }
}

async function askAssistant(message) {
  if (state.chatBusy) return;
  const caseRecord = selectedCase();
  addMessage("user", message);
  setChatBusy(true);
  let assistantNode = null;
  let streamedText = "";
  try {
    assistantNode = addStreamingMessage();
    await streamChat(
      { message, caseId: caseRecord.id },
      {
        onStart: (data) => addMessage("system", `Streaming from ${data.model}.`),
        onDelta: (text) => {
          streamedText += text;
          updateStreamingMessage(assistantNode, streamedText);
        },
        onNotice: (text) => addMessage("system", text),
        onRecommendations: (recommendations) => {
          if (recommendations.length) renderTeam(caseRecord, recommendations);
        },
        onDone: () => updateStreamingMessage(assistantNode, streamedText, true)
      }
    );
  } catch (error) {
    if (assistantNode) assistantNode.remove();
    addMessage("system", `Chat request failed: ${error.message}`);
  } finally {
    setChatBusy(false);
    $("chat-input").focus();
  }
}

async function generateDecision() {
  if (state.chatBusy) return;
  setChatBusy(true);
  addMessage("user", `Generate grounds of decision for ${selectedCase().reference}.`);
  const assistantNode = addStreamingMessage();
  let content = "";
  try {
    await streamSsePost(
      "/api/generate-decision/stream",
      { caseId: selectedCase().id },
      {
        start: (data) => {
          addMessage("system", `Generating ${data.title} with ${data.model}.`);
        },
        delta: (data) => {
          content += data.text || "";
          updateStreamingMessage(assistantNode, content);
        },
        notice: (data) => {
          addMessage("system", data.text);
        },
        done: () => {
          updateStreamingMessage(assistantNode, content, true);
          addDraftDownloadAction(assistantNode, content);
        }
      }
    );
  } catch (error) {
    assistantNode.remove();
    addMessage("system", `Grounds generation failed: ${error.message}`);
  } finally {
    setChatBusy(false);
  }
}

function downloadDraft() {
  const blob = new Blob([$("decision-output").value], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${selectedCase().reference}-grounds-of-decision-draft.txt`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function bindEvents() {
  $("global-search").addEventListener("input", renderCaseList);
  document.querySelectorAll(".segment").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".segment").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.filter = button.dataset.filter;
      renderCaseList();
    });
  });
  $("recommend-team").addEventListener("click", () => askAssistant("Recommend team members for this case and explain why."));
  $("ask-team").addEventListener("click", () => askAssistant("Recommend team members for this case and explain why."));
  $("ask-policy").addEventListener("click", () => askAssistant("Summarise the Singapore merger policies relevant to this case."));
  $("generate-grounds").addEventListener("click", generateDecision);
  $("download-decision").addEventListener("click", downloadDraft);
  $("copy-decision").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("decision-output").value);
    $("copy-decision").textContent = "Copied";
    setTimeout(() => {
      $("copy-decision").textContent = "Copy Text";
    }, 1200);
  });
  $("chat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("chat-input");
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    await askAssistant(message);
  });
  $("chat-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("chat-form").requestSubmit();
    }
  });
}

async function init() {
  const [dataResponse, statusResponse] = await Promise.all([
    fetch("/api/data"),
    fetch("/api/llm-status")
  ]);
  const data = await dataResponse.json();
  const llmStatus = await statusResponse.json();
  state.cases = data.cases;
  state.team = data.team;
  state.policies = data.policies;
  state.selectedCaseId = state.cases[0].id;
  $("llm-status").textContent = llmStatus.configured
    ? `Using ${llmStatus.model} via ${llmStatus.source}`
    : `Local fallback active. Add an API key to use ${llmStatus.model}.`;
  bindEvents();
  render();
  addMessage("assistant", "Hello. I can recommend a case team, answer questions using the case files and CCS merger policy notes, or generate a draft grounds of decision.");
}

init().catch((error) => {
  document.body.innerHTML = `<pre>${escapeHtml(error.stack || error.message)}</pre>`;
});
