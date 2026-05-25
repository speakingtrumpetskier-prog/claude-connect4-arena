// Vercel Edge function: proxies a streaming Claude Opus 4.7 call with extended
// thinking, so the browser receives the SSE stream directly (including thinking
// blocks). The Anthropic API key never leaves the server.

export const config = { runtime: "edge" };

const MODEL = "claude-opus-4-7";

function describeBoard(board) {
  // Chess-style render: columns A..G (left to right), rows 1..6 (BOTTOM to TOP).
  const sym = (v) => (v === 0 ? "." : v === 1 ? "H" : "C");
  const totalRows = board.length;
  const letters = ["A","B","C","D","E","F","G"].slice(0, board[0].length);
  const colHeader = "    " + letters.map(l => ` ${l} `).join("");
  const rows = board.map((row, r) => {
    const displayRow = totalRows - r;  // r=0 (top) → "6", r=5 (bottom) → "1"
    return `${displayRow}   ` + row.map(v => ` ${sym(v)} `).join("");
  });
  return [colHeader, ...rows].join("\n");
}

const GRAVITY_NAMES = ["down", "left", "up", "right"];
const DROP_EDGES = { down: "top", left: "right", up: "bottom", right: "left" };

function systemPromptForVariant(variant, opts = {}) {
  const base = `You are playing Connect 4 against a human. The board is 6 rows by 7 columns.

NOTATION — chess-style, matching the user's board UI:
- Columns labeled A..G, left to right.
- Rows labeled 1..6, BOTTOM to TOP. Row 1 is the bottom row; row 6 is the top row.
- Cells are written as "<col><row>" — e.g., "A1" is the bottom-left, "G6" is the top-right, "D3" is the 4th column from the left, 3rd row from the bottom.

In your reasoning, ALWAYS use this notation. Never write "(5,3)" or "(row, col)" tuples — they're ambiguous (row-col vs x-y).
When mentioning multiple cells (e.g., a diagonal threat), list them like "A4 → B3 → C2 → D1".

The board is shown as a text grid with H = human piece, C = your piece, . = empty.

You are playing as C. You must win or block the human. Think carefully about
threats, forks, tempo, and the geometry of this specific variant. Reason about
candidate moves and only commit when you are confident.

At the END of your response, output your move as a single JSON code block. No
other JSON. The move object uses chess labels (see the per-variant format below).

\`\`\`json
{ "move": <move object> }
\`\`\`
`;

  if (variant === "classic") {
    return base + `
RULES — CLASSIC CONNECT 4:
- On your turn, drop a piece into any column whose top cell (row 6) is empty.
- The piece falls to the lowest empty cell in that column.
- Win by making 4 in a row horizontally, vertically, or diagonally.
- Move format: { "column": "<A|B|C|D|E|F|G>" }   — e.g., { "column": "D" }
`;
  }

  if (variant === "diagonal") {
    return base + `
RULES — DIAGONAL GRAVITY:
- On your turn, place a piece on EITHER the top edge of a column OR the left edge of a row.
- Gravity pulls along the down-right diagonal in (col,row-from-bottom) terms — i.e., each step moves DOWN one row and RIGHT one column visually. A placed piece slides until the next cell is off the board OR occupied.
- A move is legal only if the chosen entry cell (top of column, or left of row) is empty.
- Win by making 4 in a row horizontally, vertically, or diagonally.
- Move format:
    { "edge": "top",  "column": "<A..G>" }   — e.g., { "edge": "top",  "column": "C" }
  OR
    { "edge": "left", "row": <1..6> }         — e.g., { "edge": "left", "row": 4 }
- Geometry note: pieces dropped near the top-right or bottom-left corners may
  not slide much; pieces dropped near the top-left slide farthest.
`;
  }

  if (variant === "flip") {
    const g = GRAVITY_NAMES[opts.gravityIdx || 0];
    const dropEdge = DROP_EDGES[g];
    const movesUntilFlip = opts.flipN - ((opts.moveCount || 0) % opts.flipN);
    return base + `
RULES — GRAVITY ROTATE:
- Gravity has a direction that rotates clockwise (down → left → up → right → down)
  every ${opts.flipN} moves total (across both players).
- Current gravity: ${g.toUpperCase()}. Drop edge: ${dropEdge}. Gravity rotates in ${movesUntilFlip} move(s).
- On your turn, place a piece on a cell of the drop edge that is currently empty.
  The piece then slides as far as possible along the current gravity direction
  (stopping at the wall or another piece).
- AFTER EVERY MOVE, every piece on the board re-settles along the current gravity.
- When gravity flips, every piece re-settles along the new direction. This can
  create or destroy threats — plan accordingly.
- Win by making 4 in a row horizontally, vertically, or diagonally at any point.
- Move format depending on current drop edge:
  - drop edge "top":    { "edge": "top",    "column": "<A..G>" }
  - drop edge "bottom": { "edge": "bottom", "column": "<A..G>" }
  - drop edge "left":   { "edge": "left",   "row": <1..6> }
  - drop edge "right":  { "edge": "right",  "row": <1..6> }
`;
  }

  // custom — handled separately
  return base;
}

