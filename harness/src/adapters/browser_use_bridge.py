"""Bridge process for the Browser-Use adapter.

Browser-Use is a Python library and the harness is TypeScript, so the adapter
runs the agent out-of-process and talks to it over stdin/stdout JSON.

The agent attaches to the SAME Solari session the harness already prepared, by
CDP URL. That is what keeps the experiment honest: the injected latency, 5xx
and login wall are installed on that browser's context, so Browser-Use meets
exactly the faults the scripted baseline met.

Protocol
    stdin   one JSON object: {cdpUrl, goal, extract, model, maxSteps}
            where model is {provider, model, apiKey, baseUrl?} — resolved on
            the TypeScript side so there is one source of truth for it
    stdout  agent logs, then one final line:
            __SPLITFLAP__{"ok": true, "answer": {...}, "steps": [...]}

Requires:  pip install browser-use
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys

SENTINEL = "__SPLITFLAP__"


def emit(payload: dict) -> None:
    """Write the single machine-readable line the TS side parses."""
    sys.stdout.write(SENTINEL + json.dumps(payload) + "\n")
    sys.stdout.flush()


def build_llm(cfg: dict):
    """Build the chat model the TS side resolved.

    OpenRouter speaks the OpenAI wire format, so it is just ChatOpenAI pointed
    at a different base URL — one key, any model.
    """
    provider = cfg["provider"]
    if provider in ("openai", "openrouter"):
        from browser_use.llm import ChatOpenAI

        kwargs = {"model": cfg["model"], "api_key": cfg["apiKey"]}
        if cfg.get("baseUrl"):
            kwargs["base_url"] = cfg["baseUrl"]
        return ChatOpenAI(**kwargs)
    if provider == "anthropic":
        from browser_use.llm import ChatAnthropic

        return ChatAnthropic(model=cfg["model"], api_key=cfg["apiKey"])
    raise ValueError(f"unsupported model provider {provider!r}")


def answer_prompt(extract: dict | None) -> str:
    """Ask for the answer in a shape the harness' assertions can score.

    Browser-Use returns free prose by default, which would score differently
    from the scripted baseline on the same end state. Pinning the output to a
    JSON object keeps the dashboard's columns comparable.
    """
    if not extract:
        return ""
    if extract["shape"] == "list":
        shape = '{"values": ["…", "…"]}'
    else:
        shape = '{"value": "…"}'
    return (
        f"\n\nWhen you are done, report {extract['instruction']}. "
        f"Your final answer MUST be exactly one JSON object of the form {shape} "
        "and nothing else."
    )


def parse_answer(raw: str, extract: dict | None) -> dict:
    """Pull the JSON object out of the agent's final message, leniently."""
    if not extract:
        return {}
    key, shape = extract["as"], extract["shape"]
    text = (raw or "").strip()

    # The model is asked for bare JSON but often wraps it in prose or a fence.
    for candidate in re.findall(r"\{.*?\}", text, re.S):
        try:
            obj = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if shape == "list" and isinstance(obj.get("values"), list):
            return {key: [str(v) for v in obj["values"]]}
        if shape == "text" and "value" in obj:
            return {key: str(obj["value"])}

    # Fall back to the raw text rather than losing the run entirely; the
    # assertions will judge whether it was good enough.
    return {key: [text] if shape == "list" else text}


async def main() -> int:
    req = json.loads(sys.stdin.read())

    try:
        from browser_use import Agent
        from browser_use.browser import BrowserProfile, BrowserSession
    except ImportError:
        emit({"ok": False, "error": "browser-use is not installed — run: pip install browser-use"})
        return 1

    extract = req.get("extract")
    steps: list[str] = []

    session = BrowserSession(
        browser_profile=BrowserProfile(cdp_url=req["cdpUrl"], is_local=False)
    )
    try:
        agent = Agent(
            task=req["goal"] + answer_prompt(extract),
            llm=build_llm(req["model"]),
            browser_session=session,
        )
        history = await agent.run(max_steps=req.get("maxSteps", 25))

        # `final_result` is the documented accessor; stay defensive because the
        # history object's surface has moved between releases.
        raw = ""
        if hasattr(history, "final_result"):
            raw = history.final_result() or ""
        elif hasattr(history, "history") and history.history:
            raw = str(history.history[-1])

        if hasattr(history, "action_names"):
            steps = [str(a) for a in history.action_names()]

        emit({"ok": True, "answer": parse_answer(raw, extract), "steps": steps, "raw": raw})
        return 0
    except Exception as err:  # surfaced as a run error, not a harness crash
        emit({"ok": False, "error": f"{type(err).__name__}: {err}"})
        return 1
    finally:
        # Only detaches this client. The Solari session belongs to the runner,
        # which releases it after flushing the recording.
        close = getattr(session, "kill", None) or getattr(session, "close", None)
        if close:
            try:
                result = close()
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                pass


if __name__ == "__main__":
    os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
    sys.exit(asyncio.run(main()))
