#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Benchmark pi startup time and memory with vs without the pi-help extension.

Measures two modes (see docs/benchmark.md for full methodology):

- isolated: bare pi (all discovery disabled, empty temp config) vs bare pi +
  only pi-help loaded via -e. Clean, reproducible numbers.
- full: a disposable clone of ~/.pi/agent (sessions/auth excluded, package
  caches symlinked) with the pi-help package toggled via the `-` prefix in
  settings.json. Real-world sanity check; never touches the live config.

Every print-mode run loads scripts/bench-noop.ts via -e and executes
`pi --offline --no-session -p "/<cmd>"`, which exercises full startup and
exits without an LLM turn. auth.json is never copied, so no run can make a
paid model call. TUI startup is measured via pi's built-in
PI_STARTUP_BENCHMARK=1 under a pty (`script -q /dev/null`), timing-only.

Usage: scripts/bench.py [--mode all|isolated|full] [--runs N] [--warmup N]
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NOOP_EXT = REPO / "scripts" / "bench-noop.ts"
HELP_EXT = REPO / "extensions" / "help" / "index.ts"
REAL_AGENT_DIR = Path.home() / ".pi" / "agent"
# Heavy read-only package caches: symlinked into the clone instead of copied.
CLONE_SYMLINK = {"git", "npm"}
# Never copied: sessions are private/huge, auth.json guarantees no paid calls.
CLONE_SKIP = {"sessions", ".git", "auth.json", "pi-crash.log", "run-history.jsonl"}
ISOLATED_FLAGS = ["-ne", "-ns", "-np", "--no-themes", "-nc"]
PIHELP_PKG_RELATIVE = "../../devel/pi-help"


@dataclass
class Scenario:
    name: str
    mode: str  # isolated | full
    pihelp: bool  # is pi-help loaded in this variant
    workload: str  # slash command for print mode, or "TUI"
    results: list[dict] = field(default_factory=list)

    def median(self, key: str) -> float | None:
        vals = [r[key] for r in self.results if r.get(key) is not None]
        return statistics.median(vals) if vals else None

    def stdev(self, key: str) -> float | None:
        vals = [r[key] for r in self.results if r.get(key) is not None]
        return statistics.stdev(vals) if len(vals) > 1 else None


def fail(msg: str) -> "NoReturn":  # noqa: F821
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def build_full_clone(tmp: Path) -> Path:
    """Disposable copy of ~/.pi/agent; APFS clonefile when possible."""
    clone = tmp / "agent-full"
    clone.mkdir()
    for item in sorted(REAL_AGENT_DIR.iterdir()):
        if item.name in CLONE_SKIP:
            continue
        if item.name in CLONE_SYMLINK:
            (clone / item.name).symlink_to(item)
            continue
        if subprocess.run(["cp", "-Rc", str(item), str(clone / item.name)],
                          capture_output=True).returncode != 0:
            if item.is_dir():
                shutil.copytree(item, clone / item.name, symlinks=True)
            else:
                shutil.copy2(item, clone / item.name)
    # The relative package path resolves against settings.json's location,
    # which just moved — rewrite to absolute before anything else.
    settings = clone / "settings.json"
    text = settings.read_text()
    if PIHELP_PKG_RELATIVE not in text:
        fail(f"expected packages entry {PIHELP_PKG_RELATIVE!r} in {REAL_AGENT_DIR}/settings.json")
    settings.write_text(text.replace(f'"{PIHELP_PKG_RELATIVE}"', f'"{REPO}"'))
    return clone


def set_pihelp_enabled(clone: Path, enabled: bool) -> None:
    settings = clone / "settings.json"
    text = settings.read_text().replace(f'"-{REPO}"', f'"{REPO}"')
    if not enabled:
        text = text.replace(f'"{REPO}"', f'"-{REPO}"')
    settings.write_text(text)


def parse_phases(output: str) -> dict[str, int]:
    return {m[1]: int(m[2]) for m in re.finditer(r"^\s*([\w.]+): (\d+)ms$", output, re.M)}


def parse_max_rss(output: str) -> int | None:
    m = re.search(r"(\d+)\s+maximum resident set size", output)
    return int(m.group(1)) if m else None


