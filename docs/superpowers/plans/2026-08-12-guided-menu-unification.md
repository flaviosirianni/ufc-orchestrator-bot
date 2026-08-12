# Guided Menu Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace keyword-guessed intent routing in `guided_strict` mode with button-only, session-state-driven routing, thread `fight_id` through action buttons so ledger actions carry fight context automatically, split event projections into one message per fight, and fix `current_event` picking up non-UFC fights.

**Architecture:** `telegramBot.js` owns a per-chat session state (`guidedActionByChat`) that today stores just an action string; it grows to store `{action, fightContext, setAt}`. `resolveGuidedMessageDecision` stops re-deriving intent from message text via keyword regexes and instead trusts that state directly, falling back to "show the menu" when the state is absent or older than 45 minutes. New callback patterns (`qa:record_bet_for:<fightId>`, `qa:analyze_quotes_for:<fightId>`) write `fightContext` into that same state. `bettingWizard.js` reads `fightContext` (passed through `routerChain.js`) to skip asking the user which fight they mean, and gains the ability to return multiple Telegram messages (one per fight) instead of one combined block, via a new additive `replies[]` return shape that `routerChain.js` and `telegramBot.js` learn to handle without touching the existing single-`reply` path.

**Tech Stack:** Node.js (ES modules), `node-telegram-bot-api`, hand-rolled test harness (`node __tests__/runTests.js`, `node:assert/strict`, no jest/mocha).

**Spec:** `docs/superpowers/specs/2026-08-12-guided-menu-unification-design.md`

---

## File Structure

| File | Responsibility in this plan |
|---|---|
| `src/core/telegramBot.js` | Session state shape, `resolveGuidedMessageDecision`, callback dispatch for new buttons, `isGuidedCallbackAllowed`, `sendBotMessage`/`deliverToRouter` multi-message handling |
| `src/core/routerChain.js` | Pass `fightContext` metadata through to `bettingWizard.handleMessage`; pass through a `replies[]` array when present |
| `src/agents/bettingWizard.js` | Use `fightContext` to skip fight resolution; per-fight projection messages with buttons; UFC-only filter for live-event detection |
| `__tests__/telegramBot.test.js` | Existing file — add cases for the new routing/callback behavior |
| `__tests__/bettingWizard.test.js` | Existing file — add cases for `fightContext` usage and multi-message projections |
| `__tests__/routerChain.test.js` | Existing file — add case for `replies[]` pass-through |

No new files. All three touched files already exist and already have test files with the established hand-rolled-assert pattern (see any existing `tests.push(async () => {...})` block in `__tests__/bettingWizard.test.js` for the convention).

---

## Task Group 1 — Kill the keyword cascade, make routing state-driven

### Task 1: Session state carries a timestamp

**Files:**
- Modify: `src/core/telegramBot.js:1741-1770` (`getGuidedAction`, `setGuidedAction`)
- Test: `__tests__/telegramBot.test.js`

- [ ] **Step 1: Read the current implementation to confirm exact context**

The current functions (for reference, do not copy — you will replace them in Step 3):

```js
function getGuidedAction(chatId) {
  const key = String(chatId || '').trim();
  if (!key) return defaultGuidedAction;
  const current = normalizeGuidedAction(guidedActionByChat.get(key) || defaultGuidedAction, {
    defaultAction: defaultGuidedAction,
  });
  if (!guidedLedgerEnabled && (current === 'record_bet' || current === 'settle_bet')) {
    return defaultGuidedAction;
  }
  return current;
}

function setGuidedAction(chatId, action = defaultGuidedAction) {
  const key = String(chatId || '').trim();
  if (!key) return defaultGuidedAction;
  let normalized = normalizeGuidedAction(action, { defaultAction: defaultGuidedAction });
  if (!guidedLedgerEnabled && (normalized === 'record_bet' || normalized === 'settle_bet')) {
    normalized = defaultGuidedAction;
  }
  guidedActionByChat.set(key, normalized);
  return normalized;
}
```

`guidedActionByChat` is declared earlier in the same closure as `new Map()` — find it with `grep -n "guidedActionByChat" src/core/telegramBot.js` (it will show the `const guidedActionByChat = new Map();` declaration plus these two usages before your edit).

- [ ] **Step 2: Write the failing test**

Add to `__tests__/telegramBot.test.js` (check the top of the file for how `createTelegramBot`/exported helpers are imported — follow that exact import style; the functions under test here are exported at module level: confirm with `grep -n "^export function getGuidedActionState\|^export function isGuidedActionFresh" src/core/telegramBot.js`, which will fail until Step 3 exports them):

```js
tests.push(() => {
  const chatId = 'chat-guided-state-fresh-1';
  const before = Date.now();
  const state = setGuidedActionState(chatId, 'record_bet');
  const after = Date.now();

  assert.equal(state.action, 'record_bet');
  assert.ok(state.setAt >= before && state.setAt <= after, 'setAt debe ser el timestamp del set');
  assert.equal(isGuidedActionFresh(chatId, { maxAgeMs: 45 * 60 * 1000 }), true);
});

tests.push(() => {
  const chatId = 'chat-guided-state-stale-1';
  setGuidedActionState(chatId, 'record_bet');
  const state = getGuidedActionState(chatId);
  state.setAt = Date.now() - 46 * 60 * 1000; // simulate 46 minutes of inactivity

  assert.equal(isGuidedActionFresh(chatId, { maxAgeMs: 45 * 60 * 1000 }), false);
});

tests.push(() => {
  assert.equal(isGuidedActionFresh('chat-never-set-1', { maxAgeMs: 45 * 60 * 1000 }), false);
});
```

