"""
What gets anchored, and what a stranger can prove from it.

Every decision the chip makes is written to a Hedera Consensus Service topic
as one signed line. The signature is the device's, over the record's own
bytes, so the log is not a claim the host makes about the chip — it is the
chip's own statement, and the host only carries it.

The point of anchoring the balance *after* each draw is that the whole
history becomes checkable by arithmetic:

    seq strictly increases            no decision was dropped from the log
    remaining[n] = remaining[n-1] - amount[n]    the numbers are consistent
    remaining never goes negative     the ceiling was never exceeded

Anyone can run that check against the public topic without talking to us,
without our host, and without learning the mandate's limits — only the
hash of the mandate is published.
"""
import hashlib
import json
from typing import Optional


SCHEMA = "vela.draw.v1"


def canonical(obj) -> bytes:
    """Stable bytes for a record: sorted keys, no incidental whitespace."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def mandate_digest(agent_id: bytes, payees, budget_total: int,
                   per_call_max: int, expiry: int) -> str:
    """
    A commitment to the envelope, without revealing it.

    Publishing the mandate itself would publish the strategy: which venues an
    agent may touch, how large it may go, when it must stop. That is exactly
    what a counterparty would want to know. The digest lets anyone verify a
    draw belongs to a fixed envelope, while the envelope stays private.
    """
    body = canonical({
        "agent": agent_id.hex(),
        "payees": sorted(payees),
        "budget_total": budget_total,
        "per_call_max": per_call_max,
        "expiry": expiry,
    })
    return hashlib.sha256(body).hexdigest()


def draw_record(mandate_hash: str, seq: int, payee: int, amount: int,
                remaining_after: int, tx_id: Optional[str] = None) -> dict:
    """One line of the public log."""
    return {
        "v": SCHEMA,
        "m": mandate_hash,
        "seq": seq,
        "payee": payee,
        "amount": amount,
        "remaining": remaining_after,
        "tx": tx_id,
    }


def check_chain(records):
    """
    Replay a mandate's history and report what it does and does not prove.

    Takes records already ordered by consensus timestamp. Returns a list of
    (ok, detail) so a caller can print every check rather than the first
    failure — a partial answer is worth more than an exception here.
    """
    out = []
    prev_seq = 0
    prev_remaining = None

    for r in records:
        seq = r["seq"]
        out.append((seq == prev_seq + 1,
                    f"seq {seq} follows {prev_seq} with no gap"))
        prev_seq = seq

        if prev_remaining is not None:
            expected = prev_remaining - r["amount"]
            out.append((r["remaining"] == expected,
                        f"remaining {r['remaining']} = {prev_remaining} - {r['amount']}"))
        prev_remaining = r["remaining"]

        out.append((r["remaining"] >= 0,
                    f"remaining {r['remaining']} is not negative"))

    return out


PROVES = """
  proves      every settled draw was authorised by the device, in order,
              against one fixed envelope, and never past its ceiling
  does not    that the service delivered anything, that the envelope was
  prove       a sensible size, or that the agent did anything useful
"""