function timeControlBlock(body) {
  if (typeof body.timeClaudeMs !== "number") return null;
  const perMove = Math.round((body.timePerPlayerMs || 60000) / 1000);
  const yourSec = Math.max(0, Math.round(body.timeClaudeMs / 1000));
  return [
    `Time control: ${perMove} seconds per move (the clock resets at the start of each turn).`,
    `Your remaining time for THIS move: ${yourSec}s.`,
    `IMPORTANT: if you exceed the budget, the system auto-plays a RANDOM LEGAL move on your behalf — almost certainly worse than what you would choose. Keep analysis tight; commit when you have a strong candidate rather than exhausting depth.`,
    yourSec < 20
      ? "Your clock is LOW for this move — prefer a fast, solid move over deep analysis."
      : "Use whatever depth the position warrants — you have time, but stay under budget.",
  ].join("\n");
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
  const tc = timeControlBlock(body);
  if (tc) parts.push(tc);
  parts.push("It is YOUR turn. Reason about the best move, then output it as the JSON block described.");
  return parts.join("\n\n");
}

function customSystemPrompt(customRules) {
  return `You are both the RULES ENGINE and the OPPONENT for a custom board game. You have full control over the game state — board size, piece types, abilities, win conditions, everything.

Rules supplied by the user:
"""
${customRules || "(no rules provided — assume standard Connect 4)"}
"""

DEFAULTS (apply silently UNLESS the user's rules override them — do not surface these as if they were special rules):
- Board: 6 rows × 7 columns.
- Gravity: standard Connect 4. When the user "plays" a column, the piece falls to the lowest empty cell in that column. A click on any cell of an empty column is treated as a drop into that column. Pieces do not stack mid-column — they always settle at the bottom of the column's empty space.
- Win condition: 4 in a row (horizontal, vertical, or diagonal).
- Pieces: plain integers 1 (human) and 2 (Claude).

Only deviate from these defaults when the user's rules explicitly call for something different. If the rules add new piece types, abilities, board sizes, win conditions, gravity directions, etc., follow those.

NOTATION — chess-style:
- Columns labeled A, B, C, ... up to whatever column count your board has (max Z = 26 cols).
- Rows labeled 1..N, BOTTOM to TOP. Row 1 is always the bottom row.
- Cells: "<col><row>", e.g., "A1" bottom-left, "D3" 4th column / 3rd row up.
- Always use this notation in reasoning. Never write tuples like "(5,3)".

YOU CONTROL THE GAME — you decide:

1. **Board shape and size.** The first request gives you a default 6×7 scaffold so the user has something to click. You can change the board on YOUR FIRST RESPONSE (and any time after) by returning a newBoard of any rectangular size from 2×2 up to 20 rows × 26 cols. If the user's rules specify a size (e.g., "8×8 board"), use that. The UI re-renders to match.

2. **Piece types and visuals.** Each cell of newBoard can be:
   - 0 = empty
   - 1 = plain human piece (red disc)
   - 2 = plain Claude piece (yellow disc)
   - Object: { "owner": 1|2, "glyph": "<char or emoji>", "color"?: "<css color>", "title"?: "<tooltip>" }
     Use the object form for special tiles. Examples:
     - Exploding bomb: { owner: 1, glyph: "💣", title: "Bomb (uses left: 1)" }
     - Frozen piece: { owner: 2, glyph: "❄", color: "#9ec5e8", title: "Frozen for 2 turns" }
     - Scoring crown: { owner: 1, glyph: "♛", title: "King — 3 points if defended" }
     - Mine: { owner: 0, glyph: "✦", color: "#444", title: "Mine — triggers if stepped on" } (owner 0 = neutral/board-owned)
   - The glyph appears centered in the cell. color overrides the cell background (use sparingly — only when the meaning needs to be visually distinct from a plain piece).

3. **Move semantics.** Human submits free-form text moves — examples:
   - { "cell": "D3" } when they just click a cell
   - { "text": "use exploding tile at C2" } when they type
   You interpret and validate under YOUR rules. If illegal, set illegal=true with an explanation in message.

4. **Persistent UI state.** Use gameInfo to surface anything that doesn't fit on the board — counters, resources, ability status, win conditions, current phase, etc. Examples:
   - "<strong>You:</strong> 2 bombs · 1 shield<br><strong>Claude:</strong> 1 bomb · 2 shields"
   - "<strong>Phase:</strong> Placement (3 moves left), then Combat begins"
   - "<strong>Score:</strong> You 14 · Claude 11. First to 25 wins."
   Plain text or simple inline HTML (<strong>, <em>, <code>, <br>, <span>). Omit if not needed.

5. **The game flow.** When you respond, in order:
   - Validate the user's move under the rules.
   - If legal, apply it.
   - Check for human-win / draw / continue.
   - If game continues, choose YOUR best move and apply it.
   - Check for your win / draw.
   - Return the resulting board, your move, status, message, gameInfo.

RESPONSE — at the END of your response, output exactly one JSON code block:

\`\`\`json
{
  "illegal": false,
  "newBoard": [[...row 0...], ...rest of rows...],
  "claudeMove": <string or object describing your move, or null>,
  "gameStatus": "continue" | "human_wins" | "claude_wins" | "draw",
  "message": "<short status-bar note for the human>",
  "gameInfo": "<OPTIONAL HTML panel above the board — omit if not needed>"
}
\`\`\`

Reason carefully in the thinking block before committing. If the user's rules are ambiguous, make a reasonable interpretation and explain it in message or gameInfo so they know what you assumed.`;
}

