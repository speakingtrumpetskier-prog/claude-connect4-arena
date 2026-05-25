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
const effortInput = $("#effort");
const firstSel = $("#first");
const newGameBtn = $("#new-game");
const customWrap = $("#custom-rules-wrap");
const customRulesEl = $("#custom-rules");
const gravityIndicator = $("#gravity-indicator");
const streamingIndicator = $("#streaming-indicator");
const variantNameEl = $("#variant-name");
const gameInfoEl = $("#game-info");
const customActionForm = $("#custom-action");
const customActionInput = $("#custom-action-input");

// Stub elements for removed timer UI — kept as no-ops so existing code paths
// don't need to be sprinkled with null-checks.
const _stub = { classList: { add(){}, remove(){}, toggle(){} }, textContent: "" };
const timerHumanEl = _stub;
const timerClaudeEl = _stub;
const timerHumanClock = _stub;
const timerClaudeClock = _stub;

const TIME_PER_PLAYER_MS = 60 * 1000;
let tickerHandle = null;
let customSetupDone = false;     // true once Claude has returned an initial board for custom variant
let customSetupBoard = null;     // cached board from setup, applied when Start game clicked
let customSetupGameInfo = "";    // cached gameInfo from setup

const VARIANT_NAMES = {
  classic: "Classic Connect 4",
  diagonal: "Diagonal Gravity",
  flip: "Gravity Rotate",
  custom: "Custom Rules",
};

const VARIANT_DESCRIPTIONS = {
  classic: "",
  diagonal: "<strong>Gravity pulls down-and-right. Drop pieces from the top edge OR the left edge.</strong>",
  flip: "<strong>Gravity rotates clockwise every N moves.</strong> All pieces re-settle each time it rotates.",
  custom: "<strong>You write the rules; Claude enforces them and plays.</strong> Describe your variant in plain English in the box below. Claude validates each of your moves, makes its own move, and returns the new board.",
};

// Chess-style notation: columns A..Z (left → right), rows 1..N (bottom → top).
// Standard variants use 7 cols × 6 rows; custom variants can resize. Internal
// arrays use row 0 = top, col 0 = left. Convert at every boundary.
function colName(c) { return String.fromCharCode(65 + c); }            // 0→"A", 25→"Z"
function rowName(r, totalRows = ROWS) { return String(totalRows - r); }// r=0 → "<totalRows>", r=N-1 → "1"
function colIdx(letter) {
  const s = String(letter).toUpperCase().trim();
  if (!/^[A-G]$/.test(s)) return NaN;
  return s.charCodeAt(0) - 65;
}
function rowIdx(num) {
  const n = parseInt(String(num).trim(), 10);
  if (isNaN(n) || n < 1 || n > ROWS) return NaN;
  return ROWS - n;
}
function cellChess(r, c, totalRows = ROWS) { return `${colName(c)}${rowName(r, totalRows)}`; }

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
    gravityIdx: 0,
    customRules: customRulesEl.value.trim(),
    pendingClaude: false,
    timeHuman: TIME_PER_PLAYER_MS,
    timeClaude: TIME_PER_PLAYER_MS,
    turnStart: Date.now(),
    started: true,
  };
  thinkingEl.textContent = "";
  thinkingEl.classList.add("empty");
  logEl.innerHTML = "";
  gameInfoEl.hidden = true;
  gameInfoEl.innerHTML = "";
  variantNameEl.textContent = VARIANT_NAMES[state.variant] || state.variant;
  timerHumanEl.classList.remove("expired", "low");
  timerClaudeEl.classList.remove("expired", "low");
  startTicker();
  render();
  renderTimers();
  setStatus(state.turn === 1 ? "Your move." : "Claude moves first…");
  if (state.turn === 2) requestClaudeMove();
}

// Timer feature removed — these are no-ops kept so existing call sites compile.
function startTicker() {}
function stopTicker() {}
function tick() {}
function timeoutLoss() {}
function renderTimers() {}

