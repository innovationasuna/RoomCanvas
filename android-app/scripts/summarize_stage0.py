#!/usr/bin/env python3
import argparse
import json
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "项目文档/手机端软件开发/光影渲染性能基线/阶段0"
EXPERIMENTS = [
    "A0",
    "A2",
    "A3_090",
    "A3_075",
    "A7",
]
METRICS = [
    "medianFps",
    "averageFps",
    "p50Ms",
    "p95Ms",
    "p99Ms",
    "over50Percent",
    "over100Percent",
    "cpuCallbackMs",
    "cpuInputMs",
    "cpuArMs",
    "cpuAnimationMs",
    "cpuCameraMs",
    "arUpdateAverageMs",
    "pssKb",
    "thermal",
]


def number(values, key):
    try:
        return float(values[key])
    except (KeyError, TypeError, ValueError):
        return None


def main():
    parser = argparse.ArgumentParser(description="Summarize Stage 0 sampler metadata")
    parser.add_argument(
        "--output-dir",
        help="采样输出目录；相对路径按“阶段0”根目录解析，默认阶段0根目录",
    )
    parser.add_argument(
        "--summary-name",
        default="stage0-summary.json",
        help="写入的汇总文件名",
    )
    args = parser.parse_args()

    output = Path(args.output_dir) if args.output_dir else OUTPUT
    if args.output_dir and not output.is_absolute():
        output = OUTPUT / output

    runs = []
    for path in output.glob("*-run*-meta.json"):
        data = json.loads(path.read_text(encoding="utf-8"))
        summary = data.get("summary") or {}
        if summary.get("metrics"):
            runs.append(data)

    rows = []
    for experiment in EXPERIMENTS:
        selected = sorted(
            (run for run in runs if run.get("experiment") == experiment),
            key=lambda run: run["run"],
        )
        if not selected:
            rows.append({"experiment": experiment, "runs": 0, "status": "pending"})
            continue
        row = {
            "experiment": experiment,
            "runs": len(selected),
            "runNumbers": [run["run"] for run in selected],
            "status": "complete" if len(selected) >= 3 else "partial",
        }
        for metric in METRICS:
            values = [number(run["summary"]["metrics"], metric) for run in selected]
            values = [value for value in values if value is not None]
            row[metric] = statistics.median(values) if values else None
        temperatures = [
            run["batteryAfter"]["temperatureTenthsC"]
            for run in selected
            if run.get("batteryAfter", {}).get("temperatureTenthsC") is not None
        ]
        row["batteryTemperatureTenthsC"] = statistics.median(temperatures) if temperatures else None
        row["perfettoTraces"] = [run["perfettoTrace"] for run in selected if run.get("perfettoTrace")]
        cool_selected = [
            run for run in selected
            if run.get("batteryBefore", {}).get("temperatureTenthsC") is not None
            and run["batteryBefore"]["temperatureTenthsC"] <= 360
        ]
        if cool_selected:
            cool_metrics = {}
            for metric in METRICS:
                values = [number(run["summary"]["metrics"], metric) for run in cool_selected]
                values = [value for value in values if value is not None]
                cool_metrics[metric] = statistics.median(values) if values else None
            row["coolSubset"] = {
                "maximumStartTemperatureTenthsC": 360,
                "runNumbers": [run["run"] for run in cool_selected],
                "metrics": cool_metrics,
            }
        rows.append(row)

    baseline_p95 = next((row.get("p95Ms") for row in rows if row["experiment"] == "A0"), None)
    for row in rows:
        if baseline_p95 and row.get("p95Ms") is not None:
            row["p95ImprovementPercent"] = (baseline_p95 - row["p95Ms"]) / baseline_p95 * 100
        else:
            row["p95ImprovementPercent"] = None

    report = {
        "note": "Application frame submission intervals, not isolated GPU time. Visual acceptance is separate.",
        "experiments": rows,
    }
    (output / args.summary_name).write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("experiment runs medianFps p50Ms p95Ms p99Ms over50% thermal p95Improvement%")
    for row in rows:
        if not row["runs"]:
            print(f"{row['experiment']} 0 pending")
            continue
        print(
            f"{row['experiment']} {row['runs']} {row.get('medianFps')} {row.get('p50Ms')} "
            f"{row.get('p95Ms')} {row.get('p99Ms')} {row.get('over50Percent')} "
            f"{row.get('thermal')} {row.get('p95ImprovementPercent')}"
        )


if __name__ == "__main__":
    main()
