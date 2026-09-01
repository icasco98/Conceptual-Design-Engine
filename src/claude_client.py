"""Thin wrapper around the Anthropic client.

Deterministic geometry and validation live in src.geometry / src.validation.
Claude's job here is narrow: (1) turn plain-language conversation into the
structured Project shape (src.extraction), and (2) explain constraint
conflicts that Python already found, in plain language (explain_issues
below). Claude never computes the geometry itself.
"""

from __future__ import annotations

from functools import lru_cache
from typing import List

import anthropic

from src.validation import Issue

MODEL = "claude-opus-5"


@lru_cache(maxsize=1)
def get_client() -> anthropic.Anthropic:
    # Anthropic() resolves ANTHROPIC_API_KEY (or another configured credential)
    # from the environment; app.py loads .env before this is first called.
    return anthropic.Anthropic()


EXPLAIN_SYSTEM_PROMPT = """\
You are the plain-language explanation layer of a conceptual house-design \
tool. Python has already computed a buildable envelope and checked the \
room program against it; you are given the exact issues it found. Explain \
them to the homeowner in a few short, friendly sentences — no jargon, no \
raw numbers dumped without context, no restating the issue codes. Where \
relevant, connect the explanation to the priorities they told you about. \
End with one concrete, low-effort suggestion for what they could tell you \
next to resolve the biggest issue — a room to shrink, drop, or move to a \
different priority. Setbacks (2m street-facing, 1.5m neighbor-facing) are \
confident defaults, not something to second-guess: never suggest "double \
checking" or reconsidering a setback — only mention changing one if the \
owner has already brought it up themselves. Do not invent new numeric \
values — you may reference the numbers already given to you, but do not \
compute new ones."""


def explain_issues(
    project_summary: str,
    priorities: List[str],
    issues: List[Issue],
) -> str:
    """Ask Claude to explain deterministic validation issues in plain language."""
    issues_text = "\n".join(f"- [{issue.severity}] {issue.message}" for issue in issues)
    priorities_text = ", ".join(priorities) if priorities else "none stated yet"

    user_content = (
        f"Project so far:\n{project_summary}\n\n"
        f"Owner's stated priorities: {priorities_text}\n\n"
        f"Issues Python found:\n{issues_text}"
    )

    response = get_client().messages.create(
        model=MODEL,
        max_tokens=1024,
        system=EXPLAIN_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_content}],
    )
    return next((b.text for b in response.content if b.type == "text"), "").strip()
