"""Detach a resumable extraction job on Linux. Does not bind or stop any port."""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    if os.name != "posix":
        raise SystemExit("Run this launcher on the Linux server, using .venv-landmarks/bin/python")
    runs = ROOT / "data_v2" / "runs"
    runs.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    log_path = runs / f"extract-{stamp}.log"
    command = [sys.executable, "-u", str(ROOT / "scripts" / "extract_viesign_landmarks.py"), *sys.argv[1:]]
    env = {**os.environ, "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "1",
           "TF_NUM_INTRAOP_THREADS": "2", "TF_NUM_INTEROP_THREADS": "1", "GLOG_minloglevel": "2"}
    with log_path.open("ab", buffering=0) as log:
        child = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
    time.sleep(2)
    if child.poll() is not None:
        print(log_path.read_text(errors="replace")[-6000:])
        raise SystemExit(f"Extractor exited with code {child.returncode}; log: {log_path}")
    job = {"pid": child.pid, "log": str(log_path.relative_to(ROOT)), "command": command,
           "started_at": datetime.now(timezone.utc).isoformat(), "ports": []}
    (runs / "latest_job.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
    print(json.dumps(job, ensure_ascii=False, indent=2))
    print("Detached session started. SSH/local shutdown does not stop this job.")
    print("Resume: rerun this command after an interrupted extraction; existing live jobs are locked.")


if __name__ == "__main__":
    main()
