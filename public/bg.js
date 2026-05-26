// Ambient Connect-4 background. Ghost boards scattered around the viewport
// where pucks slowly drop & stack. When a board fills, any 4-in-a-row briefly
// glows, then the board sweeps clean and starts over.
//
// Exposes window.bgBurst(winner) for the win-celebration puck rain.

const canvas = document.getElementById("bg-canvas");
if (!canvas) {
  console.warn("bg-canvas not found");
} else {
  const ctx = canvas.getContext("2d");

  const RED = "#e85655";
  const YELLOW = "#f0bf3a";
  const RED_FAINT = "rgba(232, 86, 85, 0.14)";
  const YELLOW_FAINT = "rgba(240, 191, 58, 0.14)";
  const EMPTY = "rgba(20, 18, 14, 0.04)";

  function dpr() { return window.devicePixelRatio || 1; }
  function resize() {
    const r = dpr();
    canvas.width = window.innerWidth * r;
    canvas.height = window.innerHeight * r;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    layoutBoards();
  }
  window.addEventListener("resize", resize);

  // Ghost boards
  const PUCK_R = 12;
  const CELL = PUCK_R * 2 + 2;
  const ROWS = 6, COLS = 7;
  const boards = [];

  function makeBoard(x, y) {
    return {
      x, y,
      grid: Array.from({ length: ROWS }, () => Array(COLS).fill(0)),
      pucks: [],          // falling pucks: {col, targetRow, y, player}
      nextSpawnAt: 0,
      glowingLines: [],   // {cells:[[r,c]…], until: t}
      state: "filling",   // "filling" | "glowing" | "sweeping"
      sweepStart: 0,
    };
  }

  function layoutBoards() {
    boards.length = 0;
    const W = window.innerWidth, H = window.innerHeight;
    const boardW = COLS * CELL, boardH = ROWS * CELL;
    // Place boards in the page gutters: top-left, top-right, bottom-left,
    // bottom-right of the viewport, plus mid-left + mid-right when there's room.
    const positions = [];
    positions.push([16, 16]);                            // top-left
    positions.push([W - boardW - 16, 16]);               // top-right
    positions.push([16, H - boardH - 16]);               // bottom-left
    positions.push([W - boardW - 16, H - boardH - 16]); // bottom-right
    if (H > 1100) {
      positions.push([16, Math.floor(H / 2 - boardH / 2)]);
      positions.push([W - boardW - 16, Math.floor(H / 2 - boardH / 2)]);
    }
    for (const [x, y] of positions) boards.push(makeBoard(x, y));
    // Stagger initial spawn so they don't pulse in unison.
    boards.forEach((b, i) => { b.nextSpawnAt = performance.now() + i * 350; });
  }

  // 4-in-a-row scan after a board fills.
  function findWinningLines(grid) {
    const lines = [];
    const dirs = [[0,1],[1,0],[1,1],[1,-1]];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v = grid[r][c]; if (!v) continue;
        for (const [dr, dc] of dirs) {
          const cells = [[r,c]];
          let ok = true;
          for (let k = 1; k < 4; k++) {
            const nr = r + dr*k, nc = c + dc*k;
            if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS || grid[nr][nc] !== v) { ok = false; break; }
            cells.push([nr, nc]);
          }
          if (ok) lines.push({ cells, color: v });
        }
      }
    }
    return lines;
  }

  function isFull(grid) {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (!grid[r][c]) return false;
    return true;
  }

  function spawnPuckOn(board) {
    // Pick a column that isn't full yet.
    const candidates = [];
    for (let c = 0; c < COLS; c++) if (board.grid[0][c] === 0) candidates.push(c);
    if (!candidates.length) return;
    const col = candidates[Math.floor(Math.random() * candidates.length)];
    let landRow = ROWS - 1;
    while (landRow >= 0 && board.grid[landRow][col] !== 0) landRow--;
    if (landRow < 0) return;
    const player = Math.random() < 0.5 ? 1 : 2;
    board.pucks.push({ col, targetRow: landRow, y: -CELL, player });
  }

  // Win-celebration burst: a transient set of pucks that rain across the
  // viewport (not bound to a ghost board).
  const burstPucks = []; // {x, y, vy, color, ay, alpha}
  function startBurst(winner) {
    const W = window.innerWidth, H = window.innerHeight;
    const color = winner === 1 ? RED : (winner === 2 ? YELLOW : RED);
    const altColor = winner === 1 ? YELLOW : (winner === 2 ? RED : YELLOW);
    const n = 90;
    for (let i = 0; i < n; i++) {
      burstPucks.push({
        x: Math.random() * W,
        y: -20 - Math.random() * H * 0.5,
        vy: 60 + Math.random() * 120,    // px/sec
        ay: 200,                          // gravity-like
        r: 8 + Math.random() * 6,
        color: Math.random() < 0.7 ? color : altColor,
        alpha: 0.22 + Math.random() * 0.18,
        spin: Math.random() * Math.PI * 2,
        spinRate: (Math.random() - 0.5) * 4,
      });
    }
  }
  window.bgBurst = startBurst;

  // Main loop
  let lastT = performance.now();
  function tick(t) {
    const dt = Math.min(50, t - lastT) / 1000; // seconds, clamp to avoid jumps
    lastT = t;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const b of boards) {
      // Spawn pacing
      if (b.state === "filling" && t > b.nextSpawnAt) {
        // Don't let too many pucks be in flight at once.
        const inFlight = b.pucks.filter(p => p.y < (p.targetRow + 0.5) * CELL).length;
        if (inFlight < 2) spawnPuckOn(b);
        b.nextSpawnAt = t + 700 + Math.random() * 900;
      }

      // Update falling pucks
      for (const p of b.pucks) {
        const targetY = (p.targetRow + 0.5) * CELL;
        if (p.y < targetY) {
          p.y = Math.min(p.y + 120 * dt, targetY);
          if (p.y >= targetY && b.grid[p.targetRow][p.col] === 0) {
            b.grid[p.targetRow][p.col] = p.player;
          }
        }
      }
      // Settled pucks live in the grid; drop them from the falling list once seated.
      b.pucks = b.pucks.filter(p => p.y < (p.targetRow + 0.5) * CELL);

      // Transition to "glowing" when full
      if (b.state === "filling" && isFull(b.grid)) {
        const lines = findWinningLines(b.grid);
        b.glowingLines = lines.map(l => ({ ...l, until: t + 1400 }));
        b.state = "glowing";
        b.sweepStart = t + 1400;
      }
      if (b.state === "glowing" && t >= b.sweepStart) {
        b.state = "sweeping";
        b.sweepStart = t;
      }
      if (b.state === "sweeping" && t - b.sweepStart > 700) {
        // Reset
        b.grid = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
        b.pucks = [];
        b.glowingLines = [];
        b.state = "filling";
        b.nextSpawnAt = t + 400;
      }

      // Draw board
      const sweepFrac = b.state === "sweeping" ? Math.min(1, (t - b.sweepStart) / 700) : 0;
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const cx = b.x + c * CELL + CELL / 2;
          const cy = b.y + r * CELL + CELL / 2;
          // Empty hint dot
          ctx.beginPath(); ctx.arc(cx, cy, PUCK_R, 0, Math.PI * 2);
          ctx.fillStyle = EMPTY; ctx.fill();
          const v = b.grid[r][c];
          if (!v) continue;
          // Sweep: pucks fade out top-to-bottom over the duration
          const fade = b.state === "sweeping"
            ? Math.max(0, 1 - Math.max(0, (sweepFrac * (ROWS + 2) - r)) / 1.5)
            : 1;
          ctx.fillStyle = v === 1
            ? `rgba(232, 86, 85, ${0.14 * fade})`
            : `rgba(240, 191, 58, ${0.14 * fade})`;
          ctx.fill();
        }
      }
      // Falling pucks
      for (const p of b.pucks) {
        const cx = b.x + p.col * CELL + CELL / 2;
        const cy = b.y + p.y;
        ctx.beginPath(); ctx.arc(cx, cy, PUCK_R, 0, Math.PI * 2);
        ctx.fillStyle = p.player === 1 ? RED_FAINT : YELLOW_FAINT;
        ctx.fill();
      }
      // Glowing winning lines
      for (const line of b.glowingLines) {
        const remaining = line.until - t;
        if (remaining <= 0) continue;
        const pulse = 0.35 + 0.45 * Math.sin(t * 0.008);
        const a = Math.min(1, remaining / 700) * pulse;
        ctx.strokeStyle = line.color === 1 ? `rgba(232, 86, 85, ${a})` : `rgba(240, 191, 58, ${a})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        for (let i = 0; i < line.cells.length; i++) {
          const [r, c] = line.cells[i];
          const cx = b.x + c * CELL + CELL / 2;
          const cy = b.y + r * CELL + CELL / 2;
          if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
        }
        ctx.stroke();
        // Halo on each cell
        for (const [r, c] of line.cells) {
          const cx = b.x + c * CELL + CELL / 2;
          const cy = b.y + r * CELL + CELL / 2;
          ctx.beginPath(); ctx.arc(cx, cy, PUCK_R + 4, 0, Math.PI * 2);
          ctx.fillStyle = line.color === 1 ? `rgba(232, 86, 85, ${a * 0.5})` : `rgba(240, 191, 58, ${a * 0.5})`;
          ctx.fill();
        }
      }
    }

    // Win-burst pucks
    if (burstPucks.length) {
      const H = window.innerHeight;
      for (const p of burstPucks) {
        p.vy += p.ay * dt;
        p.y += p.vy * dt;
        p.spin += p.spinRate * dt;
        const rgb = p.color === RED ? "232, 86, 85" : "240, 191, 58";
        ctx.fillStyle = `rgba(${rgb}, ${p.alpha})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
        // Slight inner highlight to give discs depth even at low opacity
        ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha * 0.4})`;
        ctx.beginPath(); ctx.arc(p.x - p.r * 0.3, p.y - p.r * 0.3, p.r * 0.35, 0, Math.PI * 2); ctx.fill();
      }
      // Cull pucks that fell off-screen
      for (let i = burstPucks.length - 1; i >= 0; i--) {
        if (burstPucks[i].y - burstPucks[i].r > H + 40) burstPucks.splice(i, 1);
      }
    }

    requestAnimationFrame(tick);
  }

  resize();
  requestAnimationFrame((t) => { lastT = t; tick(t); });
}
