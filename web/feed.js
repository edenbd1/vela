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

function labelSlot(el) {
  const known = (window.__fleet ?? []).find((a) => a.label === el.dataset.agent);
  // Composed from the two facts, not appended to whatever the text already
  // said. Appending made the model tag something this could only add and
  // never rewrite — so re-reading the slot wiped the model, and two `start`
  // events in one run wrote the model twice.
  el.textContent = [known ? `slot ${known.slot}` : "unclaimed slot",
                    el.dataset.model].filter(Boolean).join(" · ");
}

/**
 * Re-read every column's slot off the fleet.
 *
 * Called whenever the fleet is re-read, because "unclaimed slot" is a claim
 * about the chip and it must not survive the chip answering. It is also the
 * honest label for an agent the device has never heard of — an agent
 * reporting under a name no mandate carries — and that case has to keep
 * working, so this sets the text either way rather than only on a hit.
 */
function relabelSlots() {
  for (const el of document.querySelectorAll("#minds .meta[data-agent]")) {
    labelSlot(el);
  }
}

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
  //
  // And re-read later, which is the part that was missing. The event stream
  // replays on connect, so these columns are built in the same tick the page
  // loads — while the fetch that fills window.__fleet is still in flight.
  // Whoever lost that race got "unclaimed slot" permanently, printed directly
  // above a fleet card showing the slot it was in.
  slot.dataset.agent = agent;
  head.append(who, slot);
  labelSlot(slot);

  // One line saying what this agent did, always visible. The transcript below
  // it is the evidence and it is also a wall of text: three of these filled
  // the page and a reader got none of it. So it stays open while the run is
  // live — which is the whole point of watching — and folds into this line
  // when the run ends, unless somebody opens it.
  const sum = document.createElement("button");
  sum.className = "sum";
  sum.setAttribute("aria-expanded", "false");
  sum.textContent = "starting…";
  sum.onclick = () => {
    const open = box.classList.toggle("open");
    sum.setAttribute("aria-expanded", String(open));
  };

  const steps = document.createElement("ol");
  steps.className = "steps";

  box.append(head, sum, steps);

  const host = document.getElementById("minds");
  // The empty state is a sibling of the grid now, not a child of it, so
  // removing "a .none inside #minds" stopped hiding it — and the page told
  // you no agent was running directly above three running agents.
  const empty = document.getElementById("minds-empty");
  if (empty) empty.hidden = true;
  host.append(box);

  const m = { box, steps, sum, last: null,
              n: 0, refused: 0, spent: 0, latest: "" };
  minds.set(agent, m);
  return m;
}

/**
 * What this agent did, in one line.
 *
 * Counted rather than summarised by a model: steps taken, what the chip let
 * it spend, how many times the chip or the broker said no, and the last thing
 * that happened. Every one of those is a number this page already has.
 */
function tally(m, e) {
  if (e.kind === "decision") { m.n++; m.latest = e.call || e.tool; }
  if (e.kind === "refused") {
    m.refused++;
    m.latest = `refused — ${e.reason}`;
  }
  const bought = /cost=([\d.]+) HBAR/.exec(e.summary ?? "");
  if (bought) m.spent += Number(bought[1]);
  if (e.kind === "done") m.latest = "finished";

  const bits = [`${m.n} step${m.n === 1 ? "" : "s"}`];
  if (m.spent > 0) bits.push(`spent ${m.spent.toFixed(2)} HBAR`);
  if (m.refused) bits.push(`refused ${m.refused}×`);
  m.sum.textContent = `${bits.join(" · ")}${m.latest ? ` — ${m.latest}` : ""}`;
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
      if (meta) { meta.dataset.model = e.model; labelSlot(meta); }
    }
    return;
  }

  const m = mindFor(e.agent);
  tally(m, e);

  if (e.kind === "decision") {
    // A model that gets refused and asks for the same thing again is a real
    // and interesting behaviour — one of these ran the identical check nine
    // times after a broker refusal. Printed nine times it reads as a broken
    // console rather than a looping agent, and it pushes everything else off
    // the screen. Said once, with a count.
    const same = m.steps.lastElementChild;
    const signature = `${e.call || e.tool}\u0000${e.thought || ""}`;
    if (same && same.dataset.sig === signature) {
      const n = Number(same.dataset.n || 1) + 1;
      same.dataset.n = n;
      let tag = same.querySelector(".again");
      if (!tag) {
        tag = document.createElement("span");
        tag.className = "again";
        same.append(tag);
      }
      // What was observed, not what it means: these are repeats of one call,
      // and whether each was refused is a separate event this does not see.
      tag.textContent = `asked ${n} times in a row`;
      return;
    }

    const li = document.createElement("li");
    li.dataset.sig = signature;
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
    // The steps list is what scrolls, not the card around it. Scrolling the
    // card did nothing while the list grew without bound, which is how one
    // agent in a retry loop came to set the height of the whole page.
    m.steps.scrollTop = m.steps.scrollHeight;
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
  // A collapsed step gets one copy of its outcome, not one per repeat. An
  // agent that asked the same thing nine times was refused nine times, and
  // nine identical refusals under one line is the thing collapsing was for.
  const host = m.last ?? m.steps;
  const already = [...host.querySelectorAll(".out")]
    .some((n) => n.textContent === out.textContent);
  if (!already) host.append(out);
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
