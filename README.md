# Connect 4 Arena — vs. Claude Opus 4.7

Play twisted Connect 4 variants against Claude Opus 4.7 with extended thinking **visible in a side panel as Claude reasons**.

Variants:
- **Classic Connect 4** — baseline.
- **Diagonal Gravity** — drop from the top edge or the left edge; pieces slide down-and-right until they hit something.
- **Gravity Flip** — gravity direction rotates clockwise every N moves; all pieces re-settle when it flips.
- **Custom Rules** — write your own rules in plain English. Claude is both the rules engine and the opponent.

## Architecture

- `public/` — static site (HTML/CSS/JS, no build step).
- `api/move.js` — Vercel **Edge** serverless function that proxies a streaming Anthropic API call. Your API key lives only as a server-side environment variable; it's never sent to the browser.
- The browser parses the upstream SSE stream and renders `thinking_delta` events live into the thinking panel.

## Deploy (Vercel)

1. Push this repo to GitHub (already done if you're reading this on github.com).
2. Go to <https://vercel.com/new> and **Import** the repo.
3. In the project's **Settings → Environment Variables**, add:

   ```
   ANTHROPIC_API_KEY = sk-ant-api03-...
   ```

   Apply to Production, Preview, and Development.
4. Click **Deploy**. Vercel autodetects the static frontend + the `api/` function — no build config needed.
5. Visit the assigned URL.

> Anyone with the URL will be able to play, and every move will spend tokens against your key. If you want to lock it down, add Vercel Password Protection (Pro plan) or put a passcode check in `api/move.js`.

## Local dev

```bash
npm i -g vercel        # only needed once
vercel link             # connect to your Vercel project
vercel env pull .env.local
vercel dev
```

Then open <http://localhost:3000>.

## Notes on the model

- Model: `claude-opus-4-7`.
- Extended thinking is **enabled** with a budget you can adjust in the UI (1024–20000 tokens).
- The server proxies the upstream SSE stream verbatim, so thinking blocks stream live.
- For the custom-rules variant, Claude is asked to return the full new board state — accuracy depends on how clearly you describe your rules.
