#!/usr/bin/env python3
"""Drive the companion web app's own UI and write the Phase 8b evidence.

Six proofs, one process per set:

  1 chat turn            real 8a stack, real model endpoint
  2 restart durability   real 8a stack, real model endpoint
  3 lock concurrency     proof stack (repo LLMock + computer stub)
  4 routine fire         proof stack
  5 approval resume      proof stack
  6 SSE idle             proof stack

Every proof writes PNG screenshots plus a JSON record into --out, and prints what it asserted.
Nothing is "asserted" in prose: a proof either found the thing on screen or it failed loudly with
the page text it saw instead.

Usage:
  python driver.py --base http://127.0.0.1:3101 --out ../../docs/proofs/phase8b --proof 1
  python driver.py --base http://127.0.0.1:3101 --out ... --proof 2-before
  # recreate the companion container here (see README)
  python driver.py --base http://127.0.0.1:3101 --out ... --proof 2-after
  python driver.py --base http://127.0.0.1:3102 --out ... --proof 3,4,5,6
"""

import argparse
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

COMPOSER = '[aria-label="Message"]'
SEND = '[aria-label="Send message"]'
APPROVAL_REGION = '[role="region"][aria-label="Waiting for your approval"]'


def stamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


class Evidence:
    """One run's records: screenshots on disk, assertions in JSON."""

    def __init__(self, out_dir: str):
        self.out_dir = os.path.abspath(out_dir)
        os.makedirs(self.out_dir, exist_ok=True)
        self.records = []
        self.started = stamp()

    def shot(self, page, name: str) -> str:
        path = os.path.join(self.out_dir, f"{name}.png")
        page.screenshot(path=path, full_page=False)
        print(f"  shot -> {path}")
        return path

    def record(self, proof: str, ok: bool, **fields) -> None:
        entry = {"proof": proof, "ok": ok, "at": stamp(), **fields}
        self.records.append(entry)
        path = os.path.join(self.out_dir, "results.json")
        previous = []
        if os.path.exists(path):
            with open(path) as handle:
                previous = json.load(handle)
        previous.append(entry)
        with open(path, "w") as handle:
            json.dump(previous, handle, indent=2)
        print(f"  record -> {json.dumps(entry, indent=2)}")

    def write(self, name: str, payload) -> str:
        path = os.path.join(self.out_dir, name)
        with open(path, "w") as handle:
            if isinstance(payload, str):
                handle.write(payload)
            else:
                json.dump(payload, handle, indent=2)
        print(f"  file -> {path}")
        return path


def body(page) -> str:
    try:
        return page.locator("body").inner_text()
    except Exception as error:  # a page mid-navigation is not a proof failure on its own
        return f"<body unavailable: {error}>"


def open_chat(page, base: str, timeout_ms: int = 45_000):
    page.goto(base, wait_until="domcontentloaded", timeout=timeout_ms)
    if "/onboarding" in page.url:
        raise SystemExit(
            "the app is still on onboarding; finish it once before running the proofs: " f"{page.url}"
        )
    page.wait_for_selector(COMPOSER, timeout=timeout_ms, state="visible")
    page.wait_for_timeout(1500)
    return page


def send(page, text: str) -> None:
    box = page.locator(COMPOSER).first
    box.click()
    page.wait_for_timeout(200)
    page.keyboard.type(text, delay=6)
    page.wait_for_timeout(250)
    page.locator(SEND).first.click()
    print(f"  sent: {text[:90]}")


def compose(page, text: str, wait_s: int = 120) -> None:
    """Type a message and leave it unsent, waiting first if a run still holds the thread.

    A tab whose thread has a run in flight shows `Stop the Bot` instead of `Send message`, so a
    proof that needs two tabs holding a typed message has to wait that run out. Re-typing is safe
    here because nothing was sent.
    """
    deadline = time.time() + wait_s
    while True:
        try:
            page.wait_for_selector(COMPOSER, timeout=5000, state="visible")
            box = page.locator(COMPOSER).first
            box.click(timeout=5000)
            page.wait_for_timeout(150)
            page.keyboard.type(text, delay=4)
            page.wait_for_timeout(300)
            if page.locator(SEND).first.is_visible():
                return
        except Exception:
            pass
        if time.time() > deadline:
            raise SystemExit(
                f"FAILED: no send button after {wait_s}s; the thread still has a run in flight"
            )
        print("  thread busy, waiting for the run to finish before typing again")
        page.wait_for_timeout(3000)


