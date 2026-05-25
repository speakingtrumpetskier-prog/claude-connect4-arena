// Vercel Edge function: proxies a streaming Claude Opus 4.7 call with extended
// thinking, so the browser receives the SSE stream directly (including thinking
// blocks). The Anthropic API key never leaves the server.

export const config = { runtime: "edge" };

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 10000;       // real hard cap on thinking + response combined
const STATED_BUDGET = 2000;     // budget shown to Claude as its normal target
const PANIC_THRESHOLD = 6000;   // self-checkpoint: if Claude is still thinking past this, commit immediately

function describeBoard(board) {
  // Chess-style render: columns A..(A+W-1) left → right, rows 1..H BOTTOM → TOP.
  // Decorated cells render with their glyph (single char), else . / H / C.
  const sym = (v) => {
    if (v === 0 || v == null) return ".";
    if (v === 1) return "H";
    if (v === 2) return "C";
    if (typeof v === "object" && v.glyph) return String(v.glyph).slice(0, 1);
    return "?";
  };
  const totalRows = board.length;
  const totalCols = board[0].length;
  const letters = Array.from({ length: totalCols }, (_, i) => String.fromCharCode(65 + i));
  const colHeader = "    " + letters.map(l => ` ${l} `).join("");
  const rows = board.map((row, r) => {
    const displayRow = totalRows - r;  // r=0 (top) → chess row N, r=N-1 (bottom) → chess row 1
    const label = String(displayRow).padStart(2, " ");
    return `${label}  ` + row.map(v => ` ${sym(v)} `).join("");
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

OUTPUT BUDGET (tiered — self-pace using these thresholds):
- TARGET: ${STATED_BUDGET} tokens combined (thinking + response). This is the normal ceiling — aim to finish well under it. A few candidates, brief evaluation, commit.
- PANIC at ${PANIC_THRESHOLD} tokens: if you find yourself still thinking past this point, STOP exploring and emit the JSON block IMMEDIATELY with your best current candidate. Do not refine further. A merely-good move now beats a brilliant move that never arrives.
- HARD CAP at ${MAX_TOKENS} tokens: absolute ceiling. If you blow this, no JSON is emitted and a RANDOM move auto-plays.
Always reserve ~100 tokens for the JSON block. The penalty for thinking too long is far worse than for thinking a little too briefly.

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
  return `You are both the RULES ENGINE and the OPPONENT for a custom board game. You have full control over the game state — board size, piece types, abilities, win conditions, everything.

Rules supplied by the user:
"""
${customRules || "(no rules provided — assume standard Connect 4)"}
"""

DEFAULTS (apply silently UNLESS the user's rules override them — do not surface these as if they were special rules):
- Board: 6 rows × 7 columns.
- Gravity: STANDARD CONNECT 4. Pieces ALWAYS fall to the bottom of their column. The user CANNOT place a piece mid-column. A click on any cell — say "E5" — means "drop a piece into column E," NOT "place a piece at E5". You must scan column E from the bottom up (chess row 1, then 2, then 3, ...) and put the piece in the FIRST EMPTY CELL. If column E already has 3 pieces stacked from the bottom, the new piece lands at chess row 4 — NOT row 5. The user's clicked row is irrelevant under default gravity; only their clicked column matters.
- Win condition: 4 in a row (horizontal, vertical, or diagonal).
- Pieces: plain integers 1 (human) and 2 (Claude).

Only deviate from these defaults when the user's rules explicitly call for something different. If the rules add new piece types, abilities, board sizes, win conditions, gravity directions, etc., follow those.

NOTATION — chess-style:
- Columns labeled A, B, C, ... up to whatever column count your board has (max Z = 26 cols).
- Rows labeled 1..N, BOTTOM to TOP. Row 1 is always the bottom row.
- Cells: "<col><row>", e.g., "A1" bottom-left, "D3" 4th column / 3rd row up.
- Always use this notation in reasoning. Never write tuples like "(5,3)".

INTERNAL ARRAY ↔ CHESS LABEL — get this right or your moves will appear in the wrong rows:
- The newBoard array's row 0 is the TOP row of the displayed board. For an N-row board, array row 0 = chess row N, array row N-1 = chess row 1.
- Array col 0 is the LEFTMOST column = chess col A.
- Conversion: chess "<col><row>" ↔ array (N - row, col_index_from_A).
- Worked examples for an 8-row board (N=8):
  - chess A1 (bottom-left)  = array (7, 0)
  - chess H8 (top-right)    = array (0, 7)
  - chess E5                = array (8 - 5, 4) = array (3, 4)
  - chess E4                = array (8 - 4, 4) = array (4, 4)   ← different cell from E5
- Sanity-check: before reporting a cell name, compute it back from array coords using N - r. If your prose says "piece at E5" but you wrote it at array (4, 4), you mean E4. Do not mix them up.

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

3. **Move semantics.** Human input arrives in one of three shapes:
   - { "edge": "top", "column": "D" } — they clicked a TOP DROP arrow (default UI). Interpret as a Connect-4-style column drop UNLESS your rules say otherwise.
   - { "cell": "D3" } — they clicked a specific cell (only available if you switched UI to cell-mode).
   - { "text": "use exploding tile at C2" } — they typed in the action bar.
   You interpret and validate under YOUR rules. If illegal, set illegal=true with an explanation in message.

4. **UI input mode.** You control how the human can input moves via the `inputMode` field in your response:
   - "drops" (DEFAULT) — top drop arrows are clickable, cells are NOT. Standard Connect-4 feel. Use this unless your rules need something different.
   - "cells" — top arrows hidden, cells clickable. Use when placement is mid-board, free-positioning, etc.
   - "both" — both work. Useful when some moves are drops and others are special placements.
   If you omit inputMode, the previous value persists (default starts as "drops"). The text-input action bar is ALWAYS available regardless of mode.

5. **Persistent UI state.** Use gameInfo to surface anything that doesn't fit on the board — counters, resources, ability status, win conditions, current phase, etc. Examples:
   - "<strong>You:</strong> 2 bombs · 1 shield<br><strong>Claude:</strong> 1 bomb · 2 shields"
   - "<strong>Phase:</strong> Placement (3 moves left), then Combat begins"
   - "<strong>Score:</strong> You 14 · Claude 11. First to 25 wins."
   Plain text or simple inline HTML (<strong>, <em>, <code>, <br>, <span>). Omit if not needed.

6. **The game flow.** When you respond, in order:
   - Validate the user's move under the rules.
   - If legal, apply it.
   - Check for human-win / draw / continue.
   - If game continues, choose YOUR best move and apply it.
   - Check for your win / draw.
   - Return the resulting board, your move, status, message, gameInfo.

OUTPUT BUDGET (tiered — self-pace using these thresholds):
- TARGET: ${STATED_BUDGET} tokens (thinking + response). Aim to finish well under this.
- PANIC at ${PANIC_THRESHOLD} tokens: if you're still thinking past this, STOP and emit the JSON block IMMEDIATELY with your best current candidate.
- HARD CAP at ${MAX_TOKENS} tokens: absolute ceiling; blowing it means the move/turn fails.
Always reserve ~150 tokens for the JSON block (more if the board is large or has decorated cells). Don't deliberate exhaustively — commit on a reasonable line.

RESPONSE — at the END of your response, output exactly one JSON code block:

\`\`\`json
{
  "illegal": false,
  "newBoard": [[...row 0...], ...rest of rows...],
  "claudeMove": <string or object describing your move, or null>,
  "gameStatus": "continue" | "human_wins" | "claude_wins" | "draw",
  "message": "<short status-bar note for the human>",
  "gameInfo": "<OPTIONAL HTML panel above the board — omit if not needed>",
  "inputMode": "drops" | "cells" | "both"   // OPTIONAL — omit to keep current; default is "drops"
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
  const effort = VALID_EFFORTS.includes(body.effort) ? body.effort : "low";

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
      max_tokens: MAX_TOKENS,
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
