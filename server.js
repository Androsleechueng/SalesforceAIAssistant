const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = __dirname;
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const configPath = path.join(root, "config", "openai.config.json");
const port = Number(process.env.PORT || 3000);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error.stack || error.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason?.stack || reason);
});

async function readJson(file) {
  return JSON.parse(await fs.readFile(path.join(dataDir, file), "utf8"));
}

async function readOpenAiConfig() {
  const defaults = {
    apiKey: "",
    model: "gpt-5.5",
    maxOutputTokens: 1200
  };

  try {
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    return { ...defaults, ...config };
  } catch (error) {
    if (error.code === "ENOENT") return defaults;
    throw error;
  }
}

async function getContext() {
  const [cases, team, policies] = await Promise.all([
    readJson("cases.json"),
    readJson("team.json"),
    readJson("policies.json")
  ]);
  return { cases, team, policies };
}

async function writeCases(cases) {
  await fs.writeFile(path.join(dataDir, "cases.json"), `${JSON.stringify(cases, null, 2)}\n`, "utf8");
}

function scoreMember(member, caseRecord) {
  const text = [
    caseRecord.industry,
    caseRecord.marketDefinition?.product,
    caseRecord.marketDefinition?.geography,
    caseRecord.transactionType,
    caseRecord.keyIssues?.join(" ")
  ].join(" ").toLowerCase();

  const matches = (needle) => {
    const normalized = needle.toLowerCase();
    const stem = normalized.endsWith("s") ? normalized.slice(0, -1) : normalized;
    return text.includes(normalized) || text.includes(stem);
  };

  let score = member.yearsExperience * 0.4;
  for (const specialty of member.specialties) {
    if (matches(specialty)) score += 10;
  }
  for (const industry of member.industries) {
    if (matches(industry)) score += 18;
  }
  for (const skill of member.skills) {
    if (matches(skill)) score += 6;
  }
  for (const matter of member.previousMatters) {
    if (matches(matter.split("/")[0].trim()) || matches(caseRecord.parties.acquirer) || matches(caseRecord.parties.target)) {
      score += 8;
    }
  }
  if (caseRecord.phase === "Phase 2" && member.skills.includes("remedies")) score += 8;
  if (caseRecord.confidentiality === "High" && member.clearance === "Restricted") score += 4;
  if (member.capacity === "High") score += 4;
  if (member.capacity === "Medium") score += 2;
  if (member.capacity === "Low") score -= 5;
  return Math.round(score);
}