def wait_for_text(page, needle: str, timeout_s: int, label: str) -> str:
    deadline = time.time() + timeout_s
    last = ""
    while time.time() < deadline:
        page.wait_for_timeout(1000)
        last = body(page)
        if needle in last:
            print(f"  found {label!r} after {timeout_s - (deadline - time.time()):.0f}s")
            return last
    tail = last[-2500:]
    raise SystemExit(
        f"FAILED: {label} did not appear within {timeout_s}s.\n--- page text tail ---\n{tail}"
    )


def wait_settled(page, needle: str, quiet_s: float = 4.0, timeout_s: int = 180) -> str:
    """Wait for `needle`, then for the page to stop changing: a reply has landed, not started."""
    text = wait_for_text(page, needle, timeout_s, needle)
    dead = time.time() + quiet_s
    last_change = time.time()
    while time.time() < dead and time.time() < last_change + quiet_s:
        page.wait_for_timeout(700)
        now = body(page)
        if now != text:
            text, last_change = now, time.time()
    return text


class Net:
    """Every /api response this page saw, in order."""

    def __init__(self, page):
        self.entries = []
        page.on("response", self._on_response)

    def _on_response(self, response):
        if "/api/" not in response.url:
            return
        self.entries.append(
            {
                "at": stamp(),
                "status": response.status,
                "method": response.request.method,
                "url": response.url,
            }
        )

    def statuses(self, path_fragment: str):
        return [e for e in self.entries if path_fragment in e["url"]]

    def dump(self) -> str:
        return "\n".join(f"{e['at']} {e['status']} {e['method']} {e['url']}" for e in self.entries)


def http_json(url: str):
    with urllib.request.urlopen(url, timeout=10) as handle:
        return json.load(handle)


# --------------------------------------------------------------------------------------- proofs


def proof_1(ev: Evidence, browser, args) -> None:
    """A real chat turn through the UI, with the model API only."""
    print("\n== proof 1: chat turn through the UI (real model endpoint) ==")
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    net = Net(page)
    open_chat(page, args.base)

    ask = "Reply with exactly this line and nothing else: PHASE8B REAL MODEL OK"
    started = time.time()
    send(page, ask)
    text = wait_settled(page, "PHASE8B REAL MODEL OK", quiet_s=3.0, timeout_s=240)
    elapsed = time.time() - started
    occurrences = text.count("PHASE8B REAL MODEL OK")
    shot = ev.shot(page, "01-chat-turn")
    runs = net.statuses("/engine/agent/")
    ev.write("01-network.log", net.dump())
    ok = occurrences >= 2 and any(r["status"] == 200 and r["url"].endswith("/run") for r in runs)
    ev.record(
        "1",
        ok,
        screenshot=os.path.basename(shot),
        prompt=ask,
        reply_occurrences=occurrences,
        seconds=round(elapsed, 1),
        run_posts=[{"status": r["status"], "url": r["url"]} for r in runs],
        note="reply text is the model's own answer to the prompt; it appears as the user's line and as the Bot's reply",
    )
    ctx.close()


def proof_2_before(ev: Evidence, browser, args) -> None:
    """Send a marker, wait for the Bot's reply, and record what the UI shows before a restart."""
    print("\n== proof 2 (before restart): seed the conversation ==")
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    open_chat(page, args.base)

    token = f"RESTART8B-{int(time.time())}"
    ask = f"Repeat this exact marker back to me, then say one short sentence about persistence: {token}"
    send(page, ask)
    text = wait_settled(page, token, quiet_s=4.0, timeout_s=240)
    occurrences = text.count(token)
    shot = ev.shot(page, "02a-before-restart")
    ev.write("02-before-state.json", {"token": token, "occurrences": occurrences, "body_tail": text[-1500:]})
    ev.record(
        "2-before",
        occurrences >= 2,
        screenshot=os.path.basename(shot),
        token=token,
        occurrences=occurrences,
    )
    ctx.close()


