"""
The control: spend governance the way everyone else does it.

This is an honest implementation of the state of the art. Caps, budgets, an
allowlist, expiry, reserve-and-release, structured refusals — the same rules
the chip enforces, enforced here instead, in a process on the host.

It is not a straw man. It is what a competent engineer writes, and it works.
The point of shipping it is that Vela's claim is not "we have rules and they
do not". Both have the same rules. The difference is where they live, and
that difference only shows up when the host is no longer trustworthy.

Same interface as the device, so the agent cannot tell which one it is
talking to — which is what makes the comparison a measurement rather than
an assertion.
"""
import json
import os
import time
from dataclasses import asdict, dataclass, field

STATE = os.environ.get("VELA_SOFTWARE_STATE", "/tmp/vela-software-state.json")


class Refused(Exception):
    def __init__(self, code, why):
        super().__init__(why)
        self.code = code
        self.why = why


@dataclass
class Mandate:
    agent: str
    payees: list
    budget_total: int
    per_call_max: int
    expiry: int = 0
    reserved: int = 0
    spent: int = 0
    seq: int = 0

    @property
    def available(self):
        return max(0, self.budget_total - self.reserved - self.spent)


@dataclass
class Store:
    """Where the rules live: a file, on the machine running the agent."""
    mandates: dict = field(default_factory=dict)

    @classmethod
    def load(cls):
        if not os.path.exists(STATE):
            return cls()
        with open(STATE) as f:
            raw = json.load(f)
        return cls({int(k): Mandate(**v) for k, v in raw.get("mandates", {}).items()})

    def save(self):
        with open(STATE, "w") as f:
            json.dump({"mandates": {str(k): asdict(v) for k, v in self.mandates.items()}}, f,
                      indent=2)

    def create(self, agent, payees, budget_total, per_call_max, expiry=0):
        slot = next((i for i in range(3) if i not in self.mandates), None)
        if slot is None:
            raise Refused("no_slot", "every mandate slot is occupied")
        self.mandates[slot] = Mandate(agent, list(payees), budget_total, per_call_max, expiry)
        self.save()
        return slot

    def authorize(self, slot, payee, amount, now=None):
        now = int(time.time()) if now is None else now
        m = self.mandates.get(slot)
        if m is None:
            raise Refused("not_found", "no mandate in that slot")
        if m.expiry and now >= m.expiry:
            raise Refused("expired", "the envelope has expired")
        if payee not in m.payees:
            raise Refused("payee_not_allowed", "payee is not on the allowlist")
        if amount > m.per_call_max:
            raise Refused("over_per_call", "over the per-call ceiling")
        if amount > m.available:
            raise Refused("over_budget", "over what is left in the envelope")

        m.reserved += amount
        m.seq += 1
        self.save()
        return m.seq, m.available

    def settle(self, slot, quoted, actual):
        m = self.mandates.get(slot)
        if m is None:
            raise Refused("not_found", "no mandate in that slot")
        if actual > quoted or quoted > m.reserved:
            raise Refused("bad_settle_amount", "settling more than was authorised")
        m.reserved -= quoted
        m.spent += actual
        self.save()
        return m.spent, m.available

    def revoke(self, slot):
        self.mandates.pop(slot, None)
        self.save()