// ---------- Gravity vectors ----------
const GRAVITY_VECTORS = [
  { name: "down",  dr:  1, dc:  0, dropEdge: "top" },
  { name: "left",  dr:  0, dc: -1, dropEdge: "right" },
  { name: "up",    dr: -1, dc:  0, dropEdge: "bottom" },
  { name: "right", dr:  0, dc:  1, dropEdge: "left" },
];

// ---------- Variant: classic ----------
// Drop into column <letter>. Piece falls until it hits the bottom or another piece.
function classicLegalMoves(board) {
  const moves = [];
  for (let c = 0; c < COLS; c++) {
    if (board[0][c] === 0) moves.push({ column: colName(c) });
  }
  return moves;
}
function classicApply(board, move, player) {
  const c = colIdx(move.column);
  if (isNaN(c)) return null;
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
    if (board[0][c] === 0) moves.push({ edge: "top", column: colName(c) });
  }
  for (let r = 0; r < ROWS; r++) {
    if (board[r][0] === 0) moves.push({ edge: "left", row: parseInt(rowName(r), 10) });
  }
  return moves;
}
function diagonalApply(board, move, player) {
  let r, c;
  if (move.edge === "top") { r = 0; c = colIdx(move.column); }
  else if (move.edge === "left") { r = rowIdx(move.row); c = 0; }
  else return null;
  if (isNaN(r) || isNaN(c) || board[r][c] !== 0) return null;
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
    for (let c = 0; c < COLS; c++) if (board[0][c] === 0) moves.push({ edge: "top", column: colName(c) });
  } else if (g.dropEdge === "bottom") {
    for (let c = 0; c < COLS; c++) if (board[ROWS - 1][c] === 0) moves.push({ edge: "bottom", column: colName(c) });
  } else if (g.dropEdge === "left") {
    for (let r = 0; r < ROWS; r++) if (board[r][0] === 0) moves.push({ edge: "left", row: parseInt(rowName(r), 10) });
  } else if (g.dropEdge === "right") {
    for (let r = 0; r < ROWS; r++) if (board[r][COLS - 1] === 0) moves.push({ edge: "right", row: parseInt(rowName(r), 10) });
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
  if (move.edge === "top")    { r = 0;         c = colIdx(move.column); }
  else if (move.edge === "bottom") { r = ROWS - 1; c = colIdx(move.column); }
  else if (move.edge === "left")   { r = rowIdx(move.row);  c = 0; }
  else if (move.edge === "right")  { r = rowIdx(move.row);  c = COLS - 1; }
  else return null;
  if (isNaN(r) || isNaN(c) || board[r][c] !== 0) return null;
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
    logAdd("system", `Gravity rotated → ${GRAVITY_VECTORS[state.gravityIdx].name}`);
  }
}