def proof_2_after(ev: Evidence, browser, args) -> None:
    """After the companion container was recreated: the conversation is still there."""
    print("\n== proof 2 (after restart): the conversation is still on screen ==")
    state_path = os.path.join(os.path.abspath(args.out), "02-before-state.json")
    with open(state_path) as handle:
        state = json.load(handle)
    token = state["token"]

    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    open_chat(page, args.base)
    text = wait_for_text(page, token, 120, f"marker {token} after restart")
    occurrences = text.count(token)
    first = ev.shot(page, "02b-after-restart")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector(COMPOSER, state="visible", timeout=45_000)
    page.wait_for_timeout(3000)
    text2 = wait_for_text(page, token, 120, f"marker {token} after a second load")
    second = ev.shot(page, "02c-after-restart-reload")
    ev.record(
        "2-after",
        occurrences >= 2 and text2.count(token) >= 2,
        screenshots=[os.path.basename(first), os.path.basename(second)],
        token=token,
        occurrences_after_restart=occurrences,
        occurrences_after_reload=text2.count(token),
    )
    ctx.close()


def proof_3(ev: Evidence, browser, args) -> None:
    """Two actions sent by two tabs at the same moment: the loser is refused with a real 409.

    A tab that is already watching a run loses its send button, so the race has to be set up
    the way the collision really happens: two people (or one person with two tabs) both hold a
    typed message, and both press send. The winner takes the thread lock; the loser's
    `POST /agent/:id/run` is answered 409 by `claimRunLock` before any run starts.

    Tab order and a sub-second click gap are kept from a measurement on this stack: a tab that
    has not yet seen the run keeps its send button for roughly 150 ms, which is the window the
    second click has to land in.
    """
    print("\n== proof 3: lock concurrency, two tabs send at the same moment ==")
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    holder_tab = ctx.new_page()
    rival_tab = ctx.new_page()
    net_holder = Net(holder_tab)
    net_rival = Net(rival_tab)
    refusals = []

    def watch(response):
        if not response.url.endswith("/run") or response.status != 409:
            return
        detail = {"at": stamp(), "status": response.status, "url": response.url, "body": None}
        try:
            detail["body"] = response.text()[:400]
        except Exception as error:  # the status is the evidence; the body is a bonus
            detail["body"] = f"<unreadable: {error}>"
        refusals.append(detail)

    rival_tab.on("response", watch)

    for tab, text in (
        (holder_tab, "LOCK8B hold this thread while I try something else"),
        (rival_tab, "PROOF3-8B second action while the first one is still running"),
    ):
        open_chat(tab, args.base)
        compose(tab, text)

    if not rival_tab.locator(SEND).first.is_visible():
        raise SystemExit("FAILED: the second tab had no send button before the race, so it could not collide")

    holder_tab.locator(SEND).first.click()
    raced_at = time.time()
    rival_click_at = None
    deadline = time.time() + 10
    while time.time() < deadline:
        if not rival_tab.locator(SEND).first.is_visible():
            break
        try:
            rival_tab.locator(SEND).first.click(timeout=300)
            rival_click_at = round(time.time() - raced_at, 2)
            break
        except Exception:
            pass
        time.sleep(0.02)
    print(f"  second tab pressed send {rival_click_at}s after the first")

    deadline = time.time() + 45
    while time.time() < deadline and not refusals:
        rival_tab.wait_for_timeout(100)
    shot_rival = ev.shot(rival_tab, "03-lock-409-second-tab")
    rival_tab.wait_for_timeout(1200)
    shot_rival_late = ev.shot(rival_tab, "03b-lock-409-second-tab-after-the-refusal")
    shot_holder = ev.shot(holder_tab, "03c-lock-409-holder-tab")

    holder_runs = [r for r in net_holder.statuses("/engine/agent/") if r["url"].endswith("/run")]
    rival_runs = [r for r in net_rival.statuses("/engine/agent/") if r["url"].endswith("/run")]
    ev.write("03-network-holder-tab.log", net_holder.dump())
    ev.write("03-network-second-tab.log", net_rival.dump())
    ev.write("03-refusal.json", refusals)
    print(f"  holder POST /run -> {[r['status'] for r in holder_runs]}")
    print(f"  rival  POST /run -> {[r['status'] for r in rival_runs]}")
    print(f"  refusals: {json.dumps(refusals, indent=2)}")

    ok = bool(refusals) and any(r["status"] == 200 for r in holder_runs)
    ev.record(
        "3",
        ok,
        screenshots=[
            os.path.basename(shot_rival),
            os.path.basename(shot_rival_late),
            os.path.basename(shot_holder),
        ],
        click_gap_seconds=rival_click_at,
        holder_run_statuses=[r["status"] for r in holder_runs],
        rival_run_statuses=[r["status"] for r in rival_runs],
        http_409=refusals,
        second_tab_text_tail=body(rival_tab)[-600:],
    )
    ctx.close()


