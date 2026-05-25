// Connect 4 Arena — client-side game engine + Claude streaming UI.
//
// Players: 1 = human (red), 2 = claude (yellow). 0 = empty.
// Board is rows x cols, stored as board[row][col]. Row 0 is the top.

const ROWS = 6;
const COLS = 7;

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const boardEl = $("#board");
const statusEl = $("#status");
const thinkingEl = $("#thinking");
const logEl = $("#log");
const variantSel = $("#variant");
const flipNWrap = $("#flip-n-wrap");
const flipNInput = $("#flip-n");
const budgetInput = $("#budget");
const budgetVal = $("#budget-val");
const firstSel = $("#first");
const newGameBtn = $("#new-game");
const customWrap = $("#custom-rules-wrap");
const customRulesEl = $("#custom-rules");
const gravityIndicator = $("#gravity-indicator");
const streamingIndicator = $("#streaming-indicator");
const variantNameEl = $("#variant-name");

const VARIANT_NAMES = {
  classic: "Classic Connect 4",
  diagonal: "Diagonal Gravity · drop top or left",
  flip: "Gravity Flip",
  custom: "Custom Rules",
};

const COL_LABELS = ["a", "b", "c", "d", "e", "f", "g"];
function coordLabel(r, c) {
  // Chess-style: column letter + (ROWS - row) so bottom row is "1".
  return `${COL_LABELS[c]}${ROWS - r}`;
}

// ---------- State ----------
let state = null;

function emptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

function newGame() {
  const variant = variantSel.value;
  state = {
    variant,
    board: emptyBoard(),
    turn: firstSel.value === "human" ? 1 : 2,
    moveCount: 0,
    gameOver: false,
    winner: null,
    winningCells: [],
    history: [],
    flipN: parseInt(flipNInput.value, 10) || 3,
    gravityIdx: 0, // 0=down,1=left,2=up,3=right
    customRules: customRulesEl.value.trim(),
    pendingClaude: false,
  };
  thinkingEl.textContent = "Make a move. Claude's reasoning will stream here, line by line, as it considers candidate moves and their consequences.";
  thinkingEl.classList.add("empty");
  logEl.innerHTML = "";
  variantNameEl.textContent = VARIANT_NAMES[state.variant] || state.variant;
  render();
  setStatus(state.turn === 1 ? "Your move." : "Claude moves first…");
  if (state.turn === 2) requestClaudeMove();
}

// ---------- Gravity vectors ----------
const GRAVITY_VECTORS = [
  { name: "down",  dr:  1, dc:  0, dropEdge: "top" },
  { name: "left",  dr:  0, dc: -1, dropEdge: "right" },
  { name: "up",    dr: -1, dc:  0, dropEdge: "bottom" },
  { name: "right", dr:  0, dc:  1, dropEdge: "left" },
];

// ---------- Variant: classic ----------
// Drop into column c. Piece falls until it hits the bottom or another piece.
function classicLegalMoves(board) {
  const moves = [];
  for (let c = 0; c < COLS; c++) {
    if (board[0][c] === 0) moves.push({ column: c });
  }
  return moves;
}
function classicApply(board, move, player) {
  const c = move.column;
  for (let r = ROWS - 1; r >= 0; r--) {
    if (board[r][c] === 0) {
      board[r][c] = player;
      return { row: r, col: c };
    }
  }
  return null;
}

// ---------- Variant: diagonal ----------
// Drop from top of column c OR left of row r. Gravity (+1,+1).
// Piece slides along (+1,+1) until next cell is out of board or occupied.
function diagonalLegalMoves(board) {
  const moves = [];
  for (let c = 0; c < COLS; c++) {
    if (board[0][c] === 0) moves.push({ edge: "top", index: c });
  }
  for (let r = 0; r < ROWS; r++) {
    if (board[r][0] === 0) moves.push({ edge: "left", index: r });
  }
  return moves;
}
function diagonalApply(board, move, player) {
  let r, c;
  if (move.edge === "top") { r = 0; c = move.index; }
  else if (move.edge === "left") { r = move.index; c = 0; }
  else return null;
  if (board[r][c] !== 0) return null;
  // Slide (+1,+1) while next cell is in-bounds and empty.
  while (r + 1 < ROWS && c + 1 < COLS && board[r + 1][c + 1] === 0) {
    r++; c++;
  }
  board[r][c] = player;
  return { row: r, col: c };
}

