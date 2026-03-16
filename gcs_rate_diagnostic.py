"""
gcs_rate_diagnostic.py
Diagnoses GCS write rate limits on model_registry.json and compares
against the separate-file architecture (registry/last_data_upload.txt).

Run from repo root:
    python3 gcs_rate_diagnostic.py

Requires: google-cloud-storage, matplotlib
    pip install google-cloud-storage matplotlib --break-system-packages
"""

import os
import json
import time
import threading
import datetime
import statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Optional
from google.cloud import storage

# ── Config ────────────────────────────────────────────────────────────────
PROJECT_ID = os.environ["PROJECT_ID"]
BUCKET     = os.environ["BUCKET"]
TARGET     = "model_registry.json"          # high-contention object
SAFE       = "registry/diag_test.txt"       # safe separate file

PAYLOAD_REGISTRY = json.dumps({"diag": True, "ts": ""}, indent=2).encode()
PAYLOAD_SIMPLE   = b"diag-test"

gcs    = storage.Client(project=PROJECT_ID)
bucket = gcs.bucket(BUCKET)

# ── Data structures ───────────────────────────────────────────────────────
@dataclass
class WriteResult:
    object_name:  str
    attempt:      int
    thread_id:    int
    started_at:   float
    ended_at:     float
    success:      bool
    status_code:  Optional[int]
    error:        Optional[str]

    @property
    def duration_ms(self) -> float:
        return (self.ended_at - self.started_at) * 1000

@dataclass
class RampResult:
    concurrency:  int
    object_name:  str
    results:      list[WriteResult] = field(default_factory=list)

    @property
    def success_rate(self) -> float:
        if not self.results: return 0.0
        return sum(1 for r in self.results if r.success) / len(self.results)

    @property
    def rate_limited(self) -> bool:
        return any(r.status_code == 429 for r in self.results)

    @property
    def avg_duration_ms(self) -> float:
        durations = [r.duration_ms for r in self.results]
        return statistics.mean(durations) if durations else 0.0

# ── Write function ─────────────────────────────────────────────────────────
def write_object(
    object_name: str,
    attempt: int,
    thread_id: int,
    payload: bytes,
    content_type: str = "text/plain",
) -> WriteResult:
    t0 = time.time()
    try:
        blob = bucket.blob(object_name)
        blob.upload_from_string(payload, content_type=content_type)
        return WriteResult(
            object_name=object_name, attempt=attempt, thread_id=thread_id,
            started_at=t0, ended_at=time.time(),
            success=True, status_code=200, error=None,
        )
    except Exception as e:
        code = None
        err  = str(e)
        if "429" in err or "rateLimitExceeded" in err:
            code = 429
        elif "403" in err:
            code = 403
        return WriteResult(
            object_name=object_name, attempt=attempt, thread_id=thread_id,
            started_at=t0, ended_at=time.time(),
            success=False, status_code=code, error=err[:120],
        )

# ── Test 1: Ramp concurrency ──────────────────────────────────────────────
def test_ramp(object_name: str, payload: bytes, max_concurrency: int = 16) -> list[RampResult]:
    """Send 1, 2, 4, 8, 16 concurrent writes and record results."""
    results = []
    concurrencies = [1, 2, 4, 8, 16][:] 
    concurrencies = [c for c in concurrencies if c <= max_concurrency]

    for n in concurrencies:
        print(f"  Concurrency {n:2d} × writes to {object_name}...", end=" ", flush=True)
        ramp = RampResult(concurrency=n, object_name=object_name)

        with ThreadPoolExecutor(max_workers=n) as ex:
            futures = [
                ex.submit(write_object, object_name, i, i,
                          payload.replace(b"\"ts\": \"\"", f'"ts": "{i}"'.encode())
                          if b'"ts"' in payload else payload)
                for i in range(n)
            ]
            for f in as_completed(futures):
                ramp.results.append(f.result())

        rate_limited = ramp.rate_limited
        print(f"{'🔴 RATE LIMITED' if rate_limited else '✅ OK':20s} "
              f"success={ramp.success_rate:.0%}  avg={ramp.avg_duration_ms:.0f}ms")
        results.append(ramp)

        # Wait between levels to avoid compound rate limits
        if rate_limited:
            print(f"    Rate limit hit at concurrency={n} — waiting 30s...")
            time.sleep(30)
        else:
            time.sleep(2)

    return results