def proof_4(ev: Evidence, browser, args) -> None:
    """A routine created in the conversation fires on its schedule and lands in the UI untouched."""
    print("\n== proof 4: scheduled routine fires and appears live ==")
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    open_chat(page, args.base)

    send(page, "ROUTINE8B-SETUP set up the routine that posts the standup summary every day at this minute")
    wait_settled(page, "ROUTINE8B the routine is set", quiet_s=3.0, timeout_s=180)
    created_at = stamp()
    shot_created = ev.shot(page, "04a-routine-created")

    page.goto(f"{args.base}/routines", wait_until="domcontentloaded")
    page.wait_for_timeout(4000)
    routines_text = body(page)
    shot_list = ev.shot(page, "04b-routines-page")

    open_chat(page, args.base)
    page.evaluate(
        """() => {
            window.__proof4 = { pointer: 0, keys: 0 };
            const bump = (kind) => () => { window.__proof4[kind] += 1; };
            window.addEventListener('pointerdown', bump('pointer'), true);
            window.addEventListener('keydown', bump('keys'), true);
        }"""
    )
    print("  idle now: no clicks, no keys, waiting for the routine to fire")
    started = time.time()
    text = wait_for_text(page, "ROUTINE8B scheduled turn ran", 300, "the routine's turn in the chat")
    waited = time.time() - started
    acts = page.evaluate("() => window.__proof4")
    shot_fired = ev.shot(page, "04c-routine-fired-live")
    ev.write("04-fire-body.txt", text[-2000:])
    ev.record(
        "4",
        acts["pointer"] == 0 and acts["keys"] == 0,
        screenshots=[
            os.path.basename(shot_created),
            os.path.basename(shot_list),
            os.path.basename(shot_fired),
        ],
        created_at=created_at,
        fired_after_seconds=round(waited, 1),
        interactions_while_waiting=acts,
        routines_page_shows_schedule="ROUTINE8B" in routines_text or "/routines" in page.url,
        routines_page_text_tail=routines_text[-600:],
    )
    ctx.close()


def proof_5(ev: Evidence, browser, args) -> None:
    """An approval gate pauses the turn, a real operator click resumes it, one action runs."""
    print("\n== proof 5: approval pause and resume ==")
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    net = Net(page)
    open_chat(page, args.base)

    try:
        http_json(f"{args.computer}/reset")
    except Exception as error:
        print(f"  warning: could not reset the computer stub: {error}")

    send(page, "APPROVAL8B submit the form on the page")
    page.wait_for_selector(APPROVAL_REGION, timeout=120_000, state="visible")
    paused_at = stamp()
    shot_paused = ev.shot(page, "05a-paused-waiting-for-approval")
    before = http_json(f"{args.computer}/calls")
    clicks_before = [c for c in before if c["path"] == "/click"]

    allow = page.get_by_role("button", name="Allow once")
    allow.first.click()
    print("  clicked Allow once")
    page.wait_for_timeout(1000)
    decisions = net.statuses("/approvals/")
    text = wait_for_text(page, "APPROVAL8B the form was submitted.", 300, "the resumed reply")
    shot_resumed = ev.shot(page, "05b-resumed-after-allow-once")
    after = http_json(f"{args.computer}/calls")
    clicks_after = [c for c in after if c["path"] == "/click"]
    ev.write("05-network.log", net.dump())
    ev.record(
        "5",
        len(clicks_before) == 0 and len(clicks_after) == 1,
        screenshots=[os.path.basename(shot_paused), os.path.basename(shot_resumed)],
        paused_at=paused_at,
        decision_posts=[{"status": r["status"], "url": r["url"]} for r in decisions],
        computer_clicks_before_allow=len(clicks_before),
        computer_clicks_after_allow=len(clicks_after),
        click_evidence=clicks_after,
        resumed_text_tail=text[-800:],
    )
    ctx.close()


