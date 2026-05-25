// Vercel Edge function: proxies a streaming Claude Opus 4.7 call with extended
// thinking, so the browser receives the SSE stream directly (including thinking
// blocks). The Anthropic API key never leaves the server.

export const config = { runtime: "edge" };

const MODEL = "claude-opus-4-7";

function describeBoard(board) {
  // Render as a text grid for the model. Row 0 is the top.
  const sym = (v) => (v === 0 ? "." : v === 1 ? "H" : "C");
  const colHeader = "   " + [...Array(board[0].length).keys()].map(i => `c${i}`).join(" ");
  const rows = board.map((row, r) => `r${r}  ` + row.map(sym).join("  "));
  return [colHeader, ...rows].join("\n");
}

const GRAVITY_NAMES = ["down", "left", "up", "right"];
const DROP_EDGES = { down: "top", left: "right", up: "bottom", right: "left" };

function systemPromptForVariant(variant, opts = {}) {
  const base = `You are playing Connect 4 against a human. The board is 6 rows by 7 columns.
The board is shown as a text grid where H = human piece, C = your piece, . = empty.
Row 0 is the TOP row. Column 0 is the LEFT column.

You are playing as C. You must win or block the human. Think carefully about
threats, forks, tempo, and the geometry of this specific variant. Reason about
candidate moves and only commit when you are confident.

At the END of your response, output your move as a single JSON code block. Do
not output any other JSON. Format:

\`\`\`json
{ "move": <move object> }
\`\`\`
`;

  if (variant === "classic") {
    return base + `
RULES — CLASSIC CONNECT 4:
- On your turn, drop a piece into any column whose top cell (row 0) is empty.
- The piece falls to the lowest empty cell in that column.
- Win by making 4 in a row horizontally, vertically, or diagonally.
- Move format: { "column": <0..6> }
`;
  }

  if (variant === "diagonal") {
    return base + `
RULES — DIAGONAL GRAVITY:
- On your turn, place a piece on EITHER the top edge of a column OR the left edge of a row.
- Gravity pulls along the (+row, +col) diagonal: a placed piece slides
  down-and-to-the-right until the next cell is out of the board OR occupied.
- A move is legal only if the chosen entry cell (top of column, or left of row) is empty.
- Win by making 4 in a row horizontally, vertically, or diagonally.
- Move format: { "edge": "top", "index": <column 0..6> }  OR  { "edge": "left", "index": <row 0..5> }
- Geometry note: pieces dropped near the top-right or bottom-left corners may
  not slide much; pieces dropped near the top-left slide farthest.
`;
  }

  if (variant === "flip") {
    const g = GRAVITY_NAMES[opts.gravityIdx || 0];
    const dropEdge = DROP_EDGES[g];
    const movesUntilFlip = opts.flipN - ((opts.moveCount || 0) % opts.flipN);
    return base + `
RULES — GRAVITY FLIP:
- Gravity has a direction that rotates clockwise (down → left → up → right → down)
  every ${opts.flipN} moves total (across both players).
- Current gravity: ${g.toUpperCase()}. Drop edge: ${dropEdge}. Gravity flips in ${movesUntilFlip} move(s).
- On your turn, place a piece on a cell of the drop edge that is currently empty.
  The piece then slides as far as possible along the current gravity direction
  (stopping at the wall or another piece).
- AFTER EVERY MOVE, every piece on the board re-settles along the current gravity.
- When gravity flips, every piece re-settles along the new direction. This can
  create or destroy threats — plan accordingly.
- Win by making 4 in a row horizontally, vertically, or diagonally at any point.
- Move format depending on current drop edge:
  - drop edge "top":    { "edge": "top",    "index": <col 0..6> }
  - drop edge "bottom": { "edge": "bottom", "index": <col 0..6> }
  - drop edge "left":   { "edge": "left",   "index": <row 0..5> }
  - drop edge "right":  { "edge": "right",  "index": <row 0..5> }
`;
  }

  // custom — handled separately
  return base;
}

