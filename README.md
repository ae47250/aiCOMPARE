# Note Extraction Bench

Compare how different LLMs extract structured fields from messy, unstructured job notes.

Paste a note, pick models, hit run. Each model gets the same note and the same instructions, and the results land side by side in a matrix so you can see exactly which models dropped which fields.

---

## What's in this repo

```
aiCOMPARE/
├── index.html          The whole app. No build step, no dependencies.
├── api/
│   └── extract.js      Serverless function. Holds your API keys, calls the models.
├── vercel.json         Tells Vercel the function may run up to 60s.
├── package.json        Declares Node 20+. No dependencies to install.
├── .gitignore          Keeps secrets and junk out of git.
└── .env.example        Template for local testing. Never commit the real one.
```

---

## Two modes

**Demo** (default) — built-in example data. Nothing is called, nothing is billed. Open `index.html` directly in a browser and it works. Use this to check layout and behaviour.

**Live** — flip the *Live API* switch. Each selected model becomes one real, billed API call through your own backend.

The switch matters: with 26 models selected, one click is 26 API calls. The app confirms before letting you do that.

---

## Deploying

### 1. Put the files in your folder

Everything in this repo goes in `C:\Users\eiriksson\Documents\aiCOMPARE`, keeping the `api/` subfolder structure. Vercel finds serverless functions by looking for a folder literally named `api`, so the name and location matter.

### 2. Make it a git repo

```bash
cd C:\Users\eiriksson\Documents\aiCOMPARE
git init
git add .
git commit -m "Note Extraction Bench"
```

### 3. Create an empty repo on github.com

Name it `aiCOMPARE`. Do **not** tick "add a README" — the repo must be empty or the first push will conflict.

### 4. Push

```bash
git remote add origin https://github.com/YOURNAME/aiCOMPARE.git
git branch -M main
git push -u origin main
```

### 5. Import into Vercel

vercel.com → **Add New → Project → Import Git Repository** → pick `aiCOMPARE`.

Leave every build setting blank. Framework Preset: **Other**. There is nothing to build.

### 6. Add your keys

Vercel → your project → **Settings → Environment Variables**. Add only the providers you actually plan to call:

| Variable | Needed for |
|---|---|
| `OPENAI_API_KEY` | all GPT models, o4-mini |
| `ANTHROPIC_API_KEY` | Sonnet, Opus, Haiku, Fable |
| `GOOGLE_API_KEY` | Gemini |
| `XAI_API_KEY` | Grok |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `MOONSHOT_API_KEY` | Kimi |
| `ZHIPU_API_KEY` | GLM |
| `DASHSCOPE_API_KEY` | Qwen |

Redeploy after adding them (Deployments → ⋯ → Redeploy). Environment variables are only read at deploy time.

### 7. Every later change

```bash
git add .
git commit -m "what changed"
git push
```

Vercel redeploys automatically.

---

## How a run actually works

1. You click **Run extraction**.
2. The page builds the payload: your note, a separator, then the field list with a one-line description of each. That exact text is visible at the bottom of the results screen — what you see is what the models get.
3. For each selected model the page sends one POST to `/api/extract` with the payload, a model ID, and the effort setting. **All of them go out at once.**
4. Vercel runs `api/extract.js` once per request. It reads the matching key from the environment, picks the right adapter, and calls the provider.
5. Each response is parsed into the 13 fields and sent back with token counts and latency.
6. The matrix updates as each model lands, so you watch results fill in rather than staring at a spinner.
7. When all have returned, consensus scoring runs **in the browser** — the backend never sees the scores.

### Why one model per request

Two reasons. Vercel functions time out, and 26 sequential model calls would blow well past even the 60-second ceiling. And a single slow or broken model would hold up everything else. This way each call fails or succeeds on its own, and one dead provider costs you one greyed-out column instead of the whole run.

---

## What the backend handles for you

**Structured output, per provider.** OpenAI-compatible endpoints get a strict JSON schema. Anthropic gets a forced tool call, which is more reliable than asking for raw JSON and sidesteps the trailing-comma failure mode. Google gets `responseSchema`.

**The two documented failure modes.** ExtractBench found that 40% of extraction failures are empty responses and 30% are trailing commas before a closing brace. The parser strips code fences, finds the outermost braces, removes trailing commas, and coerces `""` and `"null"` to real nulls. A model that returns unparseable output is marked **bad JSON** rather than silently scoring zero.

**An allowlist.** The endpoint only accepts model IDs in its own registry. Without that, a public URL that forwards arbitrary model names to your billed API keys is an open proxy.

---

## Costs and safety

Every live run bills you. A 5-model run on a short note is a fraction of a cent; 26 models across 100 notes is real money. Before you leave this deployed:

- **Set a spend cap** on each provider dashboard. This is the one that actually protects you.
- **Turn on Vercel Deployment Protection** (Settings → Deployment Protection) if you don't want the URL public. Otherwise anyone who finds it can spend your credits.
- **Keep keys out of git.** They live only in Vercel's environment variables. `.gitignore` already blocks `.env*` as a second line of defence.

---

## bench_log.csv

The results screen has a **Download bench_log.csv** button. It writes the 25-column schema from `SETUP.md`: timestamp, note ID, model, effort, all 13 extracted fields, scores, token counts, cost, latency, and scoring method.

The `scoring_method` column records `consensus` for live runs and `consensus_demo` for demo data, so runs from the two modes never get mixed up in analysis.

Note that consensus scoring measures whether models *agree*, not whether they are *right*. Five models can agree on the same wrong phone number. Ground-truth scoring against notes with known answers is the real answer, and it is the natural next step.

---

## Local testing with live calls

```bash
npm i -g vercel
cp .env.example .env.local     # paste your real keys into .env.local
vercel dev
```

Opens on `localhost:3000` with the backend running. `.env.local` is gitignored.

Opening `index.html` by double-clicking also works, but only in demo mode — there is no backend for the page to call.

---

## Adding a model

Three places, all of which must agree:

1. `api/extract.js` → add to `MODELS` with its provider and real API ID.
2. `index.html` → add a row to the `M` catalogue (name, family, tier, prices, effort flag, site, rationale).
3. `index.html` → add the name → ID mapping in `API_ID`.

If a name is in the catalogue but missing from `API_ID`, live mode fails for that model with "Unknown model". Demo mode still works, which makes this an easy mistake to miss.

---

## Known limitations

- **Effort parameter shapes are best-effort.** Each vendor spells this differently and they change it. All three shapes sit in one place per adapter in `extract.js`, so they are quick to correct.
- **No retries.** A rate-limited model shows as an error. Re-run it.
- **No persistence.** Refresh and the run is gone. Export the CSV first.
- **Prices are hardcoded** in `index.html`, verified 18 July 2026. They drift. Cost figures are estimates from token counts, not billing data.