// ---------- Variant: flip ----------
// Gravity rotates clockwise every flipN moves (down -> left -> up -> right -> down).
// Players drop pieces from the edge opposite the current gravity direction.
// After every move, all pieces re-settle along current gravity.
function flipLegalMoves(board, gravityIdx) {
  const g = GRAVITY_VECTORS[gravityIdx];
  const moves = [];
  if (g.dropEdge === "top") {
    for (let c = 0; c < COLS; c++) if (board[0][c] === 0) moves.push({ edge: "top", index: c });
  } else if (g.dropEdge === "bottom") {
    for (let c = 0; c < COLS; c++) if (board[ROWS - 1][c] === 0) moves.push({ edge: "bottom", index: c });
  } else if (g.dropEdge === "left") {
    for (let r = 0; r < ROWS; r++) if (board[r][0] === 0) moves.push({ edge: "left", index: r });
  } else if (g.dropEdge === "right") {
    for (let r = 0; r < ROWS; r++) if (board[r][COLS - 1] === 0) moves.push({ edge: "right", index: r });
  }
  return moves;
}
function settleAll(board, gravityIdx) {
  const g = GRAVITY_VECTORS[gravityIdx];
  // Move every piece as far as possible in (dr,dc). Process in order so leading
  // pieces settle first: iterate cells from the gravity-destination edge backward.
  // Simplest: repeat a pass until stable.
  let changed = true;
  while (changed) {
    changed = false;
    // Iterate cells starting from the edge that gravity pulls toward.
    const rs = g.dr > 0 ? [...Array(ROWS).keys()].reverse() :
               g.dr < 0 ? [...Array(ROWS).keys()] :
               [...Array(ROWS).keys()];
    const cs = g.dc > 0 ? [...Array(COLS).keys()].reverse() :
               g.dc < 0 ? [...Array(COLS).keys()] :
               [...Array(COLS).keys()];
    for (const r of rs) for (const c of cs) {
      if (board[r][c] === 0) continue;
      const nr = r + g.dr, nc = c + g.dc;
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
      if (board[nr][nc] !== 0) continue;
      board[nr][nc] = board[r][c];
      board[r][c] = 0;
      changed = true;
    }
  }
}
function flipApply(board, move, player, gravityIdx) {
  const g = GRAVITY_VECTORS[gravityIdx];
  let r, c;
  if (move.edge === "top") { r = 0; c = move.index; }
  else if (move.edge === "bottom") { r = ROWS - 1; c = move.index; }
  else if (move.edge === "left") { r = move.index; c = 0; }
  else if (move.edge === "right") { r = move.index; c = COLS - 1; }
  else return null;
  if (board[r][c] !== 0) return null;
  board[r][c] = player;
  // Slide along gravity until blocked.
  while (true) {
    const nr = r + g.dr, nc = c + g.dc;
    if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) break;
    if (board[nr][nc] !== 0) break;
    board[nr][nc] = board[r][c];
    board[r][c] = 0;
    r = nr; c = nc;
  }
  return { row: r, col: c };
}

// ---------- Win check ----------
const DIRS = [[0,1],[1,0],[1,1],[1,-1]];
function checkWin(board) {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = board[r][c];
      if (!v) continue;
      for (const [dr, dc] of DIRS) {
        const cells = [[r, c]];
        for (let k = 1; k < 4; k++) {
          const nr = r + dr*k, nc = c + dc*k;
          if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) break;
          if (board[nr][nc] !== v) break;
          cells.push([nr, nc]);
        }
        if (cells.length === 4) return { winner: v, cells };
      }
    }
  }
  return null;
}
function isBoardFull(board) {
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (board[r][c] === 0) return false;
  return true;
}

// ---------- Dispatch ----------
function legalMoves() {
  if (state.variant === "classic") return classicLegalMoves(state.board);
  if (state.variant === "diagonal") return diagonalLegalMoves(state.board);
  if (state.variant === "flip") return flipLegalMoves(state.board, state.gravityIdx);
  if (state.variant === "custom") return null; // Claude decides
  return [];
}

function applyMove(move, player) {
  if (state.variant === "classic") return classicApply(state.board, move, player);
  if (state.variant === "diagonal") return diagonalApply(state.board, move, player);
  if (state.variant === "flip") {
    const landed = flipApply(state.board, move, player, state.gravityIdx);
    settleAll(state.board, state.gravityIdx);
    return landed;
  }
  return null;
}

function maybeFlipGravity() {
  if (state.variant !== "flip") return;
  if (state.moveCount > 0 && state.moveCount % state.flipN === 0) {
    state.gravityIdx = (state.gravityIdx + 1) % 4;
    settleAll(state.board, state.gravityIdx);
    logAdd("system", `Gravity flipped → ${GRAVITY_VECTORS[state.gravityIdx].name}`);
  }
}