// ---------- Rendering ----------
// Grid layout (always):
//   row 0:        [   ][   ][c0][c1][c2][c3][c4][c5][c6][   ]   <- column labels
//   row 1:        [   ][   ][ ▼][ ▼][ ▼][ ▼][ ▼][ ▼][ ▼][   ]   <- top drops
//   rows 2..7:    [r#][▶ ][cell][cell][cell][cell][cell][cell][cell][◀]
//   row 8:        [   ][   ][ ▲][ ▲][ ▲][ ▲][ ▲][ ▲][ ▲][   ]   <- bottom drops
function render() {
  boardEl.innerHTML = "";
  // Custom variant may resize the board — use the actual dimensions from state.
  const R = state.board.length;
  const C = state.board[0] ? state.board[0].length : COLS;
  const gridRows = 2 + R + 1;   // col-labels + top-drops + cells + bottom-drops
  const gridCols = 2 + C + 1;   // row-labels + left-drops + cells + right-drops
  // Compact strip for labels so they sit close to the drop arrows, not a full cell away.
  boardEl.style.gridTemplateColumns = `22px 36px repeat(${C}, 52px) 36px`;
  boardEl.style.gridTemplateRows    = `18px 36px repeat(${R}, 52px) 36px`;

  const moves = state.variant === "custom" ? null : legalMoves();
  const isSupported = (edge, internalIdx) => {
    if (state.variant === "custom") return false;
    if (!moves) return false;
    const asLetter = colName(internalIdx);
    const asRowNum = parseInt(rowName(internalIdx), 10);
    return moves.some(m => {
      // Classic stores { column: "<letter>" } without an edge.
      if (edge === "top" && !m.edge && m.column === asLetter) return true;
      if (m.edge !== edge) return false;
      if (edge === "top" || edge === "bottom") return m.column === asLetter;
      if (edge === "left" || edge === "right") return m.row === asRowNum;
      return false;
    });
  };

  const interactive = state.started && !state.gameOver && !state.pendingClaude && state.turn === 1;
  const dropStateFor = (edge, idx) =>
    !isSupported(edge, idx) ? "unsupported" : (interactive ? "active" : "waiting");

  const empty = () => document.createElement("div");
  const label = (text) => {
    const el = document.createElement("div");
    el.className = "coord-label";
    el.textContent = text;
    return el;
  };

  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      const isColLabelRow = r === 0;
      const isTopDropRow  = r === 1;
      const isBottomDropRow = r === gridRows - 1;
      const isRowLabelCol = c === 0;
      const isLeftDropCol = c === 1;
      const isRightDropCol = c === gridCols - 1;

      // Corners — empty placeholder
      if ((isColLabelRow || isTopDropRow || isBottomDropRow) && (isRowLabelCol || isLeftDropCol || isRightDropCol)) {
        boardEl.appendChild(empty()); continue;
      }

      if (isColLabelRow) { const el = label(colName(c - 2)); el.classList.add("col-label"); boardEl.appendChild(el); continue; }
      if (isRowLabelCol) { const el = label(rowName(r - 2, R)); el.classList.add("row-label"); boardEl.appendChild(el); continue; }
      if (isTopDropRow)    { const i = c - 2; boardEl.appendChild(makeDrop("top",    i, "▼", dropStateFor("top",    i))); continue; }
      if (isBottomDropRow) { const i = c - 2; boardEl.appendChild(makeDrop("bottom", i, "▲", dropStateFor("bottom", i))); continue; }
      if (isLeftDropCol)   { const i = r - 2; boardEl.appendChild(makeDrop("left",   i, "▶", dropStateFor("left",   i))); continue; }
      if (isRightDropCol)  { const i = r - 2; boardEl.appendChild(makeDrop("right",  i, "◀", dropStateFor("right",  i))); continue; }

      const br = r - 2, bc = c - 2;
      const v = state.board[br][bc];
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.row = br;
      cell.dataset.col = bc;
      if (v === 1) cell.classList.add("piece-human");
      else if (v === 2) cell.classList.add("piece-claude");
      else if (v && typeof v === "object") {
        if (v.owner === 1) cell.classList.add("piece-human");
        else if (v.owner === 2) cell.classList.add("piece-claude");
        if (v.color) cell.style.background = v.color;
        if (v.glyph) {
          const g = document.createElement("span");
          g.className = "cell-glyph";
          g.textContent = v.glyph;
          cell.appendChild(g);
        }
        if (v.title) cell.title = v.title;
      }
      if (state.winningCells.some(([wr, wc]) => wr === br && wc === bc)) cell.classList.add("win");
      const isEmpty = (v === 0 || v === null || v === undefined);
      if (state.variant === "custom" && isEmpty && interactive) {
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
    const arrowGlyph = { down: "↓", up: "↑", left: "←", right: "→" }[g.name];
    gravityIndicator.innerHTML = "";
    const wrap = document.createElement("span");
    wrap.className = "gravity-arrow";
    const arr = document.createElement("span");
    arr.className = "arrow";
    arr.textContent = arrowGlyph;
    wrap.appendChild(arr);
    const txt = document.createElement("span");
    txt.textContent = `Gravity ${g.name} · flips in ${next} move${next === 1 ? "" : "s"}`;
    wrap.appendChild(txt);
    gravityIndicator.appendChild(wrap);
  } else if (state.variant === "diagonal") {
    gravityIndicator.hidden = false;
    gravityIndicator.innerHTML = "";
    const wrap = document.createElement("span");
    wrap.className = "gravity-arrow";
    const arr = document.createElement("span");
    arr.className = "arrow";
    arr.textContent = "↘";
    wrap.appendChild(arr);
    const txt = document.createElement("span");
    txt.textContent = "Pieces slide down-right";
    wrap.appendChild(txt);
    gravityIndicator.appendChild(wrap);
  } else {
    gravityIndicator.hidden = true;
  }
}