class Runner:
    def __init__(self, pi: str, cwd: Path):
        self.pi = pi
        self.cwd = cwd

    def _env(self, agent_dir: Path) -> dict[str, str]:
        env = os.environ.copy()
        env["PI_CODING_AGENT_DIR"] = str(agent_dir)
        env["PI_TIMING"] = "1"
        return env

    def print_mode(self, agent_dir: Path, flags: list[str], extensions: list[Path],
                   command: str) -> dict:
        cmd = ["/usr/bin/time", "-l", self.pi, "--offline", "--no-session", *flags]
        for ext in extensions:
            cmd += ["-e", str(ext)]
        cmd += ["-p", command]
        start = time.perf_counter()
        proc = subprocess.run(cmd, cwd=self.cwd, env=self._env(agent_dir),
                              capture_output=True, text=True, timeout=300)
        wall_ms = (time.perf_counter() - start) * 1000
        if proc.returncode != 0:
            fail(f"run failed ({' '.join(cmd)}):\n{proc.stderr[-2000:]}")
        rss = parse_max_rss(proc.stderr)
        phases = parse_phases(proc.stderr)
        if rss is None or "parseArgs" not in phases:
            fail(f"could not parse time/timing output:\n{proc.stderr[-2000:]}")
        return {"wall_ms": wall_ms, "rss_mb": rss / 1024 / 1024,
                "startup_ms": phases.get("TOTAL"),
                "load_ms": phases.get("createAgentSessionRuntime")}

    def tui_mode(self, agent_dir: Path, flags: list[str], extensions: list[Path]) -> dict:
        # `script` provides the pty PI_STARTUP_BENCHMARK needs; memory through
        # the wrapper is not the pi process's, so this scenario is timing-only.
        cmd = ["script", "-q", "/dev/null", "env",
               f"PI_CODING_AGENT_DIR={agent_dir}", "PI_TIMING=1",
               "PI_STARTUP_BENCHMARK=1", self.pi, "--offline", "--no-session", *flags]
        for ext in extensions:
            cmd += ["-e", str(ext)]
        proc = subprocess.run(cmd, cwd=self.cwd, env=os.environ.copy(),
                              capture_output=True, text=True, timeout=300)
        phases = parse_phases(proc.stdout + proc.stderr)
        if proc.returncode != 0 or "interactiveMode.init" not in phases:
            fail(f"TUI run failed:\n{(proc.stdout + proc.stderr)[-2000:]}")
        return {"init_ms": phases["interactiveMode.init"], "startup_ms": phases.get("TOTAL")}


def run_scenario(runner: Runner, sc: Scenario, agent_dir: Path, runs: int, warmup: int) -> None:
    flags = ISOLATED_FLAGS if sc.mode == "isolated" else []
    extensions = [NOOP_EXT]
    if sc.mode == "isolated" and sc.pihelp:
        extensions.append(HELP_EXT)  # full mode loads pi-help as a package instead
    for i in range(warmup + runs):
        if sc.workload == "TUI":
            result = runner.tui_mode(agent_dir, flags, extensions)
        else:
            result = runner.print_mode(agent_dir, flags, extensions, sc.workload)
        if i >= warmup:
            sc.results.append(result)
    print(f"  {sc.name}: done ({runs} runs)", file=sys.stderr)


def fmt(value: float | None, unit: str = "", digits: int = 1) -> str:
    return "–" if value is None else f"{value:.{digits}f}{unit}"


def delta(a: Scenario, b: Scenario, key: str) -> float | None:
    ma, mb = a.median(key), b.median(key)
    return ma - mb if ma is not None and mb is not None else None


