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
  slot.className = "slot";
  // The slot is the chip's fact, not the agent's claim, so it is read from
  // the fleet the device reported rather than from the message.
  const known = (window.__fleet ?? []).find((a) => a.label === agent);
  slot.textContent = known ? `slot ${known.slot}` : "unclaimed slot";
  head.append(who, slot);

  const steps = document.createElement("ol");
  steps.className = "steps";

  box.append(head, steps);

  const host = document.getElementById("minds");
  const empty = host.querySelector(".none");
  if (empty) empty.remove();
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
    const m = mindFor(e.agent);
    if (e.model) {
      const tag = document.createElement("span");
      tag.className = "slot";
      tag.textContent = ` · ${e.model}`;
      m.box.querySelector("header .slot")?.append(tag);
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
    if (e.thought) {
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

function watchAgents() {
  const src = new EventSource("/api/events/stream");
  src.onmessage = (msg) => {
    try { onAgentEvent(JSON.parse(msg.data)); } catch { /* drop it */ }
  };
  // EventSource reconnects on its own; the only thing worth handling is that
  // a console left open overnight should not stack up dead columns.
  src.onerror = () => { for (const m of minds.values()) m.box.classList.remove("live"); };
}