function userMessageForVariant(variant, body) {
  const { board, history, moveCount, gravityIdx, flipN } = body;
  const parts = [];
  parts.push("Current board:\n```\n" + describeBoard(board) + "\n```");
  parts.push(`Move count so far: ${moveCount}`);
  if (variant === "flip") {
    const g = GRAVITY_NAMES[gravityIdx || 0];
    parts.push(`Current gravity: ${g} (drop from ${DROP_EDGES[g]}). Flips every ${flipN} moves.`);
  }
  if (history && history.length) {
    parts.push("Move history (oldest first):");
    parts.push(history.map((h, i) => `  ${i + 1}. ${h.player === 1 ? "Human" : "Claude"}: ${JSON.stringify(h.move)}`).join("\n"));
  } else {
    parts.push("No moves yet.");
  }
  parts.push("It is YOUR turn. Reason about the best move, then output it as the JSON block described.");
  return parts.join("\n\n");
}

function customSystemPrompt(customRules) {
  return `You are both the RULES ENGINE and the OPPONENT for a custom board game played on a 6-row by 7-column grid.

Rules supplied by the user:
"""
${customRules || "(no rules provided — assume standard Connect 4)"}
"""

The board is represented as a 2D array of integers: 0 = empty, 1 = human (H), 2 = you (C). Row 0 is the TOP, column 0 is the LEFT.

On each turn:
1. The user proposes a move (specifying a cell, or whatever the rules require).
2. You validate it under the rules. If illegal, report illegal=true and DO NOT change the board.
3. If legal, apply it.
4. Check for human win / draw.
5. If game continues, choose YOUR best move and apply it.
6. Check for your win / draw.
7. Return the resulting board.

At the END of your response, output exactly one JSON code block, no other JSON:

\`\`\`json
{
  "illegal": false,
  "newBoard": [[...7 ints...], ...6 rows...],
  "claudeMove": <object describing your move, or null>,
  "gameStatus": "continue" | "human_wins" | "claude_wins" | "draw",
  "message": "<short note for the human>"
}
\`\`\`

Reason carefully and show your reasoning in the thinking block before committing.`;
}

function customUserMessage(body) {
  const { board, history, humanMove } = body;
  return [
    "Current board (BEFORE human's proposed move):",
    "```\n" + describeBoard(board) + "\n```",
    "Human's proposed move: " + JSON.stringify(humanMove),
    history && history.length
      ? "History so far:\n" + history.map((h, i) => `  ${i + 1}. ${h.player === 1 ? "Human" : "Claude"}: ${JSON.stringify(h.move)}`).join("\n")
      : "No moves yet.",
    "Validate the human's move under the rules, then make YOUR move if the game continues. Return the JSON block described.",
  ].join("\n\n");
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const envNames = Object.keys(process.env || {});
    // Filter to anything that looks like a user-added var (not Vercel/system defaults).
    const systemPrefixes = /^(VERCEL|AWS|NODE|NEXT|PATH|HOME|HOSTNAME|PWD|SHLVL|_|TZ|LANG|LC_|TERM|EDGE_RUNTIME)/;
    const userVars = envNames.filter(n => !systemPrefixes.test(n));
    const apiLike = envNames.filter(n => /api|key|token|secret|claude|opus|anthrop/i.test(n));
    return new Response(JSON.stringify({
      error: "ANTHROPIC_API_KEY not set on server",
      debug: {
        total_env_vars_visible: envNames.length,
        non_system_var_names: userVars,
        names_matching_api_or_key_or_token: apiLike,
        hint: "Compare these names to what you typed in Vercel. The var must be exactly 'ANTHROPIC_API_KEY' (no spaces, all caps), applied to Production, and a fresh deploy must have been triggered AFTER adding it.",
      },
    }), { status: 500, headers: { "content-type": "application/json" } });
  }
  let body;
  try { body = await req.json(); }
  catch { return new Response("Bad JSON", { status: 400 }); }

  const variant = body.variant || "classic";
  const budget = Math.max(1024, Math.min(20000, parseInt(body.budget, 10) || 6000));

  let system, userMsg;
  if (variant === "custom") {
    system = customSystemPrompt(body.customRules);
    userMsg = customUserMessage(body);
  } else {
    system = systemPromptForVariant(variant, {
      gravityIdx: body.gravityIdx,
      flipN: body.flipN,
      moveCount: body.moveCount,
    });
    userMsg = userMessageForVariant(variant, body);
  }

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: Math.max(budget + 2000, 4096),
      stream: true,
      thinking: { type: "enabled", budget_tokens: budget },
      system,
      messages: [{ role: "user", content: userMsg }],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    return new Response(JSON.stringify({ error: `Anthropic API error ${upstream.status}: ${text}` }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }

  // Proxy the SSE stream straight through.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