// ---------- Rendering ----------
function render() {
  boardEl.innerHTML = "";
  // For variants with side-drop, we render a 7+2 x 6+2 grid with drop arrows.
  const wantsSideDrop = state.variant === "diagonal" || state.variant === "flip" || state.variant === "custom";
  const wantsTopDrop = state.variant === "classic" || state.variant === "diagonal" || state.variant === "flip" || state.variant === "custom";

  const cols = wantsSideDrop ? COLS + 2 : COLS;
  const rows = wantsTopDrop ? ROWS + 2 : ROWS;
  boardEl.style.gridTemplateColumns = `repeat(${cols}, 56px)`;
  boardEl.style.gridTemplateRows = `repeat(${rows}, 56px)`;

  const moves = state.variant === "custom" ? null : legalMoves();
  const canMove = (edge, index) => {
    if (state.variant === "custom") return !state.gameOver && !state.pendingClaude && state.turn === 1;
    if (!moves) return false;
    return moves.some(m =>
      (edge === "top" && (m.column === index || (m.edge === "top" && m.index === index))) ||
      (edge === "bottom" && m.edge === "bottom" && m.index === index) ||
      (edge === "left" && m.edge === "left" && m.index === index) ||
      (edge === "right" && m.edge === "right" && m.index === index)
    );
  };

  const interactive = !state.gameOver && !state.pendingClaude && state.turn === 1;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const isTopRow = wantsTopDrop && r === 0;
      const isBottomRow = wantsTopDrop && r === rows - 1;
      const isLeftCol = wantsSideDrop && c === 0;
      const isRightCol = wantsSideDrop && c === cols - 1;

      if ((isTopRow || isBottomRow) && (isLeftCol || isRightCol)) {
        // Corner — empty
        const corner = document.createElement("div");
        boardEl.appendChild(corner);
        continue;
      }

      if (isTopRow) {
        const idx = wantsSideDrop ? c - 1 : c;
        const drop = makeDrop("top", idx, "▼", interactive && canMove("top", idx));
        boardEl.appendChild(drop);
        continue;
      }
      if (isBottomRow) {
        const idx = wantsSideDrop ? c - 1 : c;
        const drop = makeDrop("bottom", idx, "▲", interactive && canMove("bottom", idx));
        boardEl.appendChild(drop);
        continue;
      }
      if (isLeftCol) {
        const idx = wantsTopDrop ? r - 1 : r;
        const drop = makeDrop("left", idx, "▶", interactive && canMove("left", idx));
        boardEl.appendChild(drop);
        continue;
      }
      if (isRightCol) {
        const idx = wantsTopDrop ? r - 1 : r;
        const drop = makeDrop("right", idx, "◀", interactive && canMove("right", idx));
        boardEl.appendChild(drop);
        continue;
      }

      const br = wantsTopDrop ? r - 1 : r;
      const bc = wantsSideDrop ? c - 1 : c;
      const v = state.board[br][bc];
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.row = br;
      cell.dataset.col = bc;
      cell.dataset.coord = coordLabel(br, bc);
      if (v === 1) {
        cell.classList.add("piece-human");
        const g = document.createElement("span");
        g.className = "glyph";
        g.textContent = "L";
        cell.appendChild(g);
      } else if (v === 2) {
        cell.classList.add("piece-claude");
        const g = document.createElement("span");
        g.className = "glyph";
        g.textContent = "C";
        cell.appendChild(g);
      }
      if (state.winningCells.some(([wr, wc]) => wr === br && wc === bc)) cell.classList.add("win");
      // Custom variant: click any empty cell.
      if (state.variant === "custom" && v === 0 && interactive) {
        cell.classList.add("clickable");
        cell.addEventListener("click", () => onCustomCellClick(br, bc));
      }
      boardEl.appendChild(cell);
    }
  }

  // Gravity indicator
  if (state.variant === "flip") {
    gravityIndicator.hidden = false;
    const g = GRAVITY_VECTORS[state.gravityIdx];
    const next = state.flipN - (state.moveCount % state.flipN);
    gravityIndicator.textContent = `Gravity: ${g.name.toUpperCase()} — drop from ${g.dropEdge} — flips in ${next} move${next === 1 ? "" : "s"}`;
  } else {
    gravityIndicator.hidden = true;
  }
}

function makeDrop(edge, index, _arrow, enabled) {
  const el = document.createElement("div");
  el.className = "drop" + (enabled ? "" : " disabled");
  // Label with column letter / row number rather than arrow glyphs.
  let label;
  if (edge === "top" || edge === "bottom") label = COL_LABELS[index];
  else label = String(ROWS - index);
  el.textContent = label;
  el.dataset.edge = edge;
  el.dataset.index = index;
  if (enabled) el.addEventListener("click", () => onDropClick(edge, index));
  return el;
}