// `state`: "active" (clickable), "waiting" (legal but Claude's turn), "unsupported" (variant doesn't allow this edge/cell).
function makeDrop(edge, index, arrow, dropState) {
  const el = document.createElement("div");
  el.className = "drop " + dropState;
  el.textContent = arrow;
  el.dataset.edge = edge;
  el.dataset.index = index;
  if (dropState === "active") {
    el.addEventListener("click", () => onDropClick(edge, index));
    el.addEventListener("mouseenter", () => showHoverPreview(edge, index));
    el.addEventListener("mouseleave", clearHoverPreview);
  }
  return el;
}

// ---------- Hover preview ----------
let lastPreviewKey = null;
function showHoverPreview(edge, internalIdx) {
  // Compute where the piece would land using a board clone.
  const clone = state.board.map(r => r.slice());
  const move = buildMoveFromInternal(edge, internalIdx);
  let landed = null;
  if (state.variant === "classic") landed = classicApply(clone, move, 1);
  else if (state.variant === "diagonal") landed = diagonalApply(clone, move, 1);
  else if (state.variant === "flip") landed = flipApply(clone, move, 1, state.gravityIdx);
  if (!landed) return;
  clearHoverPreview();
  const key = `${landed.row},${landed.col}`;
  lastPreviewKey = key;
  const cell = boardEl.querySelector(`.cell[data-row="${landed.row}"][data-col="${landed.col}"]`);
  if (cell && !cell.classList.contains("piece-human") && !cell.classList.contains("piece-claude")) {
    cell.classList.add("ghost-human");
  }
}
function clearHoverPreview() {
  if (!lastPreviewKey) return;
  boardEl.querySelectorAll(".cell.ghost-human").forEach(el => el.classList.remove("ghost-human"));
  lastPreviewKey = null;
}

// ---------- Click handlers ----------
function buildMoveFromInternal(edge, internalIdx) {
  if (state.variant === "classic") return { column: colName(internalIdx) };
  if (edge === "top" || edge === "bottom") return { edge, column: colName(internalIdx) };
  return { edge, row: parseInt(rowName(internalIdx), 10) };
}

function onDropClick(edge, internalIdx) {
  if (state.gameOver || state.pendingClaude || state.turn !== 1) return;
  doHumanMove(buildMoveFromInternal(edge, internalIdx));
}

function onCustomCellClick(row, col) {
  if (state.gameOver || state.pendingClaude || state.turn !== 1) return;
  doHumanMove({ cell: cellChess(row, col, state.board.length) });
}

function doHumanMove(move) {
  // For non-custom variants apply locally and check win.
  if (state.variant !== "custom") {
    const landed = applyMove(move, 1);
    if (!landed) { setStatus("Illegal move — try again."); return; }
    state.history.push({ player: 1, move, landed });
    state.moveCount++;
    logAdd("human", `You: ${describeMove(move)} → ${cellChess(landed.row, landed.col)}`);
    if (afterMove()) return;
    maybeFlipGravity();
    render();
    requestClaudeMove();
  } else {
    // Custom: send to Claude as rules engine. Claude returns new board + its move.
    state.history.push({ player: 1, move });
    logAdd("human", `You: ${describeMove(move)}`);
    requestClaudeCustomMove(move);
  }
}

function describeMove(move) {
  if (move.cell) return `cell ${move.cell}`;
  if (!move.edge && move.column) return `top ${move.column}`;        // classic
  if (move.edge === "top")    return `top ${move.column}`;
  if (move.edge === "bottom") return `bot ${move.column}`;
  if (move.edge === "left")   return `left ${move.row}`;
  if (move.edge === "right")  return `right ${move.row}`;
  return JSON.stringify(move);
}