function recommendTeam(caseRecord, team) {
  return team
    .map((member) => ({
      ...member,
      score: scoreMember(member, caseRecord),
      rationale: `${member.name} brings ${member.yearsExperience} years of experience across ${member.industries.slice(0, 3).join(", ")} and has handled ${member.previousMatters.slice(0, 2).join(" and ")}.`
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

function findCase(cases, caseId) {
  return cases.find((item) => item.id === caseId) || cases[0];
}

function policySummary(policies) {
  return policies.map((policy) => `- ${policy.title}: ${policy.summary}`).join("\n");
}

function localAnswer({ message, caseId }, context) {
  const lower = message.toLowerCase();
  const caseRecord = findCase(context.cases, caseId);

  if (lower.includes("recommend") || lower.includes("assign") || lower.includes("team")) {
    const recommended = recommendTeam(caseRecord, context.team);
    return {
      type: "recommendations",
      text: `Recommended team for ${caseRecord.reference}: ${recommended.map((m) => m.name).join(", ")}. I weighted industry match, relevant merger experience, investigation skills, confidentiality clearance, and current case phase.`,
      recommendations: recommended
    };
  }

  if (lower.includes("policy") || lower.includes("guideline") || lower.includes("section 54") || lower.includes("phase")) {
    return {
      type: "policy",
      text: `Key Singapore merger policy points I can use:\n${policySummary(context.policies)}`
    };
  }

  if (lower.includes("deadline") || lower.includes("due") || lower.includes("timeline")) {
    return {
      type: "case",
      text: `${caseRecord.reference} is currently in ${caseRecord.phase}. Commencement date: ${caseRecord.commencementDate}. Target decision date: ${caseRecord.dueDate}. Next action: ${caseRecord.nextAction}.`
    };
  }

  if (lower.includes("ground") || lower.includes("decision") || lower.includes("draft")) {
    return {
      type: "document",
      text: `I can generate a draft grounds of decision for ${caseRecord.reference}. Use the "Generate Grounds" action above the chat to create a structured draft based on the case facts, Competition Act 2004 references, and CCS merger assessment themes.`
    };
  }

  return {
    type: "case",
    text: `${caseRecord.reference}: ${caseRecord.subject}. Status is ${caseRecord.status}, priority is ${caseRecord.priority}, industry is ${caseRecord.industry}, and the main issues are ${caseRecord.keyIssues.join(", ")}. ${caseRecord.summary}`
  };
}

function buildSystemPrompt(context) {
  return [
    "You are an internal AI assistant for Singapore merger and acquisition case handling.",
    "Answer from the supplied JSON case, team, recommendations, and policy context.",
    "Be practical and concise. If recommending team members, explain the fit and mention any capacity constraints.",
    "Format responses for readability using short paragraphs, markdown headings when useful, and bullet lists for multiple points.",
    "Use bold labels sparingly for key fields such as Recommended lead, Rationale, Risks, and Next action.",
    "For legal policy, refer to CCS/CCCS public merger guidance and the Competition Act 2004 at a high level; do not provide legal advice.",
    "If the user asks for facts not present in the context, say what is missing instead of inventing details."
  ].join("\n\n");
}

function buildUserPrompt(body, context) {
  const caseRecord = findCase(context.cases, body.caseId);
  const recommendations = recommendTeam(caseRecord, context.team);
  return [
    `Selected case:\n${JSON.stringify(caseRecord, null, 2)}`,
    `Recommended team ranking:\n${JSON.stringify(recommendations, null, 2)}`,
    `All cases available to you:\n${JSON.stringify(context.cases, null, 2)}`,
    `Team member datastore:\n${JSON.stringify(context.team, null, 2)}`,
    `Policy notes:\n${JSON.stringify(context.policies, null, 2)}`,
    `User question:\n${body.message}`
  ].join("\n\n");
}

function extractOutputText(result) {
  if (result.output_text) return result.output_text;

  const parts = [];
  for (const item of result.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
      if (content.type === "text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

async function openAiAnswer(body, context) {
  const config = await readOpenAiConfig();
  const apiKey = process.env.OPENAI_API_KEY || config.apiKey;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || config.model || "gpt-5.5";
  const maxOutputTokens = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || config.maxOutputTokens || 1200);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      instructions: buildSystemPrompt(context),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildUserPrompt(body, context)
            }
          ]
        }
      ],
      max_output_tokens: maxOutputTokens
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${text}`);
  }

  const result = await response.json();
  const text = extractOutputText(result);
  return {
    type: "llm",
    model,
    text: text || "I could not produce a response."
  };
}

async function openAiStream(body, context, onDelta) {
  const config = await readOpenAiConfig();
  const apiKey = process.env.OPENAI_API_KEY || config.apiKey;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || config.model || "gpt-5.5";
  const maxOutputTokens = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || config.maxOutputTokens || 1200);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      instructions: buildSystemPrompt(context),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildUserPrompt(body, context)
            }
          ]
        }
      ],
      max_output_tokens: maxOutputTokens,
      stream: true
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const event of events) {
      const dataLines = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      if (!dataLines.length) continue;

      const data = dataLines.join("\n");
      if (data === "[DONE]") continue;

      const parsed = JSON.parse(data);
      if (parsed.type === "response.output_text.delta" && parsed.delta) {
        onDelta(parsed.delta);
      }
      if (parsed.type === "response.error") {
        throw new Error(parsed.error?.message || "OpenAI streaming error");
      }
    }
  }

  return { type: "llm", model };
}

async function getOpenAiStatus() {
  const config = await readOpenAiConfig();
  const apiKey = process.env.OPENAI_API_KEY || config.apiKey;
  return {
    configured: Boolean(apiKey),
    model: process.env.OPENAI_MODEL || config.model || "gpt-5.5",
    source: process.env.OPENAI_API_KEY ? "environment" : "config file"
  };
}

function generateGrounds(caseRecord, policies) {
  const today = new Date().toISOString().slice(0, 10);
  const acquirer = caseRecord.parties.acquirer.replace(/\.$/, "");
  const target = caseRecord.parties.target.replace(/\.$/, "");
  const transaction = caseRecord.transactionType.toLowerCase().replace(/^acquisition/, "an acquisition");
  const outcome = caseRecord.workingOutcome.replace(/\.$/, "");
  return `COMPETITION AND CONSUMER COMMISSION OF SINGAPORE

GROUNDS OF DECISION

Proposed Transaction: ${caseRecord.subject}
Case Reference: ${caseRecord.reference}
Draft Date: ${today}
Classification: Internal draft

1. Introduction
1.1 This draft sets out the preliminary grounds of decision in relation to ${caseRecord.subject}.
1.2 The assessment considers whether the transaction has resulted, or may be expected to result, in a substantial lessening of competition in Singapore.

2. The Parties
2.1 Acquirer: ${acquirer}.
2.2 Target: ${target}.
2.3 The parties are active in ${caseRecord.industry.toLowerCase()}.

3. The Transaction
3.1 The transaction is described as ${transaction}.
3.2 The application is presently recorded at ${caseRecord.phase} with status ${caseRecord.status}.

4. Relevant Markets
4.1 Product market: ${caseRecord.marketDefinition.product}.
4.2 Geographic market: ${caseRecord.marketDefinition.geography}.
4.3 The working market definition remains open where the competitive assessment would not materially change under plausible alternatives.

5. Competition Assessment
5.1 The key issues identified are: ${caseRecord.keyIssues.join("; ")}.
5.2 The current record indicates a combined share of approximately ${caseRecord.marketShare.combined}% and a CR3 estimate of ${caseRecord.marketShare.cr3}%.
5.3 The assessment considers immediate competitive constraints, market concentration, closeness of competition, countervailing buyer power, barriers to entry and expansion, and efficiencies where substantiated.

6. Statutory and Policy Framework
${policies.map((policy, index) => `6.${index + 1} ${policy.title}: ${policy.summary}`).join("\n")}

7. Third Party Views and Confidentiality
7.1 Third party views should be considered where they bear on market definition, competitive constraints, customer switching, and entry conditions.
7.2 Confidential information should be identified clearly and supported with reasons for confidentiality treatment.

8. Preliminary Conclusion
8.1 On the information currently available, the proposed working outcome is: ${outcome}.
8.2 This draft is generated for internal case-team preparation and requires legal and economic review before issue.`;
}

function buildGroundsPrompt(caseRecord, context) {
  return [
    "Generate a fresh internal draft grounds of decision document for a Singapore merger assessment.",
    "Use a formal regulator style inspired by public CCS/CCCS grounds of decision documents.",
    "Use only the provided case, policy, and team context. Do not invent third party evidence or confidential facts.",
    "Where evidence is missing, write neutral placeholders such as '[case team to insert evidence]'.",
    "Include these sections: Introduction, The Parties, The Transaction, Relevant Markets, Competition Assessment, Statutory and Policy Framework, Third Party Views and Confidentiality, Preliminary Conclusion.",
    "Use unnumbered section headings, then numbered paragraphs beneath them.",
    "Number paragraphs sequentially across the entire document: 1., 2., 3., and so on. Do not restart paragraph numbering at each section and do not repeat 1.",
    "Make the document detailed enough to be useful as a first draft, but mark it as an internal draft requiring review.",
    `Selected case:\n${JSON.stringify(caseRecord, null, 2)}`,
    `Policy notes:\n${JSON.stringify(context.policies, null, 2)}`,
    `Assigned team and available team:\n${JSON.stringify(context.team, null, 2)}`
  ].join("\n\n");
}

async function openAiGroundsStream(caseRecord, context, onDelta) {
  const config = await readOpenAiConfig();
  const apiKey = process.env.OPENAI_API_KEY || config.apiKey;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || config.model || "gpt-5.5";
  const maxOutputTokens = Number(process.env.OPENAI_GROUNDS_MAX_OUTPUT_TOKENS || config.groundsMaxOutputTokens || 4000);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      instructions: [
        "You draft merger control grounds of decision documents for internal review.",
        "Write in clear formal prose with sequential numbered paragraphs.",
        "Every numbered paragraph must increment by one: 1., 2., 3., 4. Do not output every paragraph as 1.",
        "Do not provide legal advice. Do not invent facts."
      ].join("\n"),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildGroundsPrompt(caseRecord, context)
            }
          ]
        }
      ],
      max_output_tokens: maxOutputTokens,
      stream: true
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const event of events) {
      const dataLines = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      if (!dataLines.length) continue;
      const data = dataLines.join("\n");
      if (data === "[DONE]") continue;
      const parsed = JSON.parse(data);
      if (parsed.type === "response.output_text.delta" && parsed.delta) onDelta(parsed.delta);
      if (parsed.type === "response.error") throw new Error(parsed.error?.message || "OpenAI streaming error");
    }
  }

  return { model };
}

function normalizeGroundsNumbering(text) {
  let counter = 0;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*\d+\.\s+/.test(line) && !/^\s*\d+\.\d+\s+/.test(line)) {
        counter += 1;
        return line.replace(/^\s*\d+\.\s+/, `${counter}. `);
      }
      return line;
    })
    .join("\n");
}

async function writeTextAsSseDeltas(res, text) {
  const chunks = text.match(/[\s\S]{1,80}/g) || [];
  for (const chunk of chunks) {
    sendSse(res, "delta", { text: chunk });
  }
}

async function sendJson(res, status, payload) {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

function sendSseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamLocalAnswer(res, fallback, note) {
  sendSseHeaders(res);
  sendSse(res, "start", { type: fallback.type, model: "local fallback" });
  const words = fallback.text.split(/(\s+)/);
  for (const word of words) {
    sendSse(res, "delta", { text: word });
  }
  if (fallback.recommendations) {
    sendSse(res, "recommendations", { recommendations: fallback.recommendations });
  }
  if (note) {
    sendSse(res, "notice", { text: `LLM call failed, so local fallback answered instead: ${note}` });
  }
  sendSse(res, "done", {});
  res.end();
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  let filePath = url.pathname === "/" ? path.join(publicDir, "index.html") : path.join(publicDir, decodeURIComponent(url.pathname));
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  const ext = path.extname(normalized);
  const content = await fs.readFile(normalized);
  res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  res.on("error", (error) => {
    console.error("[responseError]", error.stack || error.message);
  });

  try {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (req.method === "GET" && url.pathname === "/api/data") {
      return sendJson(res, 200, await getContext());
    }

    if (req.method === "GET" && url.pathname === "/api/llm-status") {
      return sendJson(res, 200, await getOpenAiStatus());
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await parseBody(req);
      const context = await getContext();
      const fallback = localAnswer(body, context);
      try {
        const llm = await openAiAnswer(body, context);
        return sendJson(res, 200, llm || fallback);
      } catch (error) {
        const cause = error.cause ? ` (${error.cause.code || error.cause.message || "unknown cause"})` : "";
        return sendJson(res, 200, { ...fallback, note: `${error.message}${cause}` });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/cases/team/remove") {
      const body = await parseBody(req);
      const context = await getContext();
      const caseRecord = findCase(context.cases, body.caseId);
      caseRecord.team = (caseRecord.team || []).filter((name) => name !== body.memberName);
      if (caseRecord.owner === body.memberName) {
        caseRecord.owner = caseRecord.team[0] || null;
      }
      await writeCases(context.cases);
      return sendJson(res, 200, { case: caseRecord });
    }

    if (req.method === "POST" && url.pathname === "/api/chat/stream") {
      const body = await parseBody(req);
      const context = await getContext();
      const fallback = localAnswer(body, context);
      const openAiStatus = await getOpenAiStatus();
      if (!openAiStatus.configured) {
        return streamLocalAnswer(res, fallback);
      }

      try {
        sendSseHeaders(res);
        sendSse(res, "start", { type: "llm", model: openAiStatus.model });
        const result = await openAiStream(body, context, (text) => {
          sendSse(res, "delta", { text });
        });

        if (fallback.recommendations) {
          sendSse(res, "recommendations", { recommendations: fallback.recommendations });
        }
        sendSse(res, "done", { model: result.model });
        res.end();
        return;
      } catch (error) {
        const cause = error.cause ? ` (${error.cause.code || error.cause.message || "unknown cause"})` : "";
        if (res.headersSent) {
          sendSse(res, "notice", { text: `LLM stream failed, so local fallback is shown below: ${error.message}${cause}` });
          for (const word of fallback.text.split(/(\s+)/)) {
            sendSse(res, "delta", { text: word });
          }
          if (fallback.recommendations) {
            sendSse(res, "recommendations", { recommendations: fallback.recommendations });
          }
          sendSse(res, "done", {});
          res.end();
          return;
        }
        return streamLocalAnswer(res, fallback, `${error.message}${cause}`);
      }
    }

    if (req.method === "POST" && url.pathname === "/api/generate-decision") {
      const body = await parseBody(req);
      const context = await getContext();
      const caseRecord = findCase(context.cases, body.caseId);
      return sendJson(res, 200, { title: `Grounds of Decision - ${caseRecord.reference}`, content: generateGrounds(caseRecord, context.policies) });
    }

    if (req.method === "POST" && url.pathname === "/api/generate-decision/stream") {
      const body = await parseBody(req);
      const context = await getContext();
      const caseRecord = findCase(context.cases, body.caseId);
      const fallback = generateGrounds(caseRecord, context.policies);
      const status = await getOpenAiStatus();

      sendSseHeaders(res);
      sendSse(res, "start", {
        title: `Grounds of Decision - ${caseRecord.reference}`,
        model: status.configured ? status.model : "local fallback"
      });

      if (!status.configured) {
        sendSse(res, "delta", { text: fallback });
        sendSse(res, "notice", { text: "No OpenAI API key is configured, so the local template was used." });
        sendSse(res, "done", {});
        res.end();
        return;
      }

      try {
        let draft = "";
        const result = await openAiGroundsStream(caseRecord, context, (text) => {
          draft += text;
        });
        await writeTextAsSseDeltas(res, normalizeGroundsNumbering(draft));
        sendSse(res, "done", { model: result.model });
        res.end();
        return;
      } catch (error) {
        const cause = error.cause ? ` (${error.cause.code || error.cause.message || "unknown cause"})` : "";
        sendSse(res, "notice", { text: `LLM draft failed, so the local template was used: ${error.message}${cause}` });
        sendSse(res, "delta", { text: fallback });
        sendSse(res, "done", {});
        res.end();
        return;
      }
    }

    if (req.method === "GET") return await serveStatic(req, res);

    res.writeHead(405);
    res.end("Method not allowed");
  } catch (error) {
    if (error.code === "ENOENT") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(error.stack || error.message);
  }
});

server.on("error", (error) => {
  console.error("[serverError]", error.stack || error.message);
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Stop the existing process or set PORT to another value.`);
    process.exitCode = 1;
  }
});

server.listen(port, () => {
  console.log(`Salesforce AI Assistant running at http://localhost:${port}`);
});
