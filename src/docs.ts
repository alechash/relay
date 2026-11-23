import { z } from "zod";
import { operations } from "./ops";
import { jsonSchema, pathParams } from "./ops/run";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function typeLabel(s: any): string {
  if (!s) return "any";
  if (s.enum) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  if (s.anyOf) return s.anyOf.map(typeLabel).join(" | ");
  if (s.type === "array") return `${typeLabel(s.items)}[]`;
  return Array.isArray(s.type) ? s.type.join(" | ") : (s.type ?? "any");
}

/** Human-readable API reference generated from the operation registry. */
export function renderDocs(origin: string): string {
  const tags = [...new Set(operations.map((o) => o.tag))];
  const toc = tags.map((t) => `<a href="#${t.toLowerCase().replace(/\W+/g, "-")}">${esc(t)}</a>`).join("");
  const sections = tags
    .map((tag) => {
      const ops = operations.filter((o) => o.tag === tag);
      return `<section id="${tag.toLowerCase().replace(/\W+/g, "-")}"><h2>${esc(tag)}</h2>${ops
        .map((op) => {
          const shape = op.input.shape as Record<string, z.ZodType>;
          const pp = pathParams(op.path);
          const rows = Object.keys(shape)
            .map((k) => {
              const s = jsonSchema(shape[k]) as any;
              const req = !shape[k].safeParse(undefined).success;
              const where = pp.includes(k) ? "path" : op.method === "GET" || op.method === "DELETE" ? "query" : "body";
              return `<tr><td><code>${esc(k)}</code>${req ? ' <span class="req">required</span>' : ""}</td><td class="muted">${where}</td><td><code class="type">${esc(typeLabel(s))}</code></td><td>${esc(s.description ?? "")}</td></tr>`;
            })
            .join("");
          const access = op.access === "human" ? '<span class="pill pill-human">humans only</span>' : op.access === "write" ? '<span class="pill">write</span>' : '<span class="pill pill-read">read</span>';
          return `<article class="op" id="op-${op.name}">
            <header><span class="method m-${op.method.toLowerCase()}">${op.method}</span><code class="path">/api/v1${esc(op.path)}</code>${access}</header>
            <h3>${esc(op.summary)}</h3>
            ${op.description ? `<p>${esc(op.description)}</p>` : ""}
            <p class="muted small">MCP tool <code>${op.name}</code></p>
            ${rows ? `<div class="table-wrap"><table><thead><tr><th>Field</th><th>In</th><th>Type</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
          </article>`;
        })
        .join("")}</section>`;
    })
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay API</title><link rel="stylesheet" href="/app.css"><link rel="icon" href="/favicon.svg"></head>
<body class="docs"><main class="docs-main">
<p><a href="/">← Back to Relay</a></p>
<h1>Relay API</h1>
<p class="lede">Everything the web UI does goes through this API, and every operation is also an MCP tool with the same name and input. Machine-readable spec: <a href="/api/v1/openapi.json"><code>/api/v1/openapi.json</code></a>.</p>

<h2>Authentication</h2>
<p>Send <code>Authorization: Bearer &lt;token&gt;</code>. Use your <code>ADMIN_TOKEN</code>, or create scoped tokens under <a href="/settings">Settings → Tokens</a> (or <code>POST /api/v1/tokens</code>).</p>
<ul>
<li><strong>agent</strong> tokens: each change is applied right away and also queued for your sign-off. You can approve it, or reject it, which reverts it.</li>
<li><strong>human</strong> tokens: for your own scripts and apps. No sign-off needed, and they can review.</li>
<li>Optional headers: <code>X-Relay-Session</code> groups related changes into one review batch, and <code>X-Relay-Client</code> names the client in the history.</li>
</ul>
<pre><code>curl -H "Authorization: Bearer $RELAY_TOKEN" ${esc(origin)}/api/v1/boards

curl -X POST -H "Authorization: Bearer $RELAY_TOKEN" -H "Content-Type: application/json" \\
  -d '{"title":"Renew passport","column":"To do","board_id":"brd_…","reason":"From my inbox"}' \\
  ${esc(origin)}/api/v1/cards</code></pre>

<h2>MCP</h2>
<p>Streamable HTTP endpoint: <code>${esc(origin)}/mcp</code>, using the same bearer token. Each MCP connection is grouped as its own session in the sign-off queue.</p>
<pre><code>claude mcp add --transport http relay ${esc(origin)}/mcp \\
  --header "Authorization: Bearer rly_…"</code></pre>

<h2>Conventions</h2>
<ul>
<li>Cards accept an id (<code>crd_…</code>), a number (<code>42</code>) or a ref (<code>#42</code>) wherever <code>card_id</code> appears.</li>
<li>Positions are 0-based indexes. Leave one out to append to the end.</li>
<li>Nothing is hard-deleted. Archive with <code>archived: true</code>, restore with <code>archived: false</code>.</li>
<li>Pass <code>expected_version</code> for optimistic concurrency. If someone else changed the item first, you get a 409.</li>
<li>Errors look like <code>{"error":{"code","message","details"}}</code>.</li>
</ul>

<nav class="docs-toc">${toc}</nav>
${sections}
</main></body></html>`;
}
