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

  // Modes the background cycles through after each full-board kick.
  const MODES = ["classic", "diagonal", "rotate"];
  let modeIdx = 0;
  // For "rotate" mode: gravity rotates clockwise (down → left → up → right) every N spawns.
  const GRAVITY_VECTORS = [
    { dr:  1, dc:  0, name: "down"  },
    { dr:  0, dc: -1, name: "left"  },
    { dr: -1, dc:  0, name: "up"    },
    { dr:  0, dc:  1, name: "right" },
  ];
  let gravityIdx = 0;
  let gravitySpawnCount = 0;
  const GRAVITY_ROTATE_INTERVAL = 5;

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

  // Common helper: spawn a puck that enters at `entryR, entryC`, slides along
  // (dr, dc) until it hits a wall or an occupied cell, and lands there.
  // Returns true if spawned.
  function spawnSliding(entryR, entryC, dr, dc) {
    if (entryR < 0 || entryR >= ROWS || entryC < 0 || entryC >= COLS) return false;
    if (board.grid[entryR][entryC] !== 0) return false;
    // Slide to find the landing cell.
    let tr = entryR, tc = entryC;
    while (true) {
      const nr = tr + dr, nc = tc + dc;
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) break;
      if (board.grid[nr][nc] !== 0) break;
      tr = nr; tc = nc;
    }
    // Don't spawn if any in-flight puck is heading to the same target cell or
    // shares the same entry line under the same direction (avoids overlaps).
    const sameTarget = board.pucks.some(p => !p.settled && p.targetRow === tr && p.targetCol === tc);
    if (sameTarget) return false;
    const sameEntry = board.pucks.some(p => !p.settled
      && p.entryRow === entryR && p.entryCol === entryC
      && p.dirR === dr && p.dirC === dc);
    if (sameEntry) return false;
    const player = Math.random() < 0.5 ? 1 : 2;
    const speed = cellH * 0.77;
    // Pixel-space velocity from cell-space direction (cellH ≈ cellW for full-viewport board, close enough).
    const stepW = (dc === 0 ? cellH : cellW);
    const stepH = (dr === 0 ? cellW : cellH);
    const lenCells = Math.hypot(dr, dc) || 1;
    const vx = (dc / lenCells) * speed;
    const vy = (dr / lenCells) * speed;
    // Start well outside the entry along the negative direction so even short
    // slides (e.g., pieces that land at the entry cell itself) have visible
    // motion instead of looking like they teleport into place.
    const startX = (entryC + 0.5) * cellW - (dc / lenCells) * Math.max(cellW, cellH) * 2.0;
    const startY = (entryR + 0.5) * cellH - (dr / lenCells) * Math.max(cellW, cellH) * 2.0;
    board.pucks.push({
      x: startX, y: startY,
      vx, vy,
      targetCol: tc, targetRow: tr,
      targetX: (tc + 0.5) * cellW,
      targetY: (tr + 0.5) * cellH,
      entryRow: entryR, entryCol: entryC,
      dirR: dr, dirC: dc,
      player,
      settled: false,
    });
    return true;
  }

  function spawnPuck() {
    const mode = MODES[modeIdx];
    if (mode === "classic") {
      // Drop from top of a random open column; gravity (+1, 0).
      const cols = [];
      for (let c = 0; c < COLS; c++) if (board.grid[0][c] === 0) cols.push(c);
      if (!cols.length) return;
      const c = cols[Math.floor(Math.random() * cols.length)];
      spawnSliding(0, c, 1, 0);
    } else if (mode === "diagonal") {
      // Drop from top edge OR left edge; gravity (+1, +1).
      const entries = [];
      for (let c = 0; c < COLS; c++) if (board.grid[0][c] === 0) entries.push([0, c]);
      for (let r = 0; r < ROWS; r++) if (board.grid[r][0] === 0) entries.push([r, 0]);
      if (!entries.length) return;
      const [r, c] = entries[Math.floor(Math.random() * entries.length)];
      spawnSliding(r, c, 1, 1);
    } else if (mode === "rotate") {
      const g = GRAVITY_VECTORS[gravityIdx];
      // Drop from the edge OPPOSITE to gravity direction.
      const entries = [];
      if (g.dr === 1) for (let c = 0; c < COLS; c++) { if (board.grid[0][c] === 0) entries.push([0, c]); }
      else if (g.dr === -1) for (let c = 0; c < COLS; c++) { if (board.grid[ROWS-1][c] === 0) entries.push([ROWS-1, c]); }
      else if (g.dc === 1) for (let r = 0; r < ROWS; r++) { if (board.grid[r][0] === 0) entries.push([r, 0]); }
      else if (g.dc === -1) for (let r = 0; r < ROWS; r++) { if (board.grid[r][COLS-1] === 0) entries.push([r, COLS-1]); }
      if (!entries.length) return;
      const [r, c] = entries[Math.floor(Math.random() * entries.length)];
      if (spawnSliding(r, c, g.dr, g.dc)) {
        gravitySpawnCount++;
        if (gravitySpawnCount % GRAVITY_ROTATE_INTERVAL === 0) {
          gravityIdx = (gravityIdx + 1) % 4;
        }
      }
    }
  }

  function cellCenter(r, c) {
    return [c * cellW + cellW / 2, r * cellH + cellH / 2];
  }

  // ---------- Drawing helpers ----------
  // Flat pieces — no gradient, no glossy highlight, no visible empty cells.
  function drawPuck(cx, cy, player, alpha = 0.32, scale = 1) {
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

  // ---------- Kick: every settled puck flies out of the scene ----------
  // Used both by the natural full-board cycle and by game-win celebrations.
  const burstPucks = [];
  function kickBoardPieces() {
    const W = window.innerWidth, H = window.innerHeight;
    const cxScene = W / 2, cyScene = H * 0.55;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v = board.grid[r][c]; if (!v) continue;
        const [px, py] = cellCenter(r, c);
        const dx = px - cxScene, dy = py - cyScene;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const outX = dx / dist, outY = dy / dist;
        const speed = 380 + Math.random() * 320;
        burstPucks.push({
          x: px, y: py,
          vx: outX * speed + (Math.random() - 0.5) * 220,
          vy: outY * speed * 0.4 - (380 + Math.random() * 280),  // strong upward bias
          ay: 980,
          r: puckR,
          player: v,
          alpha: 0.32,
          spin: 0,
          spinRate: (Math.random() - 0.5) * 14,
        });
      }
    }
    board.grid = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    board.pucks = [];
  }
  // Game-win celebration: same kick + a 1.8s pause before the bg refills.
  window.bgBurst = function (_winner) {
    kickBoardPieces();
    board.glowingLines = [];
    board.state = "filling";
    board.nextSpawnAt = performance.now() + 1800;
  };

  // ---------- Main loop ----------
  let lastT = performance.now();
  function tick(t) {
    const dt = Math.min(50, t - lastT) / 1000;
    lastT = t;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // --- Update board ---
    if (board.state === "filling" && t > board.nextSpawnAt) {
      const inFlight = board.pucks.filter(p => !p.settled).length;
      if (inFlight < 2) spawnPuck();
      board.nextSpawnAt = t + 950 + Math.random() * 800;
    }

    for (const p of board.pucks) {
      if (p.settled) continue;
      // Gentle constant velocity along (vx, vy); arrival detected when the
      // remaining-distance vector has dot product ≤ 0 with the velocity
      // (i.e., we've passed the target along the motion axis).
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const rx = p.targetX - p.x, ry = p.targetY - p.y;
      const dot = rx * p.vx + ry * p.vy;
      if (dot <= 0) {
        p.x = p.targetX; p.y = p.targetY;
        p.settled = true;
        if (board.grid[p.targetRow][p.targetCol] === 0) {
          board.grid[p.targetRow][p.targetCol] = p.player;
        }
      }
    }

    // Transition: full → brief glow → KICK → empty → refill.
    // The fade-sweep is gone; instead the board "wins" by being full and then
    // all the pucks get kicked out of the scene.
    if (board.state === "filling" && isFull(board.grid)) {
      const lines = findWinningLines(board.grid);
      board.glowingLines = lines.map(l => ({ ...l, until: t + 900, born: t }));
      board.state = "glowing";
      board.sweepStart = t + 900;
    }
    if (board.state === "glowing" && t >= board.sweepStart) {
      kickBoardPieces();
      board.glowingLines = [];
      board.state = "filling";
      // 6-second pause before the next round starts, AND the variant cycles.
      board.nextSpawnAt = t + 6000;
      modeIdx = (modeIdx + 1) % MODES.length;
      gravityIdx = 0;
      gravitySpawnCount = 0;
    }

    // --- Draw board ---
    // Settled pucks — flat, no fade. Pieces leave via the kick, not a sweep.
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v = board.grid[r][c]; if (!v) continue;
        const [cx, cy] = cellCenter(r, c);
        drawPuck(cx, cy, v, 0.32, 1);
      }
    }
    // Falling pucks — single disc, no trail.
    for (const p of board.pucks) {
      if (p.settled) continue;
      drawPuck(p.x, p.y, p.player, 0.32, 1);
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