# ── Test 2: Recovery time after 429 ───────────────────────────────────────
def test_recovery(object_name: str, payload: bytes) -> list[WriteResult]:
    """Hammer until 429 then measure recovery time."""
    print(f"\n  Forcing 429 on {object_name}...")
    recovery_results = []

    # Force a 429 by sending 10 simultaneous writes
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = [ex.submit(write_object, object_name, i, i, payload) for i in range(10)]
        for f in as_completed(futures):
            recovery_results.append(f.result())

    if not any(r.status_code == 429 for r in recovery_results):
        print("  Could not force 429 — skipping recovery test")
        return recovery_results

    print("  429 triggered — measuring recovery time...")
    t_start = time.time()
    for attempt in range(60):
        time.sleep(1)
        result = write_object(object_name, attempt + 100, 0, payload)
        recovery_results.append(result)
        if result.success:
            elapsed = time.time() - t_start
            print(f"  ✅ Recovered after {elapsed:.1f}s ({attempt+1} retries)")
            break
    else:
        print("  ❌ Did not recover within 60s")

    return recovery_results

# ── Test 3: Simulate real workload ────────────────────────────────────────
def test_real_workload(n_files: int = 13) -> dict:
    """Simulate n NDJSON files landing simultaneously — each writer tries model_registry.json."""
    print(f"\n  Simulating {n_files} simultaneous NDJSON uploads...")
    results_registry = []
    results_separate = []

    def ingest_worker_old(i):
        """Old behaviour: write model_registry.json"""
        time.sleep(i * 0.05)  # slight stagger like real Lambda cold starts
        return write_object(TARGET, i, i, PAYLOAD_REGISTRY, "application/json")

    def ingest_worker_new(i):
        """New behaviour: write separate file"""
        time.sleep(i * 0.05)
        payload = f"2026-03-15T17:{i:02d}:00Z".encode()
        return write_object(SAFE, i, i, payload)

    print(f"  Old architecture ({n_files}× writes to {TARGET}):")
    with ThreadPoolExecutor(max_workers=n_files) as ex:
        for r in as_completed([ex.submit(ingest_worker_old, i) for i in range(n_files)]):
            results_registry.append(r.result())
    success_old = sum(1 for r in results_registry if r.success)
    print(f"    {success_old}/{n_files} succeeded  "
          f"({n_files - success_old} rate limited)")

    time.sleep(60)  # let rate limit clear

    print(f"  New architecture ({n_files}× writes to {SAFE}):")
    with ThreadPoolExecutor(max_workers=n_files) as ex:
        for r in as_completed([ex.submit(ingest_worker_new, i) for i in range(n_files)]):
            results_separate.append(r.result())
    success_new = sum(1 for r in results_separate if r.success)
    print(f"    {success_new}/{n_files} succeeded  "
          f"({n_files - success_new} rate limited)")

    return {"registry": results_registry, "separate": results_separate}

