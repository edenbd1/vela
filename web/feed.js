/**
 * The fleet, thinking.
 *
 * Its own file because it was not. This block lived inside app.js and got
 * duplicated four times by a careless string replace — the pattern it was
 * anchored to appeared more than once, and every later edit compounded it.
 * One of the copies ended up nested inside runScenario, where it redeclared
 * everything locally and opened a second EventSource on every click of the
 * DeFi buttons.
 *
 * A file cannot be pasted into itself, which is the point.
 */
/* ------------------------------------------------- the fleet, thinking --- */
/*
 * One column per agent, fed by an EventSource. The agents post their own
 * decisions here — they run on hosts this page cannot see into, so the only
 * honest way to show what they are doing is to let them say it.
 *
 * Everything is written with textContent. What arrives is a report from a
 * process running a language model that a third party may have written into,
 * and putting that through innerHTML would mean the one component in this
 * project that trusts an agent is the dashboard.
 */
const minds = new Map();

function mindFor(agent) {
  if (minds.has(agent)) return minds.get(agent);

  const box = document.createElement("div");
  box.className = "mind live";

  const head = document.createElement("header");
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = agent;
  const slot = document.createElement("span");
  // .meta, right-aligned by the sheet, and one element rather than a slot
  // label with a model tag nested inside it — which is what it was, so the
  // two overlapped and the text read twice in the DOM.
  slot.className = "meta";
  // The slot is the chip's fact, not the agent's claim, so it is read from
  // the fleet the device reported rather than from the message.
  const known = (window.__fleet ?? []).find((a) => a.label === agent);
  slot.textContent = known ? `slot ${known.slot}` : "unclaimed slot";
  head.append(who, slot);

  const steps = document.createElement("ol");
  steps.className = "steps";

  box.append(head, steps);

  const host = document.getElementById("minds");
  // The empty state is a sibling of the grid now, not a child of it, so
  // removing "a .none inside #minds" stopped hiding it — and the page told
  // you no agent was running directly above three running agents.
  const empty = document.getElementById("minds-empty");
  if (empty) empty.hidden = true;
  host.append(box);

  const m = { box, steps, last: null };
  minds.set(agent, m);
  return m;
}

function onAgentEvent(e) {
  // A run starting clears what that agent said last time. Anything else would
  // show two runs stacked and read as one very confused agent.
  if (e.kind === "start") {
    const old = minds.get(e.agent);
    if (old) { old.box.remove(); minds.delete(e.agent); }
    const empty = document.getElementById("minds-empty");
    if (empty) empty.hidden = true;
    const m = mindFor(e.agent);
    if (e.model) {
      const meta = m.box.querySelector("header .meta");
      if (meta) meta.textContent = `${meta.textContent} · ${e.model}`;
    }
    return;
  }

  const m = mindFor(e.agent);

  if (e.kind === "decision") {
    const li = document.createElement("li");
    const call = document.createElement("span");
    call.className = "call";
    call.textContent = e.call || e.tool;
    li.append(call);
    // A thought that only repeats the name of the tool being called is the
    // model narrating the line above it. Two lines, one fact, and the second
    // one pushes the actual reasoning further down the column.
    const bare = (e.thought || "").trim();
    if (bare && bare !== (e.tool || "").trim() && bare !== (e.call || "").trim()) {
      const t = document.createElement("span");
      t.className = "thought";
      t.textContent = e.thought;
      li.append(t);
    }
    m.steps.append(li);
    m.last = li;
    m.box.scrollTop = m.box.scrollHeight;
    return;
  }

  if (e.kind === "flagged") {
    // The agent saying, out loud, that something wrote into its context.
    // Worth its own treatment: this is the only line on the page that is a
    // third party's words rather than a report about them.
    const li = document.createElement("li");
    const head = document.createElement("span");
    head.className = "call";
    head.textContent = `flagged an instruction in ${e.source || "a tool result"}`;
    const q = document.createElement("span");
    q.className = "out flagged";
    q.textContent = `“${e.quote}”`;
    li.append(head, q);
    m.steps.append(li);
    m.last = li;
    return;
  }

  if (e.kind === "done") {
    m.box.classList.remove("live");
    const p = document.createElement("p");
    p.className = "verdict";
    p.textContent = e.verdict || "(no verdict)";
    m.box.append(p);
    // The device's numbers may have moved. They are read from the chip, not
    // from what the agent just claimed about itself.
    refresh();
    return;
  }

  // A result attaches to the decision it answers, so a refusal reads as the
  // reply to the thing that was refused rather than as a separate line.
  const out = document.createElement("span");
  out.className = "out " + (e.kind === "refused" ? "refused"
                          : e.kind === "error" ? "error"
                          : /bought=/.test(e.summary ?? "") ? "bought" : "");
  out.textContent = e.kind === "refused"
    ? `refused: ${e.reason} — ${e.why ?? ""}`
    : (e.summary || "");
  (m.last ?? m.steps).append(out);
}

/**
 * Play a recording instead of listening for one.
 *
 * A reader with no Ledger, no broker and no model runtime still deserves to
 * see what the refusal looks like. The events are the ones the console
 * actually received — captured from /api/events/recording — replayed at the
 * pace they arrived, capped so a run with a slow model in it does not make
 * the page look broken.
 *
 * The banner above says these are recorded, and every button is disabled.
 * A console that let you press "buy" against a recording would be a console
 * lying about what it is.
 */
async function replayAgents(url = "/demo-run.json") {
  let rec;
  try {
    rec = await (await fetch(url)).json();
  } catch {
    return false;
  }
  if (!rec?.events?.length) return false;

  const when = document.getElementById("demo-when");
  if (when && rec.recorded) when.textContent = rec.recorded.slice(0, 10);

  const events = rec.events;
  let previous = events[0].at ?? 0;
  for (const e of events) {
    // Real gaps, but bounded: a model that thought for nine seconds should
    // not make a reader wait nine seconds to find out the page works.
    const gap = Math.min(Math.max((e.at ?? previous) - previous, 0), 900);
    previous = e.at ?? previous;
    await new Promise((r) => setTimeout(r, gap));
    onAgentEvent(e);
  }
  // The recording has run out, so nothing here is live any more. Leaving the
  // pulse on would say an agent is still thinking about a run that ended
  // before the reader opened the page.
  for (const m of minds.values()) m.box.classList.remove("live");
  return true;
}

function watchAgents() {
  const src = new EventSource("/api/events/stream");
  src.onmessage = (msg) => {
    try { onAgentEvent(JSON.parse(msg.data)); } catch { /* drop it */ }
  };
  // EventSource reconnects on its own; the only thing worth handling is that
  // a console left open overnight should not stack up dead columns.
  src.onerror = () => { for (const m of minds.values()) m.box.classList.remove("live"); };
}