// Returns true if game ended.
function afterMove() {
  const w = checkWin(state.board);
  if (w) {
    state.gameOver = true;
    state.winner = w.winner;
    state.winningCells = w.cells;
    stopTicker();
    render();
    renderTimers();
    if (w.winner === 1) { setStatus("You win.", "win-human"); }
    else { setStatus("Claude wins.", "win-claude"); }
    return true;
  }
  if (isBoardFull(state.board)) {
    state.gameOver = true;
    stopTicker();
    render();
    renderTimers();
    setStatus("Draw.", "draw");
    return true;
  }
  state.turn = state.turn === 1 ? 2 : 1;
  // Per-turn clock: each move gets a fresh 90s. Reset whoever's turn just started.
  if (state.turn === 1) state.timeHuman = TIME_PER_PLAYER_MS;
  else state.timeClaude = TIME_PER_PLAYER_MS;
  state.turnStart = Date.now();
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
  state.abortController = new AbortController();
  setStatus("Claude is thinking…", "thinking");
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
    effort: effortInput.value,
    timeClaudeMs: state.timeClaude,
    timeHumanMs: state.timeHuman,
    timePerPlayerMs: TIME_PER_PLAYER_MS,
  };

  let finalText = "";
  try {
    finalText = await streamClaude(body, state.abortController.signal);
  } catch (err) {
    if (state.gameOver) return;
    // If aborted (e.g., game ended mid-stream) fall through; otherwise surface.
    if (err.name !== "AbortError") {
      setStatus(err.message, "error");
      state.pendingClaude = false;
      streamingIndicator.hidden = true;
      render();
      return;
    }
  }
  if (state.gameOver) return;
  streamingIndicator.hidden = true;
  state.pendingClaude = false;
  state.abortController = null;

  let move = parseClaudeMove(finalText);
  let forced = false;
  if (!move) {
    // Either the stream was force-aborted before Claude finished, OR Claude's
    // output was malformed. Either way: pick a legal move on Claude's behalf
    // so the game continues within the budget.
    move = pickFallbackMove();
    forced = true;
    if (!move) {
      setStatus("No legal Claude move available.");
      return;
    }
  }
  const landed = applyMove(move, 2);
  if (!landed) {
    // Claude returned a parseable but illegal move — fall back as well.
    move = pickFallbackMove();
    forced = true;
    if (!move) { setStatus("No legal Claude move available."); return; }
    const fb = applyMove(move, 2);
    if (!fb) { setStatus("Fallback failed."); return; }
    state.history.push({ player: 2, move, landed: fb });
    state.moveCount++;
    logAdd("system", `Auto-played for Claude: ${describeMove(move)} → ${cellChess(fb.row, fb.col)}`);
    if (afterMove()) return;
    maybeFlipGravity();
    render();
    setStatus("Your move.");
    return;
  }
  state.history.push({ player: 2, move, landed });
  state.moveCount++;
  if (forced) logAdd("system", `Auto-played for Claude: ${describeMove(move)} → ${cellChess(landed.row, landed.col)}`);
  else logAdd("claude", `Claude: ${describeMove(move)} → ${cellChess(landed.row, landed.col)}`);
  if (afterMove()) return;
  maybeFlipGravity();
  render();
  setStatus("Your move.");
}

// Pick any legal move for Claude when its API call is too slow or its output
// is unusable. Uses uniform random over legal moves; no strategy.
function pickFallbackMove() {
  const moves = legalMoves();
  if (!moves || moves.length === 0) return null;
  return moves[Math.floor(Math.random() * moves.length)];
}