(Place these `tests.push` calls in whatever array-collection pattern the rest of `__tests__/telegramBot.test.js` already uses — read the file's existing structure first with `grep -n "tests.push\|export async function run" __tests__/telegramBot.test.js | head -5` and match it exactly, including how the file exports its test-runner function and how `assert` is imported.)

- [ ] **Step 2b: Run test to verify it fails**

Run: `node __tests__/telegramBot.test.js`
Expected: FAIL — `setGuidedActionState is not defined` (or import error), since these functions don't exist yet.

- [ ] **Step 3: Implement**

Replace the `getGuidedAction`/`setGuidedAction` pair with:

```js
function getGuidedActionState(chatId) {
  const key = String(chatId || '').trim();
  if (!key) return null;
  return guidedActionByChat.get(key) || null;
}

function isGuidedActionFresh(chatId, { maxAgeMs = GUIDED_ACTION_MAX_AGE_MS } = {}) {
  const state = getGuidedActionState(chatId);
  if (!state || !Number.isFinite(state.setAt)) return false;
  return Date.now() - state.setAt <= maxAgeMs;
}

function setGuidedActionState(chatId, action = defaultGuidedAction, fightContext = null) {
  const key = String(chatId || '').trim();
  if (!key) return { action: defaultGuidedAction, fightContext: null, setAt: Date.now() };
  let normalized = normalizeGuidedAction(action, { defaultAction: defaultGuidedAction });
  if (!guidedLedgerEnabled && (normalized === 'record_bet' || normalized === 'settle_bet')) {
    normalized = defaultGuidedAction;
  }
  const state = { action: normalized, fightContext: fightContext || null, setAt: Date.now() };
  guidedActionByChat.set(key, state);
  return state;
}

function getGuidedAction(chatId) {
  return getGuidedActionState(chatId)?.action || defaultGuidedAction;
}

function setGuidedAction(chatId, action = defaultGuidedAction) {
  return setGuidedActionState(chatId, action).action;
}
```

Add near the other module-level constants (next to `GUIDED_QUOTES_TEXT_FALLBACK`, around line 62):

```js
const GUIDED_ACTION_MAX_AGE_MS = Number(process.env.GUIDED_ACTION_MAX_AGE_MS ?? String(45 * 60 * 1000));
```

Add `export` in front of `function getGuidedActionState`, `function isGuidedActionFresh`, and `function setGuidedActionState` (the two-arg `getGuidedAction`/`setGuidedAction` stay as-is — internal callers throughout the file keep working unchanged since their signatures didn't change).

- [ ] **Step 4: Run test to verify it passes**

Run: `node __tests__/telegramBot.test.js`
Expected: PASS, all three new assertions green, no other test in the file broken (existing callers of `getGuidedAction`/`setGuidedAction` still get a plain action string back).

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: `All test suites passed.`

- [ ] **Step 6: Commit**

```bash
git add src/core/telegramBot.js __tests__/telegramBot.test.js
git commit -m "feat(ufc): track guided-action state with a timestamp for staleness checks"
```

---

### Task 2: `resolveGuidedMessageDecision` stops guessing from text

**Files:**
- Modify: `src/core/telegramBot.js:936-994` (`resolveGuidedMessageDecision`)
- Test: `__tests__/telegramBot.test.js`

- [ ] **Step 1: Write the failing tests — the exact regression from the incident**

```js
tests.push(() => {
  // The exact production incident (2026-08-12 session): "le puse $2000 a Hooper por
  // Sumisión @2.40" with an active record_bet state must route as record_bet, not get
  // reclassified as analyze_quotes by an odds-shaped regex.
  const decision = resolveGuidedMessageDecision({
    cleanMessage: 'le puse $2000 a Hooper por Sumisión @2.40',
    hasMedia: false,
    activeGuidedActionState: { action: 'record_bet', fightContext: null, setAt: Date.now() },
    guidedMenuId: 'ufc_v1',
  });

  assert.equal(decision.action, 'route');
  assert.equal(decision.guidedAction, 'record_bet');
});

tests.push(() => {
  // Same message, but the active state is analyze_quotes: must stay analyze_quotes.
  // Proves intent comes from state, never from text content.
  const decision = resolveGuidedMessageDecision({
    cleanMessage: 'le puse $2000 a Hooper por Sumisión @2.40',
    hasMedia: false,
    activeGuidedActionState: { action: 'analyze_quotes', fightContext: null, setAt: Date.now() },
    guidedMenuId: 'ufc_v1',
  });

  assert.equal(decision.guidedAction, 'analyze_quotes');
});

tests.push(() => {
  // No active state at all: block (show menu), never guess.
  const decision = resolveGuidedMessageDecision({
    cleanMessage: 'le puse $2000 a Hooper por Sumisión @2.40',
    hasMedia: false,
    activeGuidedActionState: null,
    guidedMenuId: 'ufc_v1',
  });

  assert.equal(decision.action, 'block');
});

tests.push(() => {
  // Active state exists but is stale (46 min old): block (show menu), don't reuse it.
  const decision = resolveGuidedMessageDecision({
    cleanMessage: 'le puse $2000 a Hooper por Sumisión @2.40',
    hasMedia: false,
    activeGuidedActionState: { action: 'record_bet', fightContext: null, setAt: Date.now() - 46 * 60 * 1000 },
    guidedMenuId: 'ufc_v1',
  });

  assert.equal(decision.action, 'block');
});

tests.push(() => {
  // Media (photo) always routes with whatever the active state is, regardless of freshness
  // rules for text -- unchanged from today's behavior, still exercised here as a regression
  // guard since this function is being rewritten.
  const decision = resolveGuidedMessageDecision({
    cleanMessage: '',
    hasMedia: true,
    activeGuidedActionState: { action: 'analyze_quotes', fightContext: null, setAt: Date.now() - 46 * 60 * 1000 },
    guidedMenuId: 'ufc_v1',
  });

  assert.equal(decision.action, 'route');
  assert.equal(decision.guidedAction, 'analyze_quotes');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node __tests__/telegramBot.test.js`
Expected: FAIL on the first new assertion or on an unexpected-shape error, since `resolveGuidedMessageDecision` doesn't yet accept `activeGuidedActionState`.

- [ ] **Step 3: Implement**

Replace the whole function body (lines 936-994) with:

```js
export function resolveGuidedMessageDecision({
  hasMedia = false,
  activeGuidedActionState = null,
  guidedMenuId = 'ufc_v1',
} = {}) {
  const menuId = normalizeGuidedMenuId(guidedMenuId);
  if (menuId === 'nutrition_v1') {
    return resolveNutritionGuidedMessageDecision({
      cleanMessage: '',
      hasMedia,
      activeGuidedAction: activeGuidedActionState?.action,
    });
  }

  if (!activeGuidedActionState) {
    return { action: 'block', guidedAction: null, inputType: null };
  }

  const fresh = hasMedia || isGuidedActionFreshState(activeGuidedActionState);
  if (!fresh) {
    return { action: 'block', guidedAction: null, inputType: null };
  }

  const guidedAction = normalizeGuidedAction(activeGuidedActionState.action, {
    defaultAction: 'analyze_quotes',
  });
  return {
    action: 'route',
    guidedAction,
    inputType: hasMedia ? 'image' : 'text',
    fightContext: activeGuidedActionState.fightContext || null,
  };
}
```

Add this small pure helper right above it (kept separate from `isGuidedActionFresh` because that one reads from `guidedActionByChat` by `chatId`, while this one checks a state object directly — the function under test above passes a raw state object, matching how `resolveGuidedMessageDecision` will be called from `deliverToRouter`/`flushMediaGroup` after Task 3):

```js
function isGuidedActionFreshState(state, { maxAgeMs = GUIDED_ACTION_MAX_AGE_MS } = {}) {
  if (!state || !Number.isFinite(state.setAt)) return false;
  return Date.now() - state.setAt <= maxAgeMs;
}
```

Note the Nutrition branch (`resolveNutritionGuidedMessageDecision`) is untouched by this plan — it keeps its own existing text-based logic; only the UFC (`ufc_v1`) path changes. Do not modify `resolveNutritionGuidedMessageDecision`.

Now delete these three now-unused functions entirely (confirmed zero other callers in the codebase — verify yourself before deleting with `grep -rn "looksLikeStructuredOddsText\|looksLikeStructuredBetRecordText\|looksLikeStructuredBetSettleText" src __tests__`, which should only show their own definitions after your edit):
- `looksLikeStructuredOddsText` (was exported, line ~909)
- `looksLikeStructuredBetRecordText` (line ~1128)
- `looksLikeStructuredBetSettleText` (line ~1145)

Also delete the now-unused `GUIDED_QUOTES_TEXT_FALLBACK` constant (line 62) and the `guidedQuotesTextFallback` variable that reads it (search `grep -n "guidedQuotesTextFallback" src/core/telegramBot.js` — it will show the constant read and its two usages, both of which you'll also touch in Task 3).

- [ ] **Step 4: Run test to verify it passes**

Run: `node __tests__/telegramBot.test.js`
Expected: PASS on all five new assertions.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: `All test suites passed.` (This step will actually fail until Task 3 updates the two call sites, since they still call the old signature — if so, proceed to Task 3 before committing; do not commit a broken suite.)

- [ ] **Step 6: Commit** (only after Task 3 is also done and the suite is green — see Task 3 Step 5)

---

### Task 3: Update both call sites to use the new state shape

**Files:**
- Modify: `src/core/telegramBot.js:2281-2320` (`processSingleMessage`'s guided branch)
- Modify: `src/core/telegramBot.js:2393-2410+` (`flushMediaGroup`'s guided branch — read the full block first with `sed -n '2393,2430p' src/core/telegramBot.js`, it mirrors the first one)
- Modify: every `if (data === 'qa:record_bet') ... setGuidedAction(chatId, 'record_bet') ...`-style callback handler that currently calls the two-arg `setGuidedAction` — these keep working unchanged (Task 1 kept `setGuidedAction(chatId, action)` as a thin wrapper), no edits needed there.
- Test: `__tests__/telegramBot.test.js`

- [ ] **Step 1: Write the failing test — no active state shows the main menu, not a hint**

```js
tests.push(async () => {
  const sentMessages = [];
  const fakeBot = createFakeTelegramBotForGuidedRoutingTest({ sentMessages });
  // See helper below -- construct it once in this test file and reuse.

  await fakeBot.simulateIncomingText({ chatId: 'chat-cold-start-1', text: 'aposte a fulano' });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Men[uú] principal|📚|🧾 Ledger|📰 Evento/i);
});
```

Given this needs a realistic fake of the bot's message pipeline (Telegram SDK, `sendBotMessage`, `sendMenu`), and the existing `__tests__/telegramBot.test.js` almost certainly already has a harness for simulating incoming messages (grep for it before writing new scaffolding): run `grep -n "function createFakeTelegramBotForGuidedRoutingTest\|function createFakeBot\|createTelegramBot(" __tests__/telegramBot.test.js | head -10` first. If a compatible fake/harness already exists, reuse it exactly as the surrounding tests do instead of inventing `createFakeTelegramBotForGuidedRoutingTest` — adapt this test's body to whatever that existing harness's API is, keeping the same assertion: with no prior `setGuidedActionState` call for the chat, sending free text results in the main menu being shown, not a "reencauce" hint and not a wizard response.

- [ ] **Step 2: Run test to verify it fails**

Run: `node __tests__/telegramBot.test.js`
Expected: FAIL — either the fake harness needs adapting (fix the test to match the real harness API, re-run), or once adapted, it fails because the call sites still pass the old `activeGuidedAction`/`allowTextFallback` shape.

- [ ] **Step 3: Implement — `processSingleMessage`'s guided branch**

Replace lines 2281-2320 with:

```js
    if (isGuidedStrictInteractionMode(interactionMode)) {
      const activeGuidedActionState = getGuidedActionState(chatId);
      const decision = resolveGuidedMessageDecision({
        hasMedia: inputItems.length > 0,
        activeGuidedActionState,
        guidedMenuId,
      });

      if (decision.action !== 'route') {
        if (guidedMenuId === 'ufc_v1' || guidedMenuId === 'ufc_default' || guidedMenuId === 'default') {
          setGuidedActionState(chatId, defaultGuidedAction);
          await sendMenu(chatId, 'main');
        } else {
          const fallbackAction = activeGuidedActionState?.action || defaultGuidedAction;
          await sendBotMessage(
            chatId,
            resolveGuidedBlockHintByAction(fallbackAction, { guidedMenuId }),
            { menuScope: guidedMenuScopeForAction(fallbackAction, { guidedMenuId }) }
          );
        }
        return;
      }

      if (guidedMenuId === 'nutrition_v1' && decision.guidedAction) {
        setGuidedAction(chatId, decision.guidedAction);
      }

      const shouldResetFeedbackMode =
        guidedMenuId === 'nutrition_v1' &&
        isOneShotNutritionFeedbackAction(decision.guidedAction);
      await deliverToRouter({
        msg,
        userMessage,
        inputItems,
        mediaStats,
        guidedAction: decision.guidedAction,
        guidedInputType: decision.inputType,
        fightContext: decision.fightContext || null,
      });
      if (shouldResetFeedbackMode) {
        setGuidedAction(chatId, 'log_intake');
      }
      return;
    }
```

This keeps Nutrition's behavior (still text-driven via `resolveNutritionGuidedMessageDecision`, untouched) and only changes the UFC path to show the main menu instead of a hint when blocked. `cleanMessage` and `allowTextFallback` are gone from the call — remove `cleanMessage` from this block if nothing else in this function scope still needs the variable (check with `grep -n "cleanMessage" src/core/telegramBot.js` around this function; `cleanMessage` is still used earlier in the function for the `/start`/`/help` checks at lines 2261-2279, so keep the variable declaration, just stop passing it into `resolveGuidedMessageDecision`).

- [ ] **Step 4: Implement — `flushMediaGroup`'s guided branch**

Apply the identical transformation to the second call site (read it first with `sed -n '2393,2430p' src/core/telegramBot.js` to get its exact current boundaries, since line numbers will have shifted after Step 3's edit) — same replacement pattern: `getGuidedActionState(chatId)` instead of `getGuidedAction(chatId)`, drop `cleanMessage`/`allowTextFallback` from the `resolveGuidedMessageDecision` call, on block show the main menu for UFC menus, pass `fightContext: decision.fightContext || null` into `deliverToRouter`.

- [ ] **Step 5: Update `deliverToRouter` to accept and forward `fightContext`**

`deliverToRouter` (line ~2126) gains `fightContext = null` in its destructured params and forwards it into the `router.routeMessage({...})` metadata object (same object that already carries `guidedAction`, `inputType`, etc. — add `fightContext` alongside them). Full destructure line becomes:

```js
  async function deliverToRouter({
    msg,
    userMessage,
    inputItems,
    mediaStats,
    isAlbum = false,
    guidedAction = null,
    guidedInputType = null,
    fightContext = null,
  } = {}) {
```

And in the `router.routeMessage({...})` call body (around line 2172-2193), add `fightContext,` as a new property in that object literal (alongside the existing `guidedAction`, `inputType`, `guidedInputType` lines).

- [ ] **Step 6: Run test to verify it passes**

Run: `node __tests__/telegramBot.test.js`
Expected: PASS.

- [ ] **Step 7: Run full suite**

Run: `npm test`
Expected: `All test suites passed.`

- [ ] **Step 8: Commit** (this closes out Tasks 2 and 3 together, since Task 2 alone leaves the suite red)

```bash
git add src/core/telegramBot.js __tests__/telegramBot.test.js
git commit -m "fix(ufc): route guided actions from session state, never from keyword-guessed text

Fixes the confirmed production incident where 'le puse \$2000 a Hooper
por Sumisión @2.40' with an active record_bet state got silently
reclassified as analyze_quotes because the keyword list only had the
English 'submission'. The whole class of bug is removed: intent now
comes exclusively from which button was pressed (persisted session
state), never re-derived from message text. No active/fresh state
shows the main menu instead of guessing."
```

---

## Task Group 2 — Fight identity threading

### Task 4: Callback handlers for fight-scoped buttons

**Files:**
- Modify: `src/core/telegramBot.js` (`isGuidedCallbackAllowed`, the `bot.on('callback_query', ...)` handler)
- Test: `__tests__/telegramBot.test.js`

- [ ] **Step 1: Write the failing test**

```js
tests.push(() => {
  assert.equal(
    isGuidedCallbackAllowed('qa:record_bet_for:b23487230c72d1a9c46a58cf02db58cc', { ledgerEnabled: true, guidedMenuId: 'ufc_v1' }),
    true
  );
  assert.equal(
    isGuidedCallbackAllowed('qa:analyze_quotes_for:fight_1', { ledgerEnabled: true, guidedMenuId: 'ufc_v1' }),
    true
  );
  assert.equal(
    isGuidedCallbackAllowed('qa:record_bet_for:', { ledgerEnabled: true, guidedMenuId: 'ufc_v1' }),
    false,
    'un fight_id vacio no debe pasar el allowlist'
  );
  assert.equal(
    isGuidedCallbackAllowed('qa:record_bet_for:drop table bets', { ledgerEnabled: true, guidedMenuId: 'ufc_v1' }),
    false,
    'el fight_id debe ser alfanumerico, nada de texto libre en el callback_data'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node __tests__/telegramBot.test.js`
Expected: FAIL, `isGuidedCallbackAllowed` returns `false` for the two `_for:` patterns since they're not in `GUIDED_ALLOWED_CALLBACKS` and no regex covers them yet.

- [ ] **Step 3: Implement — allowlist regex**

In `isGuidedCallbackAllowed` (line ~886-907), add two lines to the existing regex-check block (which already has the `qa:med_select_patient:\d+` precedent), right before the final `return /^qa:topup_pack:\d+$/i.test(value);`:

```js
  if (/^qa:record_bet_for:[a-zA-Z0-9_]{1,64}$/.test(value)) return true;
  if (/^qa:analyze_quotes_for:[a-zA-Z0-9_]{1,64}$/.test(value)) return true;
```

- [ ] **Step 4: Implement — callback dispatch**

In the `bot.on('callback_query', ...)` handler, find the existing `if (data === 'qa:record_bet') {...}` block (search `grep -n "data === 'qa:record_bet'" src/core/telegramBot.js`, use the one inside the guided-strict UFC branch, not the `hybrid`-mode one lower in the file). Add two new `if` blocks immediately before it:

```js
      if (data.startsWith('qa:record_bet_for:')) {
        if (!guidedLedgerEnabled) {
          await sendBotMessage(chatId, 'Este bot no tiene ledger habilitado en modo guiado.', { menuScope: 'main' });
          return;
        }
        const fightId = data.slice('qa:record_bet_for:'.length);
        const fightContext = getFightContextById(fightId);
        setGuidedActionState(chatId, 'record_bet', fightContext);
        const hint = fightContext
          ? `📝 Registrando apuesta para ${fightContext.fighterA} vs ${fightContext.fighterB}.\nContame tu pick, cuota y stake (texto o el screenshot de tu ticket).`
          : QUICK_ACTION_HINTS.record_bet;
        await sendBotMessage(chatId, hint, { menuScope: 'ledger' });
        return;
      }

      if (data.startsWith('qa:analyze_quotes_for:')) {
        const fightId = data.slice('qa:analyze_quotes_for:'.length);
        const fightContext = getFightContextById(fightId);
        setGuidedActionState(chatId, 'analyze_quotes', fightContext);
        const hint = fightContext
          ? `📸 Analizando cuotas para ${fightContext.fighterA} vs ${fightContext.fighterB}.\nMandame el screenshot completo de esa pelea.`
          : QUICK_ACTION_HINTS.analyze_quotes;
        await sendBotMessage(chatId, hint, { menuScope: 'ufc_analysis' });
        return;
      }

```

`getFightContextById(fightId)` does not exist yet — Task 5 creates it. Leave this task's test file as-is for now; you will not be able to run this task's test green until Task 5 is also done, because `getFightContextById` is currently undefined and will throw. Do not skip ahead in the diff — write it exactly as above, then proceed immediately to Task 5 before attempting Step 5 below.

- [ ] **Step 5: Run test to verify it passes** (after Task 5 is complete)

Run: `node __tests__/telegramBot.test.js`
Expected: PASS.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: `All test suites passed.`

- [ ] **Step 7: Commit** (together with Task 5, see Task 5's commit step)

---

### Task 5: `getFightContextById` — resolve a fight_id to fighter names

**Files:**
- Modify: `src/core/telegramBot.js`
- Modify: `src/bots/ufc/index.js`
- Test: `__tests__/telegramBot.test.js`

**Verified ground truth (checked directly against the code in this worktree, corrects an assumption in the original plan):** `telegramBot.js` has **no store access at all** today — it imports nothing from `sqliteStore.js` and receives no `userStore`-shaped option. Its exported entry point is `export function startTelegramBot(router, options = {})` (`src/core/telegramBot.js:1536`), **not** `createTelegramBot` — there is no function by that name anywhere in this file. All data access happens indirectly through `router.routeMessage(...)`.

`src/bots/ufc/index.js` is the composition root. It already builds a `verifiedEventStoreView` (`createVerifiedEventStoreView`, defined at `src/bots/ufc/index.js:144-185`) that wraps raw `sqliteStore.getEventFightMirror`/`getEventWatchState` with the `EventTruthGate` fail-closed verification checks — `verifiedEventStoreView.getEventFightMirror(watchKey)` returns `[]` when the underlying event data isn't verified, and the same array-of-`{fightId, fighterA, fighterB, ...}` shape as the raw function otherwise. This exact object is already handed to `bettingWizard` as part of its `userStore` (`src/bots/ufc/index.js:311,316-317`: `getEventWatchState: verifiedEventStoreView.getEventWatchState`, `getEventFightMirror: verifiedEventStoreView.getEventFightMirror`). The correct fix threads the *same* verified functions into `startTelegramBot`'s `options` too, so the Telegram layer gets identical fail-closed semantics instead of a separate, unverified read path.

- [ ] **Step 1: Write the failing test**

```js
tests.push(() => {
  const fakeStore = {
    getEventWatchState(watchKey) {
      if (watchKey === 'next_event') {
        return { eventId: 'ufc_islam_makhachev_vs_ian_garry_2026-08-15', eventName: 'UFC: Islam Makhachev vs Ian Garry' };
      }
      return null;
    },
    getEventFightMirror(watchKey) {
      if (watchKey === 'next_event') {
        return [
          { fightId: 'fight_1', fighterA: 'Islam Makhachev', fighterB: 'Ian Garry' },
          { fightId: 'fight_2', fighterA: 'Mackenzie Dern', fighterB: 'Gillian Robertson' },
        ];
      }
      return [];
    },
  };

  const context = getFightContextByIdForStore(fakeStore, 'fight_2');

  assert.deepEqual(context, {
    fightId: 'fight_2',
    fighterA: 'Mackenzie Dern',
    fighterB: 'Gillian Robertson',
    eventId: 'ufc_islam_makhachev_vs_ian_garry_2026-08-15',
    eventName: 'UFC: Islam Makhachev vs Ian Garry',
  });
});

tests.push(() => {
  const fakeStore = {
    getEventWatchState() { return null; },
    getEventFightMirror() { return []; },
  };

  assert.equal(getFightContextByIdForStore(fakeStore, 'fight_1'), null);
});
```

(This tests a store-parameterized variant `getFightContextByIdForStore(store, fightId)` so it's testable without constructing the whole `telegramBot.js` closure. The real `getFightContextById(fightId)` used in Task 4 is a one-line wrapper around it using the module's injected store — see Step 3.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node __tests__/telegramBot.test.js`
Expected: FAIL — `getFightContextByIdForStore is not defined`.

- [ ] **Step 3: Implement**

Add near the other pure helpers at module level (outside the `createTelegramBot` closure, so it's independently testable and exportable):

```js
export function getFightContextByIdForStore(store, fightId) {
  const targetId = String(fightId || '').trim();
  if (!targetId || !store?.getEventFightMirror) return null;

  for (const watchKey of ['next_event', 'current_event']) {
    const fights = store.getEventFightMirror(watchKey) || [];
    const match = fights.find((fight) => String(fight?.fightId || '').trim() === targetId);
    if (!match) continue;
    const eventState = store.getEventWatchState ? store.getEventWatchState(watchKey) : null;
    return {
      fightId: targetId,
      fighterA: match.fighterA,
      fighterB: match.fighterB,
      eventId: eventState?.eventId || null,
      eventName: eventState?.eventName || null,
    };
  }
  return null;
}
```

Inside the `startTelegramBot(router, options = {})` closure, near the top where other `options.*` destructuring happens (alongside `guidedLedgerEnabled`, `guidedMenuId`, etc. around line 1545), read the two new options:

```js
  const getEventFightMirrorOption =
    typeof options.getEventFightMirror === 'function' ? options.getEventFightMirror : null;
  const getEventWatchStateOption =
    typeof options.getEventWatchState === 'function' ? options.getEventWatchState : null;
```

Then, near `getGuidedActionState` (added in Task 1), add the thin wrapper Task 4 calls:

```js
  function getFightContextById(fightId) {
    return getFightContextByIdForStore(
      { getEventFightMirror: getEventFightMirrorOption, getEventWatchState: getEventWatchStateOption },
      fightId
    );
  }
```

`getFightContextByIdForStore` only calls `store.getEventFightMirror(watchKey)`/`store.getEventWatchState(watchKey)` (see its Step 3 implementation above) — it doesn't care whether `store` is a real database object or this small shim, so no changes are needed to that function.

- [ ] **Step 4: Wire the verified event store into `startTelegramBot`'s options**

In `src/bots/ufc/index.js`, the `startTelegramBot(router, {...})` call (around line 396, after Task 1-3's edits may have shifted nearby lines slightly — find it fresh with `grep -n "startTelegramBot(router" src/bots/ufc/index.js`) currently reads:

```js
  const telegram = telegramToken
    ? startTelegramBot(router, {
        interactionMode:
          manifest?.interaction_mode || process.env.TELEGRAM_INTERACTION_MODE || 'guided_strict',
        token: telegramToken,
      })
    : createDisabledTelegramRuntime({
        botId,
        tokenEnvName,
      });
```

Add the two verified-store functions (the same `verifiedEventStoreView` instance already built at line 226 and already used for `bettingWizard`'s `userStore`, so this reuses the existing fail-closed verification instead of adding a second, separately-behaved read path):

```js
  const telegram = telegramToken
    ? startTelegramBot(router, {
        interactionMode:
          manifest?.interaction_mode || process.env.TELEGRAM_INTERACTION_MODE || 'guided_strict',
        token: telegramToken,
        getEventFightMirror: verifiedEventStoreView.getEventFightMirror,
        getEventWatchState: verifiedEventStoreView.getEventWatchState,
      })
    : createDisabledTelegramRuntime({
        botId,
        tokenEnvName,
      });
```

`verifiedEventStoreView` must already be in scope at this point in the function (it's built earlier, at line 226, before this call site) — confirm with `grep -n "verifiedEventStoreView" src/bots/ufc/index.js` that its declaration comes before line ~396; if for some reason it doesn't (e.g. line numbers shifted), move nothing else — just confirm ordering, since `const` declarations must precede use.

- [ ] **Step 5: Run test to verify it passes**

Run: `node __tests__/telegramBot.test.js`
Expected: PASS — both this task's tests and Task 4's test (now that `getFightContextById` exists).

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: `All test suites passed.`

- [ ] **Step 7: Commit**

```bash
git add src/core/telegramBot.js src/bots/ufc/index.js __tests__/telegramBot.test.js
git commit -m "feat(ufc): resolve fight_id to fighter/event context for contextual buttons

Threads the same verifiedEventStoreView already used for bettingWizard's
userStore into startTelegramBot's options, so the Telegram layer's
fight_id -> fighter/event lookup gets identical EventTruthGate
fail-closed semantics instead of a separate unverified read path."
```

---

### Task 6: `bettingWizard` consumes `fightContext` to skip asking which fight

**Files:**
- Modify: `src/agents/bettingWizard.js` (`handleMessage` entry, and the system-prompt builder around line 4700-4780 read in this session)
- Modify: `src/core/routerChain.js:157-171` (already forwards `metadata` — confirm `fightContext` flows through; see Step 1)
- Test: `__tests__/bettingWizard.test.js`

- [ ] **Step 1: Confirm the plumbing from `routerChain.js` first**

`routerChain.js`'s call to `bettingWizard.handleMessage` (line ~157-171) already spreads most of `metadata` explicitly rather than passing the whole object — re-read that call site (it was fully read earlier in this session; re-verify with `sed -n '151,172p' src/core/routerChain.js` since line numbers may have shifted from earlier tasks in other files, though this file is untouched so far). Add `fightContext: metadata?.fightContext || null,` as a new property in that object literal, alongside the existing `guidedAction`, `inputType`, etc. lines.

- [ ] **Step 2: Write the failing test**

```js
tests.push(async () => {
  const conversationStore = createConversationStore();
  const fakeClient = createSequentialFakeClient([responseWithText('no deberia ejecutarse')]);
  const recordCalls = [];

  const wizard = createBettingWizard({
    conversationStore,
    client: fakeClient,
    fightsScalper: {
      async getFighterHistory() { return { fighters: [], rows: [] }; },
    },
    userStore: {
      record_user_bet: undefined, // not a real tool export path; left here only if this store shape needs it -- verify against the real userStore tool wiring below.
    },
  });

  const result = await wizard.handleMessage('$2000 a Ulberg ML @1.85', {
    chatId: 'chat-fight-context-1',
    originalMessage: '$2000 a Ulberg ML @1.85',
    resolution: { resolvedMessage: '$2000 a Ulberg ML @1.85' },
    guidedAction: 'record_bet',
    fightContext: {
      fightId: 'fight_1',
      fighterA: 'Jiri Prochazka',
      fighterB: 'Carlos Ulberg',
      eventId: 'evt_1',
      eventName: 'UFC Fight Night: Prochazka vs. Ulberg',
    },
  });

  assert.doesNotMatch(result.reply, /qu[eé] pelea|cu[aá]l pelea|para qu[eé] evento/i);
});
```

Before finalizing this test, check how existing `record_bet`-guided tests in `__tests__/bettingWizard.test.js` construct `userStore` (search `grep -n "record_user_bet" __tests__/bettingWizard.test.js | head -5`) and match that convention for the fake `userStore.record_user_bet` implementation instead of leaving it `undefined` — the placeholder above is intentionally incomplete and must be replaced with a real fake before this step is considered done, following whatever pattern the existing tests in that file use for asserting `record_user_bet` gets called with the right `fight` string.

- [ ] **Step 3: Run test to verify it fails**

Run: `node __tests__/bettingWizard.test.js`
Expected: FAIL or the reply contains a request for fight/event details, since `fightContext` isn't read anywhere yet.

- [ ] **Step 4: Implement**

In `buildSystemPrompt` (the function containing `interactionRules`, read fully at lines ~4700-4780 earlier this session), thread a new `fightContext` parameter through and extend the `record_bet`/`analyze_quotes` branches:

```js
          normalizedGuidedAction === 'record_bet'
            ? fightContext
              ? `Objetivo: registrar una apuesta NUEVA al ledger para la pelea ${fightContext.fighterA} vs ${fightContext.fighterB} (evento: ${fightContext.eventName || 'N/D'}). Esa pelea YA está resuelta, no la vuelvas a preguntar: sólo pedí/usá pick, cuota y stake (texto o screenshot del ticket). No cierres ni archives apuestas en este flujo.`
              : 'Objetivo: registrar una apuesta NUEVA al ledger. Pedi/usa screenshot del ticket o texto estructurado (evento, pelea, pick, cuota, stake). No cierres ni archives apuestas en este flujo.'
            : '',
          normalizedGuidedAction === 'analyze_quotes'
            ? fightContext
              ? `Objetivo: analisis de cuotas para la pelea ${fightContext.fighterA} vs ${fightContext.fighterB} (evento: ${fightContext.eventName || 'N/D'}), YA resuelta. Pedile al usuario el screenshot completo de ESA pelea si falta.`
              : 'Objetivo: analisis de cuotas (screenshot o texto estructurado). Si faltan datos criticos de cuotas/mercado, pedi screenshot completo de la pelea/evento.'
            : '',
```

This replaces the existing two ternary lines in that array (the `analyze_quotes` one is currently the *first* entry in the array per the code read earlier this session — keep it first, just extend its condition; don't reorder the array).

Find wherever `buildSystemPrompt(...)` is invoked inside `handleMessage` (search `grep -n "buildSystemPrompt(" src/agents/bettingWizard.js`) and pass `fightContext` from `handleMessage`'s own params through to it (add `fightContext` to `handleMessage`'s destructured parameter list at its definition, and pass it into the `buildSystemPrompt({...})` call alongside the existing `interactionMode`/`guidedAction` arguments).

- [ ] **Step 5: Run test to verify it passes**

Run: `node __tests__/bettingWizard.test.js`
Expected: PASS.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: `All test suites passed.`

- [ ] **Step 7: Commit**

```bash
git add src/agents/bettingWizard.js src/core/routerChain.js __tests__/bettingWizard.test.js
git commit -m "feat(ufc): thread fightContext into the system prompt so the LLM skips re-asking which fight"
```

---

## Task Group 3 — Per-fight projection messages

### Task 7: `routerChain.js` and `telegramBot.js` learn to send multiple messages

This is additive: existing single-string replies are completely unaffected. Only a new optional `replies` array field is handled, checked before the existing single-`reply` path.

**Files:**
- Modify: `src/core/routerChain.js` (`unpackAgentResult`, `routeMessage`'s return)
- Modify: `src/core/telegramBot.js` (`deliverToRouter`, `routeSyntheticAction`)
- Modify: `src/bots/ufc/index.js` (the `router` wrapper object)
- Test: `__tests__/routerChain.test.js`, `__tests__/telegramBot.test.js`

**Verified ground truth (corrects an assumption in the original plan):** `telegramBot.js` never calls `routerChain.js`'s `routeMessage` directly. `startTelegramBot(router, options)` receives whatever `router` object its caller passes in, and `src/bots/ufc/index.js:383-391` passes a **wrapper**, not the raw router:

```js
  const router = {
    async routeMessage(input = '') {
      const reply = await rawRouter.routeMessage(input);
      return enforcePolicyPack({
        text: reply,
        policyPackId: manifest?.risk_policy || 'general_safe_advice',
      });
    },
  };
```

`enforcePolicyPack({text, policyPackId})` (`src/platform/policy/policyGuard.js:9`) does `String(text || '').trim()` and returns a **plain string**. Two consequences if this wrapper is left untouched: (1) once `rawRouter.routeMessage` starts returning `{text, replies}` objects (Step 3 below), `text: reply` here would pass the whole object into `String(text || '')`, stringifying it to the literal text `"[object Object]"` and shipping that to real users; (2) even after fixing that, `deliverToRouter`'s new code (Step 4 below) reads `routed?.text` — if this wrapper still returned a bare string instead of an object, `routed?.text` would be `undefined` on **every** existing UFC reply (not just the new multi-message ones), and `deliverToRouter` would silently send "No tengo respuesta para eso aún 😅" instead of the real reply. Step 5 below fixes this wrapper as part of the same change — it is not optional cleanup, the feature does not work end-to-end without it despite `routerChain.test.js`/`telegramBot.test.js` passing (those tests never exercise this wrapper).

- [ ] **Step 1: Write the failing test for `routerChain.js`**

```js
tests.push(async () => {
  const bettingWizard = {
    async handleMessage() {
      return {
        replies: [
          { text: 'Pelea 1: Prochazka vs Ulberg', replyMarkup: { inline_keyboard: [[{ text: '📝 Registrar', callback_data: 'qa:record_bet_for:fight_1' }]] } },
          { text: 'Pelea 2: Dern vs Robertson', replyMarkup: { inline_keyboard: [[{ text: '📝 Registrar', callback_data: 'qa:record_bet_for:fight_2' }]] } },
        ],
        metadata: {},
      };
    },
  };
  const router = createRouterChain({ bettingWizard, conversationStore: createConversationStore() });

  const result = await router.routeMessage({
    chatId: 'chat-multi-1',
    message: 'proyecciones para el evento',
    metadata: { guidedAction: 'ledger_list_pending', user: { id: '1' }, chat: { id: 'chat-multi-1' } },
  });

  assert.ok(Array.isArray(result.replies));
  assert.equal(result.replies.length, 2);
  assert.equal(result.replies[0].text, 'Pelea 1: Prochazka vs Ulberg');
  assert.deepEqual(result.replies[0].replyMarkup.inline_keyboard[0][0].callback_data, 'qa:record_bet_for:fight_1');
});
```

Check `createRouterChain`'s actual factory name/signature first (`grep -n "export function create\|export function routerChain" src/core/routerChain.js`) and match the test to it — the name above is a guess based on this session's earlier reading of the file; confirm before finalizing.

- [ ] **Step 2: Run test to verify it fails**

Run: `node __tests__/routerChain.test.js`
Expected: FAIL — `routeMessage` currently always `return text;` (a string), never an object with `.replies`.

- [ ] **Step 3: Implement — `routerChain.js`**

Modify `unpackAgentResult` (line 57-76 read earlier this session) to also detect and pass through a `replies` array, checked first:

```js
function unpackAgentResult(result) {
  if (typeof result === 'string') {
    return { text: result, replies: null, metadata: {} };
  }

  if (result && typeof result === 'object') {
    if (Array.isArray(result.replies)) {
      return {
        text: result.replies.map((entry) => entry?.text || '').join('\n\n'),
        replies: result.replies,
        metadata: result.metadata || {},
      };
    }
    if (typeof result.reply === 'string') {
      return { text: result.reply, replies: null, metadata: result.metadata || {} };
    }
    if (typeof result.text === 'string') {
      return { text: result.text, replies: null, metadata: result.metadata || {} };
    }
  }
```

(Keep whatever fallback/error branch already exists after this in the original function — do not remove it, only add the `Array.isArray(result.replies)` branch above the existing checks.)

Change `routeMessage`'s final line from `return text;` to `return { text, replies };` — then re-check every OTHER caller of `routeMessage` in the codebase (`grep -rn "routeMessage(" src __tests__` excluding `routerChain.js` itself) and update each to read `.text` off the new return shape instead of using the return value directly as a string. Based on this session's reading, `deliverToRouter` and `routeSyntheticAction` in `telegramBot.js` are the callers — `routeSyntheticAction`'s current body does `return router.routeMessage({...});` directly as its own return value (read it fresh: `grep -n "async function routeSyntheticAction" -A 15 src/core/telegramBot.js`); update it to `const result = await router.routeMessage({...}); return result?.text || null;` to preserve its existing string-returning contract for its own callers (`qa:list_pending`/`qa:list_history` handlers, which do `await sendBotMessage(chatId, routed || '...', ...)` expecting a string).

- [ ] **Step 4: Implement — `telegramBot.js`'s `deliverToRouter`**

Replace the reply-sending block at the end of `deliverToRouter` (lines ~2195-2199 read earlier this session):

```js
      const routed = await router.routeMessage({
        chatId: String(chatId),
        message: cleanMessage,
        telegramMessageId: msg.message_id,
        inputItems,
        mediaStats,
        interactionMode,
        guidedAction,
        inputType: guidedInputType,
        guidedInputType,
        fightContext,
        user: { /* ...unchanged... */ },
        chat: { /* ...unchanged... */ },
      });

      if (routed?.replies?.length) {
        for (const entry of routed.replies) {
          await sendBotMessage(chatId, entry?.text || '', {
            replyMarkupOverride: entry?.replyMarkup || null,
          });
        }
      } else {
        await sendBotMessage(chatId, routed?.text || 'No tengo respuesta para eso aún 😅');
      }
```

(The `user`/`chat` object literals are unchanged from what's already there — shown abbreviated here only to keep this step focused on the reply-handling change; do not actually delete their contents.)

Also fix `routeSyntheticAction` (`src/core/telegramBot.js:2037-2048`, confirmed at this exact location in the worktree), which currently does:

```js
    return router.routeMessage({
      chatId: String(chatId),
      message: syntheticMessage,
      interactionMode,
      guidedAction: metadata.guidedAction || null,
      inputType: metadata.inputType || null,
      user: {
```

Change the `return router.routeMessage({` line to assign the result to a variable, and add an unwrap after the existing call's closing `);` (keep every argument inside the call exactly as-is — only the `return` becomes an assignment, and a new line is added after):

```js
    const routed = await router.routeMessage({
      chatId: String(chatId),
      message: syntheticMessage,
      interactionMode,
      guidedAction: metadata.guidedAction || null,
      inputType: metadata.inputType || null,
      user: {
        /* ...unchanged, same as today... */
      },
      /* ...any other unchanged arguments already in this call... */
    });
    return routed?.text || null;
```

This preserves `routeSyntheticAction`'s existing string-or-null contract for its own callers (the `qa:list_pending`/`qa:list_history` callback handlers, which do `await sendBotMessage(chatId, routed || '...', ...)` expecting a plain string) — it never produces `replies[]` itself (synthetic actions like "list pending bets" aren't part of this feature), it just needs to unwrap the now-object-shaped result instead of returning it raw.

- [ ] **Step 5: Fix the UFC bootstrap wrapper in `src/bots/ufc/index.js`**

Replace the wrapper (`src/bots/ufc/index.js:383-391`, exact current code quoted above) with a version that passes `replies` through and — critically — always returns an object shape (`{text, replies}`), never a bare string, so `deliverToRouter`'s `routed?.text` (Step 4) and `routeSyntheticAction`'s `routed?.text` (this step, above) both keep working for the ordinary single-reply case too, not just the new multi-message one:

```js
  const router = {
    async routeMessage(input = '') {
      const raw = await rawRouter.routeMessage(input);
      const rawResult = raw && typeof raw === 'object' ? raw : { text: raw, replies: null };
      const policyPackId = manifest?.risk_policy || 'general_safe_advice';

      if (Array.isArray(rawResult.replies) && rawResult.replies.length) {
        return {
          text: enforcePolicyPack({ text: rawResult.text, policyPackId }),
          replies: rawResult.replies.map((entry) => ({
            text: enforcePolicyPack({ text: entry?.text, policyPackId }),
            replyMarkup: entry?.replyMarkup || null,
          })),
        };
      }

      return {
        text: enforcePolicyPack({ text: rawResult.text, policyPackId }),
        replies: null,
      };
    },
  };
```

Every reply's text (both the single-reply case and each entry in `replies[]`) goes through `enforcePolicyPack` individually — this preserves today's guarantee that policy notices get appended to whatever text reaches the user, now applied per-message instead of once.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node __tests__/routerChain.test.js && node __tests__/telegramBot.test.js`
Expected: PASS on both.

- [ ] **Step 7: Run full suite**

Run: `npm test`
Expected: `All test suites passed.` — pay special attention to any test elsewhere that calls `router.routeMessage(...)` and asserts on its return value directly as a string; per Step 3's caller audit, fix any such test to read `.text` instead. Also check for any existing test of `src/bots/ufc/index.js`'s bootstrap wrapper itself (`grep -n "routeMessage\|enforcePolicyPack" __tests__/*.js` for one that constructs this specific `router` object) and update its assertions from a bare-string return to the new `{text, replies}` shape.

- [ ] **Step 8: Commit**

```bash
git add src/core/routerChain.js src/core/telegramBot.js src/bots/ufc/index.js __tests__/routerChain.test.js __tests__/telegramBot.test.js
git commit -m "feat(ufc): support sending multiple Telegram messages from one wizard turn

Additive: bettingWizard can now return {replies: [{text, replyMarkup}]}
instead of a single {reply}. Every existing single-reply intent is
unaffected -- routeMessage now returns {text, replies} end-to-end
(routerChain.js's raw return AND the UFC bootstrap's enforcePolicyPack
wrapper in src/bots/ufc/index.js, which previously collapsed
everything to a bare string), and callers that only ever read a plain
string (routeSyntheticAction) unwrap .text
to keep their existing contract."
```

---

### Task 8: Bridge event-card fights to stable `event_fight_mirror` IDs

**Files:**
- Modify: `src/agents/bettingWizard.js`
- Test: `__tests__/bettingWizard.test.js`

`eventState.mainCard` (built at `src/agents/bettingWizard.js:988-994`, confirmed this session) assigns each fight a **synthetic, positional** `fightId` (`fight_1`, `fight_2`, ...) recomputed on every call based on current sort order (`isCompleted` then `updatedMs` descending). `getFightContextByIdForStore` (Task 5) resolves buttons against `event_fight_mirror.fight_id` — a **stable, DB-persisted** id from a completely different table (`src/core/sqliteStore.js:4515-4526`). These two ids are not the same value for the same fight. If Task 9/10's buttons used `mainCard`'s synthetic id directly, every button tap would resolve to `fightContext: null` (a silent failure — the exact class of bug this whole redesign exists to eliminate). This task bridges the two by fighter-name match, the same technique `projectionSnapshotMatchesFight` (`src/agents/bettingWizard.js:1494-1507`) already uses to match stored projection snapshots back to `mainCard` fights.

- [ ] **Step 1: Write the failing test**

```js
tests.push(() => {
  const fakeStore = {
    getEventFightMirror(watchKey) {
      if (watchKey !== 'next_event') return [];
      return [
        { fightId: 'b23487230c72d1a9c46a58cf02db58cc', fighterA: 'Islam Makhachev', fighterB: 'Ian Garry' },
        { fightId: 'e1ae0688f10d4fcdab848fbb0aa4db28', fighterA: 'Mackenzie Dern', fighterB: 'Gillian Robertson' },
      ];
    },
  };

  // Order-independent: mainCard/tool-call order isn't guaranteed to match the mirror's stored order.
  assert.equal(
    resolveStableFightIdByNames(fakeStore, 'Gillian Robertson', 'Mackenzie Dern'),
    'e1ae0688f10d4fcdab848fbb0aa4db28'
  );
  assert.equal(resolveStableFightIdByNames(fakeStore, 'Nobody Real', 'Also Nobody'), null);
  assert.equal(resolveStableFightIdByNames({}, 'Islam Makhachev', 'Ian Garry'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node __tests__/bettingWizard.test.js`
Expected: FAIL — `resolveStableFightIdByNames is not defined`.

- [ ] **Step 3: Implement**

Add near `projectionSnapshotMatchesFight` (`src/agents/bettingWizard.js:1494`), reusing the module-level `normalise` helper already defined at line 466:

```js
export function resolveStableFightIdByNames(userStore, fighterA, fighterB) {
  if (!userStore?.getEventFightMirror) return null;
  const targetA = normalise(fighterA || '');
  const targetB = normalise(fighterB || '');
  if (!targetA || !targetB) return null;

  for (const watchKey of ['next_event', 'current_event']) {
    const mirrorFights = userStore.getEventFightMirror(watchKey) || [];
    const match = mirrorFights.find((row) => {
      const rowA = normalise(row?.fighterA || '');
      const rowB = normalise(row?.fighterB || '');
      if (!rowA || !rowB) return false;
      return (rowA === targetA && rowB === targetB) || (rowA === targetB && rowB === targetA);
    });
    if (match?.fightId) return String(match.fightId);
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node __tests__/bettingWizard.test.js`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: `All test suites passed.`

- [ ] **Step 6: Commit**

```bash
git add src/agents/bettingWizard.js __tests__/bettingWizard.test.js
git commit -m "feat(ufc): resolve fighter names to the stable event_fight_mirror fight_id

mainCard's fightId is a synthetic, per-call positional value (fight_1,
fight_2...); the callback buttons being added in this feature need the
stable, DB-persisted event_fight_mirror.fight_id instead, since that's
what getFightContextByIdForStore resolves against. Bridged by
order-independent fighter-name match, same technique already used by
projectionSnapshotMatchesFight."
```

---

### Task 9: Per-fight projection messages with buttons

**Files:**
- Modify: `src/agents/bettingWizard.js` (the `wantsEventProjections` reply-building block, read in full earlier this session around lines 6830-6970 — the `for (const [index, fight] of fights.entries())` loop)
- Test: `__tests__/bettingWizard.test.js`

- [ ] **Step 1: Write the failing test**

```js
tests.push(async () => {
  const conversationStore = createConversationStore();
  const fakeClient = createSequentialFakeClient([responseWithText('no deberia ejecutarse')]);

  const wizard = createBettingWizard({
    conversationStore,
    client: fakeClient,
    fightsScalper: { async getFighterHistory() { return { fighters: [], rows: [] }; } },
    userStore: {
      getEventWatchState(watchKey) {
        if (watchKey !== 'next_event') return null;
        return {
          eventId: 'evt_proj_1',
          eventName: 'UFC Fight Night: Prochazka vs. Ulberg',
          eventDateUtc: '2026-08-15',
          mainCard: [
            { fightId: 'fight_1', fighterA: 'Jiri Prochazka', fighterB: 'Carlos Ulberg', isCompleted: false },
            { fightId: 'fight_2', fighterA: 'Mackenzie Dern', fighterB: 'Gillian Robertson', isCompleted: false },
          ],
          updatedAt: new Date().toISOString(),
        };
      },
      getEventFightMirror(watchKey) {
        if (watchKey !== 'next_event') return [];
        return [
          { fightId: 'mirror_prochazka_ulberg', fighterA: 'Jiri Prochazka', fighterB: 'Carlos Ulberg' },
          { fightId: 'mirror_dern_robertson', fighterA: 'Mackenzie Dern', fighterB: 'Gillian Robertson' },
        ];
      },
      listUpcomingOddsEvents() { return []; },
      listRecentOddsEvents() { return []; },
      async refreshLiveScores() { return { ok: true, upsertedCount: 0 }; },
      listLatestRelevantNews() { return []; },
      listLatestProjectionSnapshotsForEvent() { return []; },
      listLatestBetScoringForEvent() { return []; },
      listLatestOddsMarketsForFight() { return []; },
    },
  });

  const result = await wizard.handleMessage('proyecciones para el evento', {
    chatId: 'chat-per-fight-projections-1',
    userId: 'u-per-fight-projections-1',
    originalMessage: 'proyecciones para el evento',
    resolution: { resolvedMessage: 'proyecciones para el evento' },
  });

  assert.ok(Array.isArray(result.replies), 'debe devolver replies[], no un unico reply combinado');
  assert.equal(result.replies.length, 2);
  assert.match(result.replies[0].text, /Jiri Prochazka.*Carlos Ulberg|Prochazka.*Ulberg/s);
  assert.match(result.replies[1].text, /Dern.*Robertson/s);

  const buttons0 = result.replies[0].replyMarkup?.inline_keyboard?.flat() || [];
  assert.ok(buttons0.some((b) => b.callback_data === 'qa:record_bet_for:mirror_prochazka_ulberg'));
  assert.ok(buttons0.some((b) => b.callback_data === 'qa:analyze_quotes_for:mirror_prochazka_ulberg'));
  const buttons1 = result.replies[1].replyMarkup?.inline_keyboard?.flat() || [];
  assert.ok(buttons1.some((b) => b.callback_data === 'qa:record_bet_for:mirror_dern_robertson'));
});

tests.push(async () => {
  // Graceful degradation: mirror not built yet / no name match for this fight -> the
  // projection text still ships, just without action buttons on that specific message.
  const conversationStore = createConversationStore();
  const fakeClient = createSequentialFakeClient([responseWithText('no deberia ejecutarse')]);

  const wizard = createBettingWizard({
    conversationStore,
    client: fakeClient,
    fightsScalper: { async getFighterHistory() { return { fighters: [], rows: [] }; } },
    userStore: {
      getEventWatchState(watchKey) {
        if (watchKey !== 'next_event') return null;
        return {
          eventId: 'evt_proj_2',
          eventName: 'UFC Fight Night: Prochazka vs. Ulberg',
          eventDateUtc: '2026-08-15',
          mainCard: [
            { fightId: 'fight_1', fighterA: 'Jiri Prochazka', fighterB: 'Carlos Ulberg', isCompleted: false },
          ],
          updatedAt: new Date().toISOString(),
        };
      },
      getEventFightMirror() { return []; },
      listUpcomingOddsEvents() { return []; },
      listRecentOddsEvents() { return []; },
      async refreshLiveScores() { return { ok: true, upsertedCount: 0 }; },
      listLatestRelevantNews() { return []; },
      listLatestProjectionSnapshotsForEvent() { return []; },
      listLatestBetScoringForEvent() { return []; },
      listLatestOddsMarketsForFight() { return []; },
    },
  });

  const result = await wizard.handleMessage('proyecciones para el evento', {
    chatId: 'chat-per-fight-projections-nomirror-1',
    userId: 'u-per-fight-projections-nomirror-1',
    originalMessage: 'proyecciones para el evento',
    resolution: { resolvedMessage: 'proyecciones para el evento' },
  });

  assert.equal(result.replies.length, 1);
  assert.match(result.replies[0].text, /Prochazka.*Ulberg/s);
  assert.equal(result.replies[0].replyMarkup, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node __tests__/bettingWizard.test.js`
Expected: FAIL — `result.replies` is `undefined`, the handler still returns a single combined `reply` string.

- [ ] **Step 3: Implement**

In the `wantsEventProjections` block, the existing code builds one `lines` array covering the whole card header plus a loop appending each fight's projection text into that same array, ending with `return { reply: lines.join('\n'), metadata: {...} };`. Restructure so the loop builds one entry per fight instead of appending to a shared array, resolving each fight's stable id via Task 8's `resolveStableFightIdByNames` before deciding whether to attach buttons:

```js
      const perFightReplies = [];
      for (const [index, fight] of fights.entries()) {
        const storedProjection = storedProjections.find((row) => projectionSnapshotMatchesFight(row, fight));
        const projection = storedProjection
          ? {
              projectedWinner: storedProjection.predictedWinner || null,
              confidence: Math.round(Number(storedProjection.confidencePct || 0)),
              scenario: describeProjectedMethod(storedProjection.predictedMethod),
              evidence: [],
              keyFactors: Array.isArray(storedProjection.keyFactors) ? storedProjection.keyFactors.slice(0, 3) : [],
              changeSummary: storedProjection.changeSummary || null,
            }
          : buildFightProjection({ /* ...unchanged, same call as today... */ });

        const fightLines = [
          `🥊 ${fight.fighterA} vs ${fight.fighterB}`,
          projection.projectedWinner
            ? `Proyección: ${projection.projectedWinner} (${projection.confidence}%)${projection.scenario ? ` — ${projection.scenario}` : ''}`
            : 'Proyección: sin datos suficientes todavía.',
        ];
        if (projection.keyFactors?.length) {
          fightLines.push(...projection.keyFactors.map((factor) => `• ${factor}`));
        }
        if (index === 0 && reconciliationNotes.length) {
          fightLines.push('', ...reconciliationNotes);
        }

        const stableFightId = resolveStableFightIdByNames(userStore, fight.fighterA, fight.fighterB);
        perFightReplies.push({
          text: fightLines.join('\n'),
          replyMarkup: stableFightId
            ? {
                inline_keyboard: [[
                  { text: '📝 Registrar apuesta', callback_data: `qa:record_bet_for:${stableFightId}` },
                  { text: '🔍 Analizar mis quotes', callback_data: `qa:analyze_quotes_for:${stableFightId}` },
                ]],
              }
            : null,
        });
      }

      return {
        replies: perFightReplies,
        metadata: { resolvedFight: runtimeState.resolvedFight, eventCard: runtimeState.eventCard },
      };
```

Keep everything ABOVE this loop unchanged (the `allFights`/`completedCount`/`pendingFights`/`fights` computation, the `hasStoredProjections`/`hasStoredBetScoring` lookups, the empty-card early return). Only the loop body and final return change. Do not touch the `wantsLatestNews` branch in the same `if ((wantsLatestNews || wantsEventProjections) ...)` block — it keeps returning a single `{ reply, metadata }` as today (news stays one combined message; only projections splits).

- [ ] **Step 4: Run test to verify it passes**

Run: `node __tests__/bettingWizard.test.js`
Expected: PASS. This will also require checking any OTHER existing test in this file that already asserts on `wantsEventProjections` output shape (search `grep -n "proyecciones para el" __tests__/bettingWizard.test.js`) — the tests seen earlier this session (`chat-intel-proj-web-live-reconcile-1`, `chat-intel-proj-current-event-priority-1`, `chat-intel-proj-local-window-1`) assert `result.reply` matches `/Evento:\s*UFC \d+/i`. Update each to instead assert against `result.replies` (e.g., `assert.ok(result.replies.some((r) => /UFC \d+/i.test(r.text)))`), since the combined `Evento: ...` header line no longer exists as a single first line — replace those specific assertions to check for the fight/event identity somewhere across the `replies` array instead. Do this for all three existing tests before considering this step done.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: `All test suites passed.`

- [ ] **Step 6: Commit**

```bash
git add src/agents/bettingWizard.js __tests__/bettingWizard.test.js
git commit -m "feat(ufc): send event projections as one message per fight with action buttons

Each fight's projection now arrives as its own Telegram message. When
the fight resolves against event_fight_mirror (via Task 8's
resolveStableFightIdByNames), it carries [📝 Registrar apuesta]
[🔍 Analizar mis quotes] buttons with that stable fight_id; otherwise
the text still ships without buttons rather than a dead-end callback,
per the 2026-08-12 guided-menu-unification design."
```

---

### Task 10: Attach a "Registrar apuesta" button after analyzing quotes from Análisis

**Files:**
- Modify: `src/agents/bettingWizard.js` (`turnToolEffects` init at ~line 8027, the `store_user_odds` tool case at ~line 8981, the final return tail at ~line 9567-9579 — all inside `handleMessage`, read fully this session)
- Test: `__tests__/bettingWizard.test.js`

Per the spec's "Aceptación" criteria, a fight button must appear "desde Evento o desde Análisis" — Task 9 covers Evento (`wantsEventProjections`). This task covers Análisis: the user enters generically via `📸 Análisis` (no `fight_id` yet, per the menu tree in the spec) and sends a quotes screenshot; the LLM calls `store_user_odds` for the fight it recognizes. When that resolves to a fight that also matches a row in `event_fight_mirror` (via Task 8's `resolveStableFightIdByNames`), the reply gets a `[📝 Registrar apuesta]` button carrying that `fight_id` — same mechanism as Task 9, different entry point. When no match is found (mirror not built yet, or the fight isn't on the tracked card), the reply ships as plain text exactly as it does today.

- [ ] **Step 1: Write the failing test**

```js
tests.push(async () => {
  const conversationStore = createConversationStore();
  const fakeClient = createSequentialFakeClient([
    responseWithToolCall('store_user_odds', {
      fight: { fighter_red: 'Islam Makhachev', fighter_blue: 'Ian Garry' },
      event: { name: 'UFC 330' },
    }),
    responseWithText('Listo, ya tengo tus cuotas cargadas.'),
  ]);

  const wizard = createBettingWizard({
    conversationStore,
    client: fakeClient,
    fightsScalper: { async getFighterHistory() { return { fighters: [], rows: [] }; } },
    userStore: {
      addOddsSnapshot() { return { ok: true, stored: true, oddsHash: 'hash-1' }; },
      getEventFightMirror(watchKey) {
        if (watchKey !== 'next_event') return [];
        return [{ fightId: 'mirror_makhachev_garry', fighterA: 'Islam Makhachev', fighterB: 'Ian Garry' }];
      },
    },
  });

  const result = await wizard.handleMessage('', {
    chatId: 'chat-analysis-button-1',
    userId: 'u-analysis-button-1',
    originalMessage: '[screenshot de cuotas]',
    resolution: { resolvedMessage: '[screenshot de cuotas]' },
    guidedAction: 'analyze_quotes',
  });

  assert.ok(Array.isArray(result.replies), 'debe adjuntar boton via replies[]');
  assert.equal(result.replies.length, 1);
  assert.match(result.replies[0].text, /Listo, ya tengo tus cuotas cargadas/);
  const buttons = result.replies[0].replyMarkup?.inline_keyboard?.flat() || [];
  assert.ok(buttons.some((b) => b.callback_data === 'qa:record_bet_for:mirror_makhachev_garry'));
});
```

Check how existing tool-call-driven tests in `__tests__/bettingWizard.test.js` construct a fake client response that triggers a tool call (search `grep -n "function responseWithToolCall\|function createSequentialFakeClient" __tests__/bettingWizard.test.js`) and match this test's `responseWithToolCall('store_user_odds', {...})` call to that helper's real signature — the shape above illustrates the tool name/args needed; adjust the call syntax only if the real helper's parameter order/name differs, keeping the same `fight.fighter_red`/`fight.fighter_blue`/`event.name` payload shape (confirmed at `src/core/sqliteStore.js:2311-2314` — `addOddsSnapshot` reads `payload.fight.fighter_red`, `payload.fight.fighter_blue`, `payload.event.name`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node __tests__/bettingWizard.test.js`
Expected: FAIL — `result.replies` is `undefined` (today this returns a plain `{reply, metadata}`).

- [ ] **Step 3: Implement — capture the fight identity when odds get stored**

In `turnToolEffects`'s initial object literal (`src/agents/bettingWizard.js:8027-8035`), add one field:

```js
    const turnToolEffects = {
      hasOperationalLedgerToolCall: false,
      hasLedgerCreateReceipt: false,
      hasLedgerMutationReceipt: false,
      historyRowCount: 0,
      historyLatestFightDate: null,
      usedWebSearch: false,
      citationsCount: 0,
      lastStoredOddsFight: null,
    };
```

In the `store_user_odds` case (`src/agents/bettingWizard.js:8981-9002`), capture the fighter names right after the snapshot is stored:

```js
        case 'store_user_odds': {
          if (!userId) {
            return { ok: false, error: 'userId no disponible para odds.' };
          }
          if (!userStore?.addOddsSnapshot) {
            return {
              ok: false,
              error: 'userStore no soporta addOddsSnapshot.',
            };
          }

          const payload =
            args.oddsPayload && typeof args.oddsPayload === 'object'
              ? args.oddsPayload
              : args;

          const stored = userStore.addOddsSnapshot(userId, payload);
          const fighterRed = String(payload?.fight?.fighter_red || '').trim();
          const fighterBlue = String(payload?.fight?.fighter_blue || '').trim();
          if (fighterRed && fighterBlue) {
            turnToolEffects.lastStoredOddsFight = { fighterA: fighterRed, fighterB: fighterBlue };
          }
          return {
            ok: true,
            stored,
          };
        }
```

- [ ] **Step 4: Implement — attach the button to the final reply**

At the tail of `handleMessage` (`src/agents/bettingWizard.js:9567-9579`), the current code ends with:

```js
      const finalReply = enforceResponseConsistencyValidator(replyWithContradiction, {
        originalMessage,
        temporalContext,
        turnContext: turnToolEffects,
      });

      return {
        reply: `${finalReply}${citationFooter}`,
        metadata: {
          resolvedFight: runtimeState.resolvedFight,
          eventCard: runtimeState.eventCard,
        },
      };
```

Replace the final `return` with a conditional that only changes shape when a fight was actually resolved:

```js
      const finalReply = enforceResponseConsistencyValidator(replyWithContradiction, {
        originalMessage,
        temporalContext,
        turnContext: turnToolEffects,
      });
      const finalReplyText = `${finalReply}${citationFooter}`;
      const finalMetadata = {
        resolvedFight: runtimeState.resolvedFight,
        eventCard: runtimeState.eventCard,
      };

      if (guidedAction === 'analyze_quotes' && turnToolEffects.lastStoredOddsFight) {
        const stableFightId = resolveStableFightIdByNames(
          userStore,
          turnToolEffects.lastStoredOddsFight.fighterA,
          turnToolEffects.lastStoredOddsFight.fighterB
        );
        if (stableFightId) {
          return {
            replies: [
              {
                text: finalReplyText,
                replyMarkup: {
                  inline_keyboard: [[
                    { text: '📝 Registrar apuesta', callback_data: `qa:record_bet_for:${stableFightId}` },
                  ]],
                },
              },
            ],
            metadata: finalMetadata,
          };
        }
      }

      return {
        reply: finalReplyText,
        metadata: finalMetadata,
      };
```

`guidedAction` is `handleMessage`'s own parameter (already used unchanged at line 9083's `buildSystemPrompt(loadKnowledgeSnippet(), { interactionMode, guidedAction })`) — no new plumbing needed to read it at this scope.

- [ ] **Step 5: Run test to verify it passes**

Run: `node __tests__/bettingWizard.test.js`
Expected: PASS.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: `All test suites passed.` — pay attention to any pre-existing test that exercises `store_user_odds` with a fake `userStore` lacking `getEventFightMirror`: `resolveStableFightIdByNames` returns `null` in that case (per Task 8's Step 3), so those tests keep getting the plain `{reply, metadata}` shape unchanged, since this branch is strictly additive.

- [ ] **Step 7: Commit**

```bash
git add src/agents/bettingWizard.js __tests__/bettingWizard.test.js
git commit -m "feat(ufc): attach a Registrar apuesta button when Análisis resolves a tracked fight

Symmetric with Task 9's Evento buttons: when store_user_odds resolves
a fight that also matches event_fight_mirror, the analyze_quotes reply
now carries a [📝 Registrar apuesta] button with that fight_id, so the
user doesn't have to leave Análisis and re-navigate to Ledger to
record the bet they just got quotes for."
```

---

## Task Group 4 — `current_event` UFC-only filter

### Task 11: Filter non-UFC fights out of live-event detection

**Files:**
- Modify: `src/agents/bettingWizard.js` (`buildLiveOddsFightHints`, `buildLiveOddsEventContext`, `buildEventStateFromOddsRows` — read fully at lines 842-1330-ish earlier this session)
- Test: `__tests__/bettingWizard.test.js`

- [ ] **Step 1: Confirm exact current behavior before writing the fix**

Re-read `buildLiveOddsEventContext` (`sed -n '1230,1330p' src/agents/bettingWizard.js`) to get its exact current line numbers (they will have shifted from Task Group 3's edits). Confirm it groups `odds_events_index` rows purely by proximity to `now` with zero name filtering, as established earlier this session — the production incident (`current_event` = "Matt Adams vs Anthony Wint", a non-UFC card under the same `mma_mixed_martial_arts` sport key) confirms this.

- [ ] **Step 2: Write the failing test — reproduces the exact production incident**

```js
tests.push(() => {
  const nowMs = Date.parse('2026-08-12T16:00:00.000Z');
  const rows = [
    // Real production row from odds_events_index: a non-UFC MMA card happening right now.
    { eventId: 'b23487230c72d1a9c46a58cf02db58cc', eventName: 'Matt Adams vs Anthony Wint', commenceTime: '2026-08-12T01:15:00Z', homeTeam: 'Matt Adams', awayTeam: 'Anthony Wint', completed: false },
  ];

  const context = buildLiveOddsEventContext(rows, nowMs, { referenceDateIso: '2026-08-12', timezone: 'UTC' });

  assert.equal(context, null, 'una pelea que no es UFC no debe poder convertirse en current_event');
});

tests.push(() => {
  const nowMs = Date.parse('2026-08-15T03:00:00.000Z');
  const rows = [
    { eventId: 'e1ae0688f10d4fcdab848fbb0aa4db28', eventName: 'Islam Makhachev vs Ian Garry', commenceTime: '2026-08-15T03:30:00Z', homeTeam: 'Islam Makhachev', awayTeam: 'Ian Garry', completed: false },
  ];

  const context = buildLiveOddsEventContext(rows, nowMs, { referenceDateIso: '2026-08-15', timezone: 'UTC' });

  assert.ok(context, 'una pelea real de UFC debe seguir pudiendo ser current_event');
  assert.equal(context.eventName, 'Islam Makhachev vs Ian Garry');
});
```

The second test needs a UFC-identifiable signal in the row shape — since `odds_events_index` rows (confirmed this session by direct SQL query against production) carry only `fighterA`/`fighterB`/`commenceTime`, not a promotion field, use a fighter-roster check the same way you'll implement it in Step 3 (see below): if implementing via a known-UFC-roster lookup, make sure this test's fighters are ones the implementation will actually recognize — adjust the fixture names to match whatever data source Step 3 ends up using, and prefer fighters already present in `ufc_stats.db` (e.g., reuse names already seen in this session's real data, like `Islam Makhachev`/`Ian Garry`, which are extremely likely to already exist in the local `fights`/`upcoming_fights` tables from Fase C's real scrape).

- [ ] **Step 3: Run test to verify it fails**

Run: `node __tests__/bettingWizard.test.js`
Expected: FAIL on the first assertion — today's code returns a non-null context for the Matt Adams row.

- [ ] **Step 4: Implement**

The cleanest UFC-identity signal available without a new data dependency is `ufcStats.isAvailable()` + a roster lookup: since `ufc_stats.db` now stays fresh (Fase C), a fighter appearing in `fights`/`upcoming_fights` is strong evidence of being a UFC roster fighter. Add a filter step in `buildLiveOddsEventContext` (and mirror it in `buildLiveOddsFightHints`/`buildEventStateFromOddsRows`, which share the same input rows) that drops rows where NEITHER fighter resolves via `ufcStats.getFighterStats` before doing the existing time-proximity grouping/scoring.

Check how `ufcStats` is currently made available inside `bettingWizard.js` at this call scope first: `grep -n "ufcStats" src/agents/bettingWizard.js | grep -i "buildLiveOdds\|buildEventState" -A2 -B2` — if these functions are pure/standalone (not closures with `ufcStats` in scope, which is likely given they were read as top-level `function` declarations, not methods), you'll need to pass `isUfcFighter` (or `ufcStats`) as a new parameter into all three functions and thread it from their call sites (inside `handleMessage`, where `ufcStats` is available via the wizard's injected dependencies — confirm with `grep -n "ufcStats" src/agents/bettingWizard.js | head -5`).

Minimal-diff shape (exact parameter name/threading depends on what Step 4's grep reveals — implement to match, keeping this same filtering logic):

```js
function rowIsLikelyUfc(row, isUfcFighter) {
  if (typeof isUfcFighter !== 'function') return true; // fail-open only if no roster check is wired at all
  const home = String(row?.homeTeam || '').trim();
  const away = String(row?.awayTeam || '').trim();
  return isUfcFighter(home) || isUfcFighter(away);
}
```

Apply `rowIsLikelyUfc` as a `.filter(...)` on the rows array at the top of `buildLiveOddsFightHints`, `buildLiveOddsEventContext`, and `buildEventStateFromOddsRows`, before any existing grouping/scoring logic runs — do not change anything below that filter line in any of the three functions.

Wire the actual `isUfcFighter` implementation at the call site inside `handleMessage` (both places these three functions get called — the `wantsLiveEventStatus` block and the `wantsLatestNews || wantsEventProjections` block, both read fully earlier this session):

```js
const isUfcFighter = (name) => {
  if (!name || !ufcStats?.isAvailable?.()) return false;
  const stats = ufcStats.getFighterStats({ fighterName: name, limit: 1 });
  return stats?.ok !== false && Array.isArray(stats?.fights) && stats.fights.length > 0;
};
```

Pass `isUfcFighter` as the new last argument everywhere `buildLiveOddsFightHints(...)`, `buildLiveOddsEventContext(...)`, `buildEventStateFromOddsRows(...)` are currently called.

- [ ] **Step 5: Run test to verify it passes**

Run: `node __tests__/bettingWizard.test.js`
Expected: PASS. If the second test still fails because `Islam Makhachev`/`Ian Garry` aren't resolvable in the test's fake `ufcStats`, that's expected — this test needs a fake `ufcStats.getFighterStats` in its own wizard construction (add `ufcStats: { isAvailable: () => true, getFighterStats: ({ fighterName }) => (['Islam Makhachev', 'Ian Garry'].includes(fighterName) ? { ok: true, fights: [{}] } : { ok: false }) }` to that test's `createBettingWizard({...})` call) — this test calls `buildLiveOddsEventContext` directly rather than through `handleMessage`, so check whether these functions are exported for direct testing (`grep -n "^export function buildLiveOddsEventContext" src/agents/bettingWizard.js`); if not currently exported, add `export` to all three so this task's tests can call them directly without needing a full wizard instance.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: `All test suites passed.`

- [ ] **Step 7: Commit**

```bash
git add src/agents/bettingWizard.js __tests__/bettingWizard.test.js
git commit -m "fix(ufc): filter non-UFC fights out of current_event live detection

buildLiveOddsEventContext/buildLiveOddsFightHints/buildEventStateFromOddsRows
took any mma_mixed_martial_arts row closest to now, regardless of
promotion. Confirmed in production: current_event became 'Matt Adams
vs Anthony Wint', a real fight but not UFC. Now requires at least one
fighter to resolve against the local ufc_stats.db roster before a row
can become a live-event candidate."
```

---

## Deployment (after all tasks above are green locally)

This project's established deploy pattern (used throughout the 2026-08-12 session for Fases A/B/C): gates → merge to `main` → snapshot pre-deploy on `ufc-oci` → `git pull` + `systemctl restart bot-factory@ufc` → poll `/health` → verify ledger digest unchanged → smoke test. Follow that exact sequence:

- [ ] Run `npm test && npm run quality:gate && npm run qa:parity:ufc` locally, all green.
- [ ] Add tracker rows to `docs/CODE_QUALITY_TRACKER.tsv` for every new exported function from this plan (`getFightContextByIdForStore`, `isGuidedActionFresh`, `setGuidedActionState`, `resolveStableFightIdByNames`, and any function newly `export`ed in Task 11) — follow the existing row format (see any `Q-011x` row for the exact columns).
- [ ] Merge to `main`, push.
- [ ] SSH `ufc-oci`, capture a pre-deploy snapshot with `node src/scripts/ufcOperationalSnapshot.js --db ... --stats-db ... --out ~/pre-deploy-snapshot-<date>.json` (exact command used repeatedly this session).
- [ ] `git pull` on the server, `sudo systemctl restart bot-factory@ufc.service`, poll `/health` until 200.
- [ ] Verify ledger row counts unchanged (`sqlite3 .../bot.db "SELECT COUNT(*) FROM bets;"` etc.) against the last known-good baseline (49/52/27/1/2 as of this session).
- [ ] Smoke test for real over Telegram (the actual bot, chat `1806836602`): press `🧾 Ledger → 📝 Registrar apuesta`, confirm the reencauce hint appears; from `📰 Evento`, confirm per-fight messages with buttons arrive; tap `📝 Registrar apuesta` on one of them, confirm the hint mentions the specific fighters; ask "hay evento en vivo" and confirm no non-UFC fight is reported as `current_event`.

## Out of scope (confirmed in the spec, restated here so it isn't accidentally picked up mid-implementation)

- Wishlist item 43 (Historial) — not implemented in this plan.
- Editing/updating existing Telegram messages instead of sending new ones — not implemented.
- Wishlist items 40/41's broader event-archive/continuous-screenshot-session features — this plan only builds the `fight_id`-in-callback mechanism they'll eventually reuse, not their full scope.
