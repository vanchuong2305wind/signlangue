"""Detach a resumable extraction job on Linux. Does not bind or stop any port."""

import json
import argparse
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    if os.name != "posix":
        raise SystemExit("Run this launcher on the Linux server, using .venv-landmarks/bin/python")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-name", default="original")
    parser.add_argument("--script", default="extract_viesign_landmarks.py", choices=[
        "extract_viesign_landmarks.py", "extract_viesign_additional_landmarks.py", "merge_viesign_landmarks.py",
    ])
    args, forwarded = parser.parse_known_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", args.job_name):
        parser.error("--job-name must contain only lowercase letters, digits, hyphens or underscores")
    if args.script != "extract_viesign_landmarks.py" and args.job_name == "original":
        parser.error("Use a separate --job-name for additional extraction or merge")
    runs = ROOT / "data_v2" / "runs"
    runs.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    log_path = runs / f"{args.job_name}-{stamp}.log"
    command = [sys.executable, "-u", str(ROOT / "scripts" / args.script), *forwarded]
    env = {**os.environ, "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "1",
           "TF_NUM_INTRAOP_THREADS": "2", "TF_NUM_INTEROP_THREADS": "1", "GLOG_minloglevel": "2"}
    with log_path.open("ab", buffering=0) as log:
        child = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
    time.sleep(2)
    if child.poll() is not None:
        print(log_path.read_text(errors="replace")[-6000:])
        raise SystemExit(f"Extractor exited with code {child.returncode}; log: {log_path}")
    job = {"job_name": args.job_name, "pid": child.pid, "log": str(log_path.relative_to(ROOT)), "command": command,
           "started_at": datetime.now(timezone.utc).isoformat(), "ports": []}
    jobs = runs / "jobs"
    jobs.mkdir(parents=True, exist_ok=True)
    (jobs / f"{args.job_name}.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
    if args.job_name == "original":
        (runs / "latest_job.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
    print(json.dumps(job, ensure_ascii=False, indent=2))
    print("Detached session started. SSH/local shutdown does not stop this job.")
    print("Resume: rerun this command after an interrupted extraction; existing live jobs are locked.")


if __name__ == "__main__":
    main()