function customInitMessage(body) {
  return [
    "INITIALIZATION — the user just defined the rules above and clicked Setup. There are no moves yet.",
    "Return the starting state of the game:",
    "- newBoard: the initial board (right size, right starting pieces).",
    "- claudeMove: null.",
    "- gameStatus: \"continue\".",
    "- message: a short one-line note telling the human how to play their first move (e.g., \"Click any column to drop a piece.\" or \"Type 'use exploding tile at <cell>' to deploy a bomb.\").",
    "- gameInfo: any persistent state the player needs to see from the start (resource counts, current phase, etc.). Omit if not needed.",
    "If the rules don't override the defaults, return an empty 6x7 board with no gameInfo.",
  ].join("\n\n");
}

function customUserMessage(body) {
  const { board, history, humanMove } = body;
  const parts = [
    "Current board (BEFORE human's proposed move):",
    "```\n" + describeBoard(board) + "\n```",
    "Human's proposed move: " + JSON.stringify(humanMove),
    history && history.length
      ? "History so far:\n" + history.map((h, i) => `  ${i + 1}. ${h.player === 1 ? "Human" : "Claude"}: ${JSON.stringify(h.move)}`).join("\n")
      : "No moves yet.",
  ];
  const tc = timeControlBlock(body);
  if (tc) parts.push(tc);
  parts.push("Validate the human's move under the rules, then make YOUR move if the game continues. Return the JSON block described.");
  return parts.join("\n\n");
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
  const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  const requestedEffort = VALID_EFFORTS.includes(body.effort) ? body.effort : "medium";

  // Auto-downshift effort when Claude's clock is low, so a single API call can't
  // blow the remaining time. Without this cap, a high/max-effort call on a low
  // clock would deterministically time Claude out.
  const tcMs = typeof body.timeClaudeMs === "number" ? body.timeClaudeMs : null;
  const thMs = typeof body.timeHumanMs === "number" ? body.timeHumanMs : null;
  let effort = requestedEffort;
  let effortNote = null;
  if (tcMs !== null) {
    const cap = tcMs < 10000 ? "low"
              : tcMs < 20000 ? "medium"
              : tcMs < 40000 ? "high"
              : null;
    if (cap && VALID_EFFORTS.indexOf(cap) < VALID_EFFORTS.indexOf(requestedEffort)) {
      effort = cap;
      effortNote = `auto-capped from "${requestedEffort}" to "${cap}" due to low clock`;
    }
  }

  let system, userMsg;
  if (variant === "custom") {
    system = customSystemPrompt(body.customRules);
    userMsg = body.init ? customInitMessage(body) : customUserMessage(body);
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
      max_tokens: 6000,
      stream: true,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort },
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
