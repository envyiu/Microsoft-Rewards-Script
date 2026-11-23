"""Offline duration benchmark. Reads LearningStore without writing to it."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime
import json
from pathlib import Path
import sqlite3
from zoneinfo import ZoneInfo

import numpy as np
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.feature_extraction import DictVectorizer

TZ = ZoneInfo("Asia/Ho_Chi_Minh")
NAMES = {
    "b035d61b-d96b-4b69-a232-be8aca72e803": "Windows 10",
    "34a51e01-f40f-4b92-a7f5-5176517b27dc": "Windows Server 2019",
}


def load(db_path, replay_metadata=None):
    db = sqlite3.connect(f"{Path(db_path).resolve().as_uri()}?mode=ro", uri=True)
    events = defaultdict(lambda: defaultdict(list))
    counts = Counter()
    sql = """SELECT collection, source, kind, observed, payload FROM records
             WHERE kind IN ('attempt_start','attempt_end') ORDER BY observed,id"""
    for collection, source, kind, stamp, raw in db.execute(sql):
        data = json.loads(raw)
        counts[kind] += 1
        events[collection, source, data["attemptId"]][kind].append((stamp, data))
    db.close()
    rows = []
    for (_, source, _), event in events.items():
        starts, ends = event["attempt_start"], event["attempt_end"]
        if len(starts) != 1 or len(ends) != 1:
            counts["unmatched_or_duplicate"] += 1
            continue
        stamp, start = starts[0]
        end_stamp, end = ends[0]
        if end_stamp < stamp:
            counts["invalid_order"] += 1
            continue
        if end.get("interrupted") or end.get("timedOut") or end.get("staleDay") or end.get("reason") == "worker-restart":
            counts["interrupted_timeout_stale_or_restart"] += 1
            continue
        if start.get("manual") or start.get("type") not in ("accountSession", "warmup"):
            counts["outside_smart_session_scope"] += 1
            continue
        duration = end.get("durationMs")
        if not isinstance(duration, (float, int)) or not np.isfinite(duration) or duration <= 0 or duration > 24 * 3600000:
            counts["invalid_duration"] += 1
            continue
        platform = start.get("platform")
        if platform not in ("desktop", "mobile"):
            counts["unknown_platform"] += 1
            continue
        workers = start.get("workers") or []
        features = {
            "node": source,
            "type": start["type"],
            "platform": platform,
            "searchBudget": start.get("searchBudget", 0),
            "taskCount": len(workers),
            **{f"task:{worker}": 1 for worker in workers},
        }
        day = datetime.fromisoformat(stamp).astimezone(TZ).date().isoformat()
        finished_day = datetime.fromisoformat(end_stamp).astimezone(TZ).date().isoformat()
        row = (day, features, duration / 60000, finished_day)
        rows.append(row)
        if replay_metadata is not None:
            replay_metadata[id(row)] = {
                "day": day, "worker": NAMES.get(source, "Other"),
                "account": start.get("accountId"), "proxy": start.get("networkId"),
                "platform": platform, "type": start["type"],
                "tasksPlanned": workers, "searchBudget": start.get("searchBudget", 0),
                "start": stamp, "end": end_stamp, "dueAt": start.get("dueAt"),
                "durationMs": duration, "queries": end.get("queries", 0),
                "completed": end.get("completedWorkers", []), "requested": start.get("manual", False)
            }
    counts["usable"] = len(rows)
    return rows, dict(counts)


def group_keys(f):
    return [(f["node"], f["type"], f["platform"]), (f["type"], f["platform"])]


def baseline_fit(rows):
    groups = defaultdict(list)
    for _, features, duration, _ in rows:
        for key in group_keys(features):
            groups[key].append(duration)
    return {key: np.quantile(values, [0.5, 0.8]) for key, values in groups.items() if len(values) >= 30}


def baseline_predict(groups, rows):
    return np.array([
        next((groups[key] for key in group_keys(features) if key in groups), [10, 10])
        for _, features, _, _ in rows
    ])


def loss(y, prediction, quantile):
    errors = y - prediction
    return np.mean(np.maximum(quantile * errors, (quantile - 1) * errors))


def fit(train, depth, estimators):
    encoder = DictVectorizer(sparse=False)
    x = encoder.fit_transform([r[1] for r in train])
    y = np.array([r[2] for r in train])
    models = [
        GradientBoostingRegressor(
            loss="quantile", alpha=q, n_estimators=estimators, max_depth=depth,
            min_samples_leaf=25, learning_rate=0.05, random_state=17
        ).fit(x, y)
        for q in (0.5, 0.8)
    ]
    return encoder, models


def predict(fitted, groups, rows, training):
    encoder, models = fitted
    x = encoder.transform([r[1] for r in rows])
    prediction = np.column_stack([model.predict(x) for model in models])
    prediction[:, 1] = np.maximum(prediction[:, 0], prediction[:, 1])
    support = Counter(group_keys(r[1])[0] for r in training)
    known = set(encoder.feature_names_)
    fallback = []
    for i, (_, f, _, _) in enumerate(rows):
        key = group_keys(f)[0]
        if support[key] < 30 or any(k.startswith("task:") and k not in known for k in f):
            fallback.append(i)
    prediction[fallback] = baseline_predict(groups, rows)[fallback]
    return prediction, fallback


def metrics(rows, prediction):
    y = np.array([r[2] for r in rows])
    return {
        "n": len(y),
        "p50_mae_minutes": float(np.mean(np.abs(y - prediction[:, 0]))),
        "p80_pinball_minutes": float(loss(y, prediction[:, 1], 0.8)),
        "p80_coverage": float(np.mean(y <= prediction[:, 1])),
        "p80_mean_minutes": float(np.mean(prediction[:, 1])),
        "p80_underestimate_p90_minutes": float(np.quantile(np.maximum(0, y - prediction[:, 1]), 0.9)),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--before-day", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--replay-input")
    args = parser.parse_args()
    replay = {} if args.replay_input else None
    rows, counts = load(args.database, replay)
    days = sorted({r[0] for r in rows if r[0] < args.before_day})
    if len(days) < 10:
        raise SystemExit("Need at least 10 days with usable samples")
    validation_days, test_days = days[-7:-4], days[-4:]
    train = [r for r in rows if r[0] < validation_days[0] and r[3] < validation_days[0]]
    val = [r for r in rows if r[0] in validation_days and r[3] < test_days[0]]
    test = [r for r in rows if r[0] in test_days]
    groups = baseline_fit(train)
    trials = []
    for depth, trees in [(2, 80), (2, 160), (3, 80), (3, 160)]:
        model = fit(train, depth, trees)
        pred, _ = predict(model, groups, val, train)
        m = metrics(val, pred)
        score = m["p50_mae_minutes"] / 2 + m["p80_pinball_minutes"]
        trials.append((score, depth, trees))
    _, depth, trees = min(trials)
    final_train = train + val
    groups = baseline_fit(final_train)
    base = baseline_predict(groups, test)
    ml, fallback = predict(fit(final_train, depth, trees), groups, test, final_train)
    if replay is not None:
        anonymous = {}
        payload = []
        for row, baseline, learned in zip(test, base, ml):
            item = replay[id(row)]
            item["account"] = anonymous.setdefault(("account", item["account"]), len(anonymous))
            item["proxy"] = anonymous.setdefault(("proxy", item["proxy"]), len(anonymous))
            item["baseline"] = baseline.tolist()
            item["model"] = learned.tolist()
            payload.append(item)
        Path(args.replay_input).write_text(json.dumps(payload) + "\n")
    fallback = set(fallback)
    partitions = defaultdict(list)
    for i, (day, f, _, _) in enumerate(test):
        partitions["all"].append(i)
        partitions["day:" + day].append(i)
        partitions["worker:" + NAMES.get(f["node"], "Other")].append(i)
        partitions["platform:" + f["platform"]].append(i)
        partitions["type:" + f["type"]].append(i)
    report = {
        "counts": counts, "split": {"train": len(train), "validation": len(val), "test": len(test),
        "train_days": days[:-7], "validation_days": validation_days, "test_days": test_days},
        "validation_trials": [{"score": s, "depth": d, "trees": t} for s, d, t in trials],
        "chosen": {"depth": depth, "trees": trees},
        "results": {key: {
            "baseline": metrics([test[i] for i in ix], base[ix]),
            "model": metrics([test[i] for i in ix], ml[ix]),
            "fallback": sum(i in fallback for i in ix),
        } for key, ix in partitions.items()}
    }
    Path(args.output).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