def proof_6(ev: Evidence, browser, args) -> None:
    """One run stream survives a longer silence than the server's ten-second idle timeout."""
    print("\n== proof 6: the run stream survives past the idle timeout ==")
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    net = Net(page)

    cdp = ctx.new_cdp_session(page)
    cdp.send("Network.enable")
    urls = {}
    frames = []

    def on_request(params):
        urls[params["requestId"]] = params["request"]["url"]

    def on_frame(params):
        frames.append(
            {
                "requestId": params["requestId"],
                "timestamp": params["timestamp"],
                "dataLength": params.get("dataLength", 0),
            }
        )

    cdp.on("Network.requestWillBeSent", on_request)
    cdp.on("Network.dataReceived", on_frame)

    open_chat(page, args.base)
    frames.clear()
    urls.clear()

    model_before = http_json(f"{args.model}/requests")
    send(page, "SLOW8B answer me, but say nothing at all for a while first")
    started = time.time()
    text = wait_settled(page, "SLOW8B reply arrived after fourteen seconds", quiet_s=3.0, timeout_s=180)
    elapsed = time.time() - started
    shot = ev.shot(page, "06-sse-idle-survived")
    model_after = http_json(f"{args.model}/requests")

    run_ids = [rid for rid, url in urls.items() if url.endswith("/run")]
    per_run = {}
    for rid in run_ids:
        entries = sorted([f for f in frames if f["requestId"] == rid], key=lambda f: f["timestamp"])
        if not entries:
            continue
        base_ts = entries[0]["timestamp"]
        per_run[rid] = {
            "url": urls[rid],
            "frames": len(entries),
            "total_data_bytes": sum(f["dataLength"] for f in entries),
            "first_frame_s": 0.0,
            "last_frame_s": round(entries[-1]["timestamp"] - base_ts, 2),
            "frame_offsets_s": [round(f["timestamp"] - base_ts, 2) for f in entries],
        }

    longest = max((v["last_frame_s"] for v in per_run.values()), default=0.0)
    single_connection = len(per_run) == 1
    ev.write("06-network.log", net.dump())
    ev.write("06-sse-frames.json", {"runs": per_run, "model_requests": model_after})
    ev.record(
        "6",
        single_connection and longest > 10.0,
        screenshot=os.path.basename(shot),
        run_streams=len(per_run),
        seconds_the_stream_stayed_open=longest,
        previous_timeout_seconds=10.0,
        elapsed_to_reply=round(elapsed, 1),
        run_detail=per_run,
        model_request_count_before=len(model_before),
        model_request_count_after=len(model_after),
        note="one POST /run kept receiving bytes after a single silence longer than Bun's 10s idle timeout",
    )
    ctx.close()


PROOFS = {
    "1": proof_1,
    "2-before": proof_2_before,
    "2-after": proof_2_after,
    "3": proof_3,
    "4": proof_4,
    "5": proof_5,
    "6": proof_6,
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:3101")
    parser.add_argument("--out", default="../../docs/proofs/phase8b")
    parser.add_argument("--proof", default="1")
    parser.add_argument("--model", default="http://127.0.0.1:7032")
    parser.add_argument("--computer", default="http://127.0.0.1:4231")
    args = parser.parse_args()

    ev = Evidence(args.out)
    wanted = [part.strip() for part in args.proof.split(",") if part.strip()]
    print(f"evidence dir: {ev.out_dir}\nbase: {args.base}\nproofs: {wanted}")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"]
        )
        try:
            for name in wanted:
                step = PROOFS.get(name)
                if step is None:
                    raise SystemExit(f"unknown proof {name!r}; pick from {sorted(PROOFS)}")
                step(ev, browser, args)
        finally:
            browser.close()

    failed = [r["proof"] for r in ev.records if not r["ok"]]
    print("\n" + ("ALL REQUESTED PROOFS PASSED" if not failed else f"FAILED PROOFS: {failed}"))
    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    main()