def report(scenarios: dict[str, Scenario], pi_version: str, runs: int) -> str:
    s = scenarios
    out = ["## Benchmark results", ""]
    hw = subprocess.run(["sysctl", "-n", "hw.model", "hw.memsize"],
                        capture_output=True, text=True).stdout.split()
    mem_gb = int(hw[1]) // 2**30 if len(hw) > 1 else "?"
    node = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
    out += [f"- date: {date.today().isoformat()}",
            f"- pi: {pi_version} · node {node}",
            f"- machine: {hw[0] if hw else '?'} · {mem_gb} GB RAM · macOS {platform.mac_ver()[0]}",
            f"- runs per scenario: {runs} (median reported; wall-clock ± stdev)", ""]

    def row(name: str, sc: Scenario) -> str:
        wall = f"{fmt(sc.median('wall_ms'), ' ms')} ± {fmt(sc.stdev('wall_ms'))}"
        rss = f"{fmt(sc.median('rss_mb'), ' MB')} ± {fmt(sc.stdev('rss_mb'))}"
        return (f"| {name} | {wall} | {fmt(sc.median('startup_ms'), ' ms', 0)} | "
                f"{fmt(sc.median('load_ms'), ' ms', 0)} | {rss} |")

    header = ("| scenario | wall-clock | pi startup (internal) | extension load phase | peak RSS |\n"
              "|---|---|---|---|---|")

    for mode in ("isolated", "full"):
        group = {k: v for k, v in s.items() if v.mode == mode and v.workload != "TUI"}
        if not group:
            continue
        out += [f"### {mode} mode", "", header]
        out += [row(k, v) for k, v in group.items()]
        base, withhelp = s.get(f"{mode}-base-noop"), s.get(f"{mode}-help-noop")
        if base and withhelp:
            out += ["", f"**pi-help startup overhead**: "
                    f"{fmt(delta(withhelp, base, 'wall_ms'), ' ms')} wall-clock, "
                    f"{fmt(delta(withhelp, base, 'load_ms'), ' ms', 0)} extension-load phase, "
                    f"{fmt(delta(withhelp, base, 'rss_mb'), ' MB')} peak RSS"]
        lst, detail = s.get(f"{mode}-help-list"), s.get(f"{mode}-help-detail")
        if withhelp and lst and detail:
            out += [f"**feature cost vs startup-only**: "
                    f"/help {fmt(delta(lst, withhelp, 'wall_ms'), ' ms')} / "
                    f"{fmt(delta(lst, withhelp, 'rss_mb'), ' MB')} RSS · "
                    f"/help help {fmt(delta(detail, withhelp, 'wall_ms'), ' ms')} / "
                    f"{fmt(delta(detail, withhelp, 'rss_mb'), ' MB')} RSS"]
        out += [""]

    tui = {k: v for k, v in s.items() if v.workload == "TUI"}
    if tui:
        out += ["### TUI startup (timing-only, pty-wrapped)", "",
                "| scenario | interactiveMode.init | pi startup total |", "|---|---|---|"]
        out += [f"| {k} | {fmt(v.median('init_ms'), ' ms', 0)} | "
                f"{fmt(v.median('startup_ms'), ' ms', 0)} |" for k, v in tui.items()]
        for mode in ("isolated", "full"):
            base, withhelp = tui.get(f"{mode}-base-tui"), tui.get(f"{mode}-help-tui")
            if base and withhelp:
                out += ["", f"**{mode} TUI init overhead**: "
                        f"{fmt(delta(withhelp, base, 'init_ms'), ' ms', 0)}"]
        out += [""]
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--mode", choices=["all", "isolated", "full"], default="all")
    ap.add_argument("--runs", type=int, default=10)
    ap.add_argument("--warmup", type=int, default=3)
    args = ap.parse_args()

    pi = shutil.which("pi")
    if pi is None:
        fail("pi not found on PATH")
    ver = subprocess.run([pi, "--version"], capture_output=True, text=True)
    pi_version = (ver.stdout.strip() or ver.stderr.strip()).split("\n")[0]
    for path in (NOOP_EXT, HELP_EXT):
        if not path.exists():
            fail(f"missing {path}")

    with tempfile.TemporaryDirectory(prefix="pihelp-bench.") as tmpstr:
        tmp = Path(tmpstr)
        cwd = tmp / "cwd"  # neutral cwd: no project .pi/ or AGENTS.md discovery
        cwd.mkdir()
        runner = Runner(pi, cwd)
        scenarios: dict[str, Scenario] = {}

        def run(sc: Scenario, agent_dir: Path) -> None:
            scenarios[sc.name] = sc
            run_scenario(runner, sc, agent_dir, args.runs, args.warmup)

        if args.mode in ("all", "isolated"):
            print("isolated mode:", file=sys.stderr)
            iso_dir = tmp / "agent-isolated"
            run(Scenario("isolated-base-noop", "isolated", False, "/noop"), iso_dir)
            run(Scenario("isolated-help-noop", "isolated", True, "/noop"), iso_dir)
            run(Scenario("isolated-help-list", "isolated", True, "/help"), iso_dir)
            run(Scenario("isolated-help-detail", "isolated", True, "/help help"), iso_dir)
            run(Scenario("isolated-base-tui", "isolated", False, "TUI"), iso_dir)
            run(Scenario("isolated-help-tui", "isolated", True, "TUI"), iso_dir)

        if args.mode in ("all", "full"):
            print("full mode (cloning ~/.pi/agent):", file=sys.stderr)
            clone = build_full_clone(tmp)
            set_pihelp_enabled(clone, False)
            run(Scenario("full-base-noop", "full", False, "/noop"), clone)
            set_pihelp_enabled(clone, True)
            run(Scenario("full-help-noop", "full", True, "/noop"), clone)
            run(Scenario("full-help-list", "full", True, "/help"), clone)
            run(Scenario("full-help-detail", "full", True, "/help help"), clone)
            # No full-mode TUI scenarios: with the full extension set loaded,
            # PI_STARTUP_BENCHMARK's timing output never reaches the pty
            # (verified empirically; not the websocket transport). Full-mode
            # startup cost is covered by the print-mode runs above.

        print(report(scenarios, pi_version, args.runs))


if __name__ == "__main__":
    main()