# ── Visualise ─────────────────────────────────────────────────────────────
def visualise(
    ramp_registry:  list[RampResult],
    ramp_separate:  list[RampResult],
    workload:       dict,
    recovery:       list[WriteResult],
):
    try:
        import matplotlib.pyplot as plt
        import matplotlib.patches as mpatches
    except ImportError:
        print("\nmatplotlib not installed — skipping visualisation")
        print("Install with: pip install matplotlib --break-system-packages")
        return

    fig, axes = plt.subplots(2, 2, figsize=(14, 10))
    fig.suptitle("GCS model_registry.json Rate Limit Diagnostic", fontsize=14, fontweight="bold")

    # ── Plot 1: Ramp success rate ─────────────────────────────────────────
    ax = axes[0, 0]
    ax.set_title("Concurrency vs Success Rate")
    ax.set_xlabel("Concurrent writes")
    ax.set_ylabel("Success rate (%)")

    x_reg = [r.concurrency for r in ramp_registry]
    y_reg = [r.success_rate * 100 for r in ramp_registry]
    x_sep = [r.concurrency for r in ramp_separate]
    y_sep = [r.success_rate * 100 for r in ramp_separate]

    ax.plot(x_reg, y_reg, "ro-", label="model_registry.json", linewidth=2, markersize=8)
    ax.plot(x_sep, y_sep, "go-", label="registry/diag_test.txt", linewidth=2, markersize=8)
    ax.axhline(y=100, color="gray", linestyle="--", alpha=0.4)
    ax.set_ylim(-5, 110)
    ax.legend()
    ax.grid(True, alpha=0.3)

    # Mark rate limit threshold
    for r in ramp_registry:
        if r.rate_limited:
            ax.axvline(x=r.concurrency, color="red", linestyle=":", alpha=0.6)
            ax.annotate(f"429 first hit\nat n={r.concurrency}",
                       xy=(r.concurrency, 50), fontsize=8, color="red",
                       ha="center")
            break

    # ── Plot 2: Ramp avg duration ─────────────────────────────────────────
    ax = axes[0, 1]
    ax.set_title("Concurrency vs Write Latency")
    ax.set_xlabel("Concurrent writes")
    ax.set_ylabel("Avg duration (ms)")

    y_reg_ms = [r.avg_duration_ms for r in ramp_registry]
    y_sep_ms = [r.avg_duration_ms for r in ramp_separate]

    ax.bar([x - 0.2 for x in x_reg], y_reg_ms, width=0.4,
           color="salmon", label="model_registry.json")
    ax.bar([x + 0.2 for x in x_sep], y_sep_ms, width=0.4,
           color="lightgreen", label="registry/diag_test.txt")
    ax.legend()
    ax.grid(True, alpha=0.3, axis="y")

    # ── Plot 3: Real workload timeline ────────────────────────────────────
    ax = axes[1, 0]
    ax.set_title(f"Real Workload: {len(workload.get('registry', []))} simultaneous writes")
    ax.set_xlabel("Time (relative seconds)")
    ax.set_ylabel("Thread ID")

    t0 = min(
        (r.started_at for r in workload.get("registry", []) + workload.get("separate", [])),
        default=time.time()
    )

    for results, label, color_ok, color_fail, y_offset in [
        (workload.get("registry", []), "model_registry.json", "red",   "darkred",   0),
        (workload.get("separate",  []), "separate file",       "green", "darkgreen", 0.3),
    ]:
        for r in results:
            color = color_ok if r.success else color_fail
            ax.barh(
                y=r.thread_id + y_offset,
                width=max(r.duration_ms / 1000, 0.05),
                left=r.started_at - t0,
                height=0.25,
                color=color,
                alpha=0.8,
                label=f"{label} ({'OK' if r.success else '429'})" if r.thread_id == 0 else "",
            )

    handles = [
        mpatches.Patch(color="red",   label="model_registry.json OK"),
        mpatches.Patch(color="darkred",   label="model_registry.json 429"),
        mpatches.Patch(color="green", label="separate file OK"),
    ]
    ax.legend(handles=handles, fontsize=8)
    ax.grid(True, alpha=0.3, axis="x")

    # ── Plot 4: Recovery timeline ─────────────────────────────────────────
    ax = axes[1, 1]
    ax.set_title("Recovery Time after 429")
    ax.set_xlabel("Attempt number")
    ax.set_ylabel("Success")

    if recovery:
        t0_rec = recovery[0].started_at
        for i, r in enumerate(recovery):
            color = "green" if r.success else ("red" if r.status_code == 429 else "orange")
            ax.scatter(i, 1 if r.success else 0, color=color, s=80, zorder=3)
            ax.annotate(
                f"{(r.started_at - t0_rec):.0f}s",
                xy=(i, 1 if r.success else 0),
                textcoords="offset points",
                xytext=(0, 8),
                fontsize=7, ha="center",
            )
        ax.set_ylim(-0.3, 1.5)
        ax.set_yticks([0, 1])
        ax.set_yticklabels(["Failed", "Success"])
        ax.grid(True, alpha=0.3)

        recovery_write = next((r for r in recovery[10:] if r.success), None)
        if recovery_write:
            t_recovery = recovery_write.started_at - recovery[0].started_at
            ax.set_title(f"Recovery Time: {t_recovery:.0f}s after 429")
    else:
        ax.text(0.5, 0.5, "No recovery data", ha="center", va="center",
                transform=ax.transAxes, fontsize=12, color="gray")

    plt.tight_layout()
    out = "/tmp/gcs_rate_diagnostic.png"
    plt.savefig(out, dpi=150, bbox_inches="tight")
    print(f"\n📊 Diagnostic chart saved to: {out}")
    print("   Copy to Windows: cp /tmp/gcs_rate_diagnostic.png "
          "'/mnt/c/Users/PC MAROC/Downloads/gcs_rate_diagnostic.png'")
    plt.close()

