// Ambient Connect-4 background. ONE big board that fills the viewport,
// pucks drop and stack with sheen / trails / settle-bounce. When the board
// fills, 4-in-a-rows pulse, then the board sweeps and starts over.
//
// Exposes window.bgBurst(winner) for the win-celebration puck rain.

const canvas = document.getElementById("bg-canvas");
if (!canvas) {
  console.warn("bg-canvas not found");
} else {
  const ctx = canvas.getContext("2d");

  // Classic Connect-4 plastic palette: deep cobalt board, cherry red + cobalt blue pucks.
  const RED = "#e3554f";
  const BLUE = "#2e6bd6";

  const ROWS = 6, COLS = 7;
  let cellW = 0, cellH = 0, puckR = 0;

  function dpr() { return window.devicePixelRatio || 1; }
  function resize() {
    const r = dpr();
    canvas.width = window.innerWidth * r;
    canvas.height = window.innerHeight * r;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    cellW = window.innerWidth / COLS;
    cellH = window.innerHeight / ROWS;
    puckR = Math.min(cellW, cellH) * 0.42;
  }
  window.addEventListener("resize", resize);

  // Single full-viewport board.
  const board = {
    grid: Array.from({ length: ROWS }, () => Array(COLS).fill(0)),
    pucks: [],          // falling: {col, targetRow, y, vy, player, settled, bounceT}
    nextSpawnAt: 0,
    glowingLines: [],   // {cells, color, until, born}
    state: "filling",   // "filling" | "glowing" | "sweeping"
    sweepStart: 0,
  };

  function isFull(grid) {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (!grid[r][c]) return false;
    return true;
  }

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

  function spawnPuck(now) {
    const candidates = [];
    for (let c = 0; c < COLS; c++) if (board.grid[0][c] === 0) candidates.push(c);
    if (!candidates.length) return;
    const col = candidates[Math.floor(Math.random() * candidates.length)];
    let landRow = ROWS - 1;
    while (landRow >= 0 && board.grid[landRow][col] !== 0) landRow--;
    if (landRow < 0) return;
    const player = Math.random() < 0.5 ? 1 : 2;
    board.pucks.push({
      col, targetRow: landRow,
      y: -cellH * 0.5,
      vy: cellH * 0.6,    // initial speed; accelerates under gravity
      player,
      settled: false,
      bounceT: 0,         // when > 0, run bounce animation
      bornAt: now,
      trail: [],          // recent y positions for motion trail
    });
  }

  function cellCenter(r, c) {
    return [c * cellW + cellW / 2, r * cellH + cellH / 2];
  }

  // ---------- Drawing helpers ----------
  // Flat pieces — no gradient, no glossy highlight, no visible empty cells.
  function drawPuck(cx, cy, player, alpha = 0.22, scale = 1) {
    const r = puckR * scale;
    const baseColor = player === 1 ? RED : BLUE;
    ctx.fillStyle = hexAlpha(baseColor, alpha);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  }

  function hexAlpha(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  // ---------- Win burst ----------
  const burstPucks = [];
  function startBurst(winner) {
    const W = window.innerWidth, H = window.innerHeight;
    // Map game winners (1 = human / red, 2 = claude) to bg colors.
    // Claude is yellow in main UI but blue in bg theme — keep red vs blue.
    const dominant = winner === 1 ? 1 : 2;
    const off = dominant === 1 ? 2 : 1;
    const n = 110;
    for (let i = 0; i < n; i++) {
      burstPucks.push({
        x: Math.random() * W,
        y: -40 - Math.random() * H * 0.6,
        vy: 80 + Math.random() * 160,
        vx: (Math.random() - 0.5) * 60,
        ay: 280,
        r: puckR * (0.5 + Math.random() * 0.55),
        player: Math.random() < 0.78 ? dominant : off,
        alpha: 0.28 + Math.random() * 0.22,
        spin: Math.random() * Math.PI * 2,
        spinRate: (Math.random() - 0.5) * 6,
      });
    }
  }
  window.bgBurst = startBurst;

  // ---------- Main loop ----------
  let lastT = performance.now();
  function tick(t) {
    const dt = Math.min(50, t - lastT) / 1000;
    lastT = t;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // --- Update board ---
    if (board.state === "filling" && t > board.nextSpawnAt) {
      const inFlight = board.pucks.filter(p => !p.settled).length;
      if (inFlight < 2) spawnPuck(t);
      board.nextSpawnAt = t + 950 + Math.random() * 800;
    }

    for (const p of board.pucks) {
      if (p.settled) {
        if (p.bounceT > 0) p.bounceT = Math.max(0, p.bounceT - dt);
        continue;
      }
      // Trail history
      p.trail.push(p.y);
      if (p.trail.length > 4) p.trail.shift();
      // Gravity
      p.vy += cellH * 1.4 * dt;
      p.y += p.vy * dt;
      const targetY = (p.targetRow + 0.5) * cellH;
      if (p.y >= targetY) {
        p.y = targetY;
        p.settled = true;
        p.bounceT = 0.28;
        if (board.grid[p.targetRow][p.col] === 0) board.grid[p.targetRow][p.col] = p.player;
      }
    }

    // Transition: full → glow → sweep → reset
    if (board.state === "filling" && isFull(board.grid)) {
      const lines = findWinningLines(board.grid);
      board.glowingLines = lines.map(l => ({ ...l, until: t + 1200, born: t }));
      board.state = "glowing";
      board.sweepStart = t + 1200;
    }
    if (board.state === "glowing" && t >= board.sweepStart) {
      board.state = "sweeping";
      board.sweepStart = t;
    }
    if (board.state === "sweeping" && t - board.sweepStart > 900) {
      board.grid = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
      board.pucks = [];
      board.glowingLines = [];
      board.state = "filling";
      board.nextSpawnAt = t + 500;
    }

    // --- Draw board ---
    // Settled pucks (with sweep fade) — no visible empty cells; pucks just settle into invisible spots.
    const sweepFrac = board.state === "sweeping" ? Math.min(1, (t - board.sweepStart) / 900) : 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v = board.grid[r][c]; if (!v) continue;
        const [cx, cy] = cellCenter(r, c);
        // Sweep fade rolls from top to bottom
        const fade = board.state === "sweeping"
          ? Math.max(0, 1 - Math.max(0, (sweepFrac * (ROWS + 1.5) - r)) / 1.4)
          : 1;
        // Bounce on landed pucks shortly after settle
        let scale = 1;
        const matchingFalling = board.pucks.find(p => p.settled && p.bounceT > 0 && p.targetRow === r && p.col === c);
        if (matchingFalling) {
          // brief squash/stretch settle
          const phase = matchingFalling.bounceT / 0.28; // 1→0
          scale = 1 + Math.sin((1 - phase) * Math.PI) * 0.06;
        }
        drawPuck(cx, cy, v, 0.20 * fade, scale);
      }
    }
    // Falling pucks: motion trail + main disc
    for (const p of board.pucks) {
      if (p.settled) continue;
      const cx = p.col * cellW + cellW / 2;
      // Trail
      for (let i = 0; i < p.trail.length; i++) {
        const trailAlpha = 0.18 * ((i + 1) / p.trail.length) * 0.5;
        drawPuck(cx, p.trail[i], p.player, trailAlpha, 0.92);
      }
      drawPuck(cx, p.y, p.player, 0.28, 1);
    }
    // 4-in-a-row glow — subtle: a gentle pulse on the four pucks, no halo / line / sparkles.
    for (const line of board.glowingLines) {
      const remaining = line.until - t;
      if (remaining <= 0) continue;
      const pulse = 0.55 + 0.35 * Math.sin(t * 0.006);
      const a = Math.min(1, remaining / 600) * pulse * 0.18;
      const colHex = line.color === 1 ? RED : BLUE;
      for (const [r, c] of line.cells) {
        const [cx, cy] = cellCenter(r, c);
        ctx.fillStyle = hexAlpha(colHex, a);
        ctx.beginPath(); ctx.arc(cx, cy, puckR * 1.15, 0, Math.PI * 2); ctx.fill();
      }
    }

    // --- Win-burst pucks ---
    if (burstPucks.length) {
      const H = window.innerHeight;
      for (const p of burstPucks) {
        p.vy += p.ay * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.spin += p.spinRate * dt;
        drawPuck(p.x, p.y, p.player, p.alpha, p.r / puckR);
      }
      for (let i = burstPucks.length - 1; i >= 0; i--) {
        if (burstPucks[i].y - burstPucks[i].r > H + 40) burstPucks.splice(i, 1);
      }
    }

    requestAnimationFrame(tick);
  }

  resize();
  requestAnimationFrame((t) => { lastT = t; tick(t); });
}