// ---------- Click handlers ----------
function onDropClick(edge, index) {
  if (state.gameOver || state.pendingClaude || state.turn !== 1) return;
  let move;
  if (state.variant === "classic") move = { column: index };
  else move = { edge, index };
  doHumanMove(move);
}

function onCustomCellClick(row, col) {
  if (state.gameOver || state.pendingClaude || state.turn !== 1) return;
  doHumanMove({ row, col });
}

function doHumanMove(move) {
  // For non-custom variants apply locally and check win.
  if (state.variant !== "custom") {
    const landed = applyMove(move, 1);
    if (!landed) { setStatus("Illegal move — try again."); return; }
    state.history.push({ player: 1, move, landed });
    state.moveCount++;
    logAdd("human", `You: ${describeMove(move)} → r${landed.row} c${landed.col}`);
    if (afterMove()) return;
    maybeFlipGravity();
    render();
    requestClaudeMove();
  } else {
    // Custom: send to Claude as rules engine. Claude returns new board + its move.
    state.history.push({ player: 1, move });
    logAdd("human", `You: cell r${move.row} c${move.col}`);
    requestClaudeCustomMove(move);
  }
}

function describeMove(move) {
  if (move.column !== undefined) return `col ${move.column}`;
  if (move.edge) return `${move.edge}-${move.index}`;
  if (move.row !== undefined) return `(${move.row},${move.col})`;
  return JSON.stringify(move);
}

// Returns true if game ended.
function afterMove() {
  const w = checkWin(state.board);
  if (w) {
    state.gameOver = true;
    state.winner = w.winner;
    state.winningCells = w.cells;
    render();
    if (w.winner === 1) { setStatus("You win.", "win-human"); }
    else { setStatus("Claude wins.", "win-claude"); }
    return true;
  }
  if (isBoardFull(state.board)) {
    state.gameOver = true;
    render();
    setStatus("Draw.", "draw");
    return true;
  }
  state.turn = state.turn === 1 ? 2 : 1;
  return false;
}

function setStatus(text, klass) {
  statusEl.className = "status" + (klass ? " " + klass : "");
  statusEl.textContent = text;
}