# ── Summary ───────────────────────────────────────────────────────────────
def print_summary(
    ramp_registry: list[RampResult],
    ramp_separate: list[RampResult],
    workload: dict,
):
    print("\n" + "="*60)
    print("DIAGNOSTIC SUMMARY")
    print("="*60)

    # Find rate limit threshold
    threshold = None
    for r in ramp_registry:
        if r.rate_limited:
            threshold = r.concurrency
            break

    print(f"\n model_registry.json:")
    print(f"   Rate limit threshold: "
          f"{'concurrency=' + str(threshold) if threshold else 'not hit in test range'}")
    for r in ramp_registry:
        status = "🔴 RATE LIMITED" if r.rate_limited else "✅ OK"
        print(f"   n={r.concurrency:2d}  {status}  success={r.success_rate:.0%}  "
              f"avg={r.avg_duration_ms:.0f}ms")

    print(f"\n registry/diag_test.txt (separate file):")
    for r in ramp_separate:
        status = "🔴 RATE LIMITED" if r.rate_limited else "✅ OK"
        print(f"   n={r.concurrency:2d}  {status}  success={r.success_rate:.0%}  "
              f"avg={r.avg_duration_ms:.0f}ms")

    reg_ok = sum(1 for r in workload.get("registry", []) if r.success)
    sep_ok = sum(1 for r in workload.get("separate", []) if r.success)
    total  = len(workload.get("registry", []))

    print(f"\n Real workload ({total} simultaneous writes):")
    print(f"   model_registry.json:   {reg_ok}/{total} succeeded")
    print(f"   Separate file:         {sep_ok}/{total} succeeded")
    print(f"\n Conclusion: separate file architecture "
          f"{'✅ eliminates' if sep_ok > reg_ok else '⚠️  does not fully eliminate'} "
          f"the rate limit problem")
    print("="*60)

# ── Main ──────────────────────────────────────────────────────────────────
def main():
    print("GCS Rate Limit Diagnostic")
    print(f"Project: {PROJECT_ID}  Bucket: {BUCKET}")
    print("="*60)

    print("\n[1/4] Ramp test — model_registry.json")
    ramp_registry = test_ramp(TARGET, PAYLOAD_REGISTRY)

    print("\n[2/4] Ramp test — separate file (registry/diag_test.txt)")
    ramp_separate = test_ramp(SAFE, PAYLOAD_SIMPLE)

    print("\n[3/4] Recovery time test")
    recovery = test_recovery(TARGET, PAYLOAD_REGISTRY)

    print("\n[4/4] Real workload simulation (13 simultaneous)")
    workload = test_real_workload(n_files=13)

    print_summary(ramp_registry, ramp_separate, workload)
    visualise(ramp_registry, ramp_separate, workload, recovery)

    # Clean up diagnostic test file
    try:
        bucket.blob(SAFE).delete()
    except Exception:
        pass

if __name__ == "__main__":
    main()