async function requestClaudeCustomMove(humanMove) {
  if (state.gameOver) return;
  state.pendingClaude = true;
  state.abortController = new AbortController();
  setStatus("Claude is thinking…", "thinking");
  thinkingEl.textContent = "";
  thinkingEl.classList.remove("empty");
  streamingIndicator.hidden = false;
  render();

  const body = {
    variant: "custom",
    customRules: state.customRules,
    board: state.board,
    history: state.history,
    humanMove,
    effort: effortInput.value,
    timeClaudeMs: state.timeClaude,
    timeHumanMs: state.timeHuman,
    timePerPlayerMs: TIME_PER_PLAYER_MS,
  };

  let finalText = "";
  try {
    finalText = await streamClaude(body, state.abortController.signal);
  } catch (err) {
    if (state.gameOver) return;
    setStatus(err.message, "error");
    state.pendingClaude = false;
    streamingIndicator.hidden = true;
    render();
    return;
  }
  if (state.gameOver) return;
  streamingIndicator.hidden = true;
  state.pendingClaude = false;
  state.abortController = null;

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
  if (result.gameInfo) {
    gameInfoEl.hidden = false;
    gameInfoEl.innerHTML = result.gameInfo;
  } else {
    gameInfoEl.hidden = true;
    gameInfoEl.innerHTML = "";
  }
  if (result.claudeMove) {
    state.history.push({ player: 2, move: result.claudeMove });
    const desc = typeof result.claudeMove === "string"
      ? result.claudeMove
      : (result.claudeMove.text || JSON.stringify(result.claudeMove));
    logAdd("claude", `Claude: ${desc}`);
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

async function streamClaude(body, signal) {
  const resp = await fetch("/api/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
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
    let res;
    try {
      res = await reader.read();
    } catch (e) {
      // Aborted mid-stream — return whatever we got so far instead of throwing,
      // so the caller can salvage a parseable move from the partial text.
      if (signal && signal.aborted) break;
      throw e;
    }
    const { done, value } = res;
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
  // Grab the LAST code block in the response (Claude often writes example JSON
  // mid-reasoning; the final committed move is in the last fenced block).
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  let candidate = fences.length ? fences[fences.length - 1][1] : text;
  // Within the candidate, find a balanced JSON object.
  const start = candidate.indexOf("{");
  if (start === -1) return null;
  let depth = 0, end = -1;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1));
    if (obj.move) return obj.move;
    if (obj.column !== undefined || obj.edge || obj.row !== undefined) return obj;
    return null;
  } catch { return null; }
}

function parseCustomResult(text) {
  // Grab the LAST code block — Claude may put example JSON in its reasoning.
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  let candidate = fences.length ? fences[fences.length - 1][1] : text;
  const start = candidate.indexOf("{");
  if (start === -1) return null;
  let depth = 0, end = -1;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1));
    if (!obj.newBoard || !Array.isArray(obj.newBoard)) return null;
    const R = obj.newBoard.length;
    if (R < 2 || R > 20) return null;
    if (!Array.isArray(obj.newBoard[0])) return null;
    const C = obj.newBoard[0].length;
    if (C < 2 || C > 26) return null;
    for (const row of obj.newBoard) {
      if (!Array.isArray(row) || row.length !== C) return null;
    }
    return obj;
  } catch { return null; }
}

// ---------- Wire up ----------
function updateVariantDesc() {
  const v = variantSel.value;
  const el = document.querySelector("#variant-desc");
  if (el) el.innerHTML = VARIANT_DESCRIPTIONS[v] || "";
}
variantSel.addEventListener("change", () => {
  flipNWrap.hidden = variantSel.value !== "flip";
  customWrap.hidden = variantSel.value !== "custom";
  customActionForm.hidden = variantSel.value !== "custom";
  variantNameEl.textContent = VARIANT_NAMES[variantSel.value] || variantSel.value;
  updateVariantDesc();
  // Switching variants invalidates any prior custom setup.
  customSetupDone = false;
  customSetupBoard = null;
  customSetupGameInfo = "";
  if (state && !state.started) initBoard();
  updateStartButton();
});

customRulesEl.addEventListener("input", () => {
  // Edited rules invalidate the cached setup; user must re-run Setup.
  if (customSetupDone) {
    customSetupDone = false;
    customSetupBoard = null;
    customSetupGameInfo = "";
    updateStartButton();
    setStatus("Rules changed — click Setup again.");
  }
});

customActionForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = customActionInput.value.trim();
  if (!text) return;
  if (state.gameOver || state.pendingClaude || state.turn !== 1) return;
  customActionInput.value = "";
  doHumanMove({ text });
});
newGameBtn.addEventListener("click", onStartButton);

function updateStartButton() {
  if (!newGameBtn) return;
  if (variantSel.value === "custom" && !customSetupDone) {
    newGameBtn.textContent = "Setup";
    newGameBtn.title = "Send your rules to Claude so it can build the initial board state";
  } else {
    newGameBtn.textContent = "Start game";
    newGameBtn.title = "Begin the game (timer starts)";
  }
}