function logAdd(who, text) {
  const num = document.createElement("div");
  num.className = "num";
  // Number every player move (system entries get a bullet).
  const moveNum = [...logEl.querySelectorAll(".move")].filter(e => !e.classList.contains("system")).length + 1;
  num.textContent = who === "system" ? "·" : moveNum + ".";
  const move = document.createElement("div");
  move.className = "move " + who;
  move.textContent = text;
  logEl.appendChild(num);
  logEl.appendChild(move);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- Claude call ----------
async function requestClaudeMove() {
  if (state.gameOver) return;
  state.pendingClaude = true;
  setStatus("Claude is thinking…");
  thinkingEl.textContent = "";
  thinkingEl.classList.remove("empty");
  streamingIndicator.hidden = false;
  render();

  const body = {
    variant: state.variant,
    board: state.board,
    history: state.history.map(h => ({ player: h.player, move: h.move })),
    moveCount: state.moveCount,
    flipN: state.flipN,
    gravityIdx: state.gravityIdx,
    budget: parseInt(budgetInput.value, 10),
  };

  let finalText = "";
  try {
    finalText = await streamClaude(body);
  } catch (err) {
    setStatus(err.message, "error");
    state.pendingClaude = false;
    streamingIndicator.hidden = true;
    render();
    return;
  }
  streamingIndicator.hidden = true;
  state.pendingClaude = false;

  const move = parseClaudeMove(finalText);
  if (!move) {
    setStatus("Couldn't parse Claude's move. Raw text in thinking panel.");
    thinkingEl.textContent += "\n\n--- RAW RESPONSE ---\n" + finalText;
    return;
  }
  const landed = applyMove(move, 2);
  if (!landed) {
    setStatus("Claude returned illegal move: " + JSON.stringify(move));
    return;
  }
  state.history.push({ player: 2, move, landed });
  state.moveCount++;
  logAdd("claude", `Claude: ${describeMove(move)} → r${landed.row} c${landed.col}`);
  if (afterMove()) return;
  maybeFlipGravity();
  render();
  setStatus("Your move.");
}

async function requestClaudeCustomMove(humanMove) {
  if (state.gameOver) return;
  state.pendingClaude = true;
  setStatus("Claude is thinking…");
  thinkingEl.textContent = "";
  streamingIndicator.hidden = false;
  render();

  const body = {
    variant: "custom",
    customRules: state.customRules,
    board: state.board,
    history: state.history,
    humanMove,
    budget: parseInt(budgetInput.value, 10),
  };

  let finalText = "";
  try {
    finalText = await streamClaude(body);
  } catch (err) {
    setStatus(err.message, "error");
    state.pendingClaude = false;
    streamingIndicator.hidden = true;
    render();
    return;
  }
  streamingIndicator.hidden = true;
  state.pendingClaude = false;

  const result = parseCustomResult(finalText);
  if (!result) {
    setStatus("Couldn't parse Claude's response. Raw text in thinking panel.");
    thinkingEl.textContent += "\n\n--- RAW RESPONSE ---\n" + finalText;
    return;
  }
  if (result.illegal) {
    setStatus("Claude says your move was illegal: " + (result.message || ""));
    // Undo the optimistic human move from history.
    state.history.pop();
    render();
    return;
  }
  state.board = result.newBoard;
  if (result.claudeMove) {
    state.history.push({ player: 2, move: result.claudeMove });
    logAdd("claude", `Claude: ${JSON.stringify(result.claudeMove)}`);
  }
  state.moveCount += 2;
  if (result.gameStatus === "human_wins") {
    state.gameOver = true; state.winner = 1;
    render(); setStatus("You win. " + (result.message || ""), "win-human"); return;
  }
  if (result.gameStatus === "claude_wins") {
    state.gameOver = true; state.winner = 2;
    render(); setStatus("Claude wins. " + (result.message || ""), "win-claude"); return;
  }
  if (result.gameStatus === "draw") {
    state.gameOver = true;
    render(); setStatus("Draw. " + (result.message || ""), "draw"); return;
  }
  state.turn = 1;
  render();
  setStatus("Your move. " + (result.message || ""));
}

async function streamClaude(body) {
  const resp = await fetch("/api/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 501 || text.trim().startsWith("<")) {
      throw new Error("API endpoint not running. Deploy to Vercel (with ANTHROPIC_API_KEY env var), or run `vercel dev` locally — Python http.server can't run /api/move.");
    }
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let thinkingText = "";
  let outText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = chunk.split("\n").find(l => l.startsWith("data: "));
      if (!line) continue;
      const data = line.slice(6).trim();
      if (!data) continue;
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }
      if (evt.type === "content_block_delta") {
        if (evt.delta?.type === "thinking_delta") {
          thinkingText += evt.delta.thinking || "";
          thinkingEl.textContent = thinkingText;
          thinkingEl.scrollTop = thinkingEl.scrollHeight;
        } else if (evt.delta?.type === "text_delta") {
          outText += evt.delta.text || "";
        }
      } else if (evt.type === "message_stop") {
        // Done.
      } else if (evt.type === "error") {
        throw new Error(evt.error?.message || "stream error");
      }
    }
  }
  return outText;
}

function parseClaudeMove(text) {
  // Look for ```json ... ``` block, else first { ... } JSON.
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  let candidate = fence ? fence[1] : text;
  const brace = candidate.match(/\{[\s\S]*\}/);
  if (!brace) return null;
  try {
    const obj = JSON.parse(brace[0]);
    if (obj.move) return obj.move;
    if (obj.column !== undefined || obj.edge || obj.row !== undefined) return obj;
    return null;
  } catch { return null; }
}

function parseCustomResult(text) {
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  let candidate = fence ? fence[1] : text;
  const brace = candidate.match(/\{[\s\S]*\}/);
  if (!brace) return null;
  try {
    const obj = JSON.parse(brace[0]);
    if (!obj.newBoard || !Array.isArray(obj.newBoard)) return null;
    // Sanity: shape check.
    if (obj.newBoard.length !== ROWS || obj.newBoard[0].length !== COLS) return null;
    return obj;
  } catch { return null; }
}

// ---------- Wire up ----------
budgetInput.addEventListener("input", () => { budgetVal.textContent = budgetInput.value; });
variantSel.addEventListener("change", () => {
  flipNWrap.hidden = variantSel.value !== "flip";
  customWrap.hidden = variantSel.value !== "custom";
  variantNameEl.textContent = VARIANT_NAMES[variantSel.value] || variantSel.value;
});
newGameBtn.addEventListener("click", newGame);

// Initial.
flipNWrap.hidden = variantSel.value !== "flip";
customWrap.hidden = variantSel.value !== "custom";
budgetVal.textContent = budgetInput.value;
newGame();