function onStartButton() {
  if (variantSel.value === "custom" && !customSetupDone) {
    runCustomSetup();
  } else {
    newGame();
    // If setup was done, the cached board carries over into the new state.
    if (variantSel.value === "custom" && customSetupBoard) {
      state.board = customSetupBoard;
      if (customSetupGameInfo) {
        gameInfoEl.hidden = false;
        gameInfoEl.innerHTML = customSetupGameInfo;
      }
      // Clear the cache so the next "Start game" needs another Setup.
      customSetupDone = false;
      customSetupBoard = null;
      customSetupGameInfo = "";
      updateStartButton();
      render();
    }
  }
}

async function runCustomSetup() {
  const rules = customRulesEl.value.trim();
  if (!rules) { setStatus("Type your rules above first.", "error"); return; }
  newGameBtn.disabled = true;
  newGameBtn.textContent = "Setting up…";
  thinkingEl.textContent = "";
  thinkingEl.classList.remove("empty");
  streamingIndicator.hidden = false;
  setStatus("Claude is setting up the game…", "thinking");

  const body = {
    variant: "custom",
    customRules: rules,
    init: true,
    effort: effortInput.value,
  };
  const ac = new AbortController();
  let finalText = "";
  try {
    finalText = await streamClaude(body, ac.signal);
  } catch (err) {
    streamingIndicator.hidden = true;
    newGameBtn.disabled = false;
    updateStartButton();
    setStatus("Setup failed: " + err.message, "error");
    return;
  }
  streamingIndicator.hidden = true;

  const result = parseCustomResult(finalText);
  if (!result || !result.newBoard) {
    newGameBtn.disabled = false;
    updateStartButton();
    setStatus("Couldn't parse Claude's setup response. Try again.", "error");
    thinkingEl.textContent += "\n\n--- RAW RESPONSE ---\n" + finalText;
    return;
  }

  // Cache for when user clicks Start game.
  customSetupBoard = result.newBoard;
  customSetupGameInfo = result.gameInfo || "";
  customSetupDone = true;
  // Show the initialized board immediately so the user can see what they're starting from.
  state.board = customSetupBoard;
  if (customSetupGameInfo) {
    gameInfoEl.hidden = false;
    gameInfoEl.innerHTML = customSetupGameInfo;
  } else {
    gameInfoEl.hidden = true;
    gameInfoEl.innerHTML = "";
  }
  newGameBtn.disabled = false;
  updateStartButton();
  setStatus(result.message ? `Setup complete. ${result.message}` : "Setup complete. Click Start game.");
  render();
}

// Initial.
flipNWrap.hidden = variantSel.value !== "flip";
customWrap.hidden = variantSel.value !== "custom";
customActionForm.hidden = variantSel.value !== "custom";
updateVariantDesc();
updateStartButton();
initBoard();

function initBoard() {
  // Pre-start: show an empty board with full clocks, but no ticker, no
  // interactivity. Game begins when the user clicks "Start game".
  state = {
    variant: variantSel.value,
    board: emptyBoard(),
    turn: firstSel.value === "human" ? 1 : 2,
    moveCount: 0,
    gameOver: false,
    winner: null,
    winningCells: [],
    history: [],
    flipN: parseInt(flipNInput.value, 10) || 3,
    gravityIdx: 0,
    customRules: customRulesEl.value.trim(),
    pendingClaude: false,
    timeHuman: TIME_PER_PLAYER_MS,
    timeClaude: TIME_PER_PLAYER_MS,
    turnStart: Date.now(),
    started: false,
  };
  thinkingEl.textContent = "Press Start game to begin.";
  thinkingEl.classList.add("empty");
  logEl.innerHTML = "";
  variantNameEl.textContent = VARIANT_NAMES[state.variant] || state.variant;
  timerHumanEl.classList.remove("expired", "low", "active");
  timerClaudeEl.classList.remove("expired", "low", "active");
  render();
  renderTimers();
  setStatus("Press Start game.");
}
