"""Offline CP-SAT schedule and replay against realized session durations."""
import argparse
from collections import defaultdict
from datetime import datetime
import json
import math
from pathlib import Path

from ortools.sat.python import cp_model

DAY_MINUTES = 17 * 60
CAPACITY = {"Windows 10": 3, "Windows Server 2019": 2}


def timestamp(value):
    return datetime.fromisoformat(value).timestamp() / 60


def rest(job):
    return 30 if job["type"] == "warmup" else 90


def load_cases(rows):
    for day in sorted({r["day"] for r in rows}):
        opening = timestamp(day + "T06:00:00+07:00")
        for worker, capacity in CAPACITY.items():
            jobs = [
                {**row,
                 "release": max(0, math.ceil(timestamp(row["dueAt"] or row["start"]) - opening)),
                 "observed": row["durationMs"] / 60_000}
                for row in rows
                if row["day"] == day and row["worker"] == worker
                and timestamp(row["start"]) >= opening and timestamp(row["end"]) <= opening + DAY_MINUTES
            ]
            jobs.sort(key=lambda r: r["start"])
            yield day, worker, capacity, jobs


def solve(jobs, capacity, seconds, balanced=False, occupied=(), smooth=False):
    model = cp_model.CpModel()
    start, end, present, interval, assignment = [], [], [], [], []
    accounts, proxies = defaultdict(list), defaultdict(list)
    for idx, job in enumerate(jobs):
        duration = max(1, math.ceil(job["model"][0 if balanced else 1]))
        lo = min(DAY_MINUTES, job["release"])
        start.append(model.new_int_var(lo, DAY_MINUTES, f"start_{idx}"))
        end.append(model.new_int_var(0, DAY_MINUTES, f"end_{idx}"))
        present.append(model.new_bool_var(f"run_{idx}"))
        interval.append(model.new_optional_interval_var(start[idx], duration, end[idx], present[idx], f"session_{idx}"))
        for bucket in range(lo // 60, 17):
            flag = model.new_bool_var(f"hour_{idx}_{bucket}")
            model.add(start[idx] >= bucket * 60).only_enforce_if(flag)
            model.add(start[idx] < (bucket + 1) * 60).only_enforce_if(flag)
            assignment.append((idx, bucket, flag))
        model.add(sum(flag for j, _, flag in assignment if j == idx) == present[idx])
        accounts[job["account"]].append(idx)
        proxies[job["proxy"]].append(idx)
    fixed = []
    for a, b, proxy in occupied:
        fixed.append((proxy, model.new_fixed_size_interval_var(a, b - a, f"active_{len(fixed)}")))
    model.add_cumulative(interval + [iv for _, iv in fixed], [1] * (len(jobs) + len(fixed)), capacity)
    for chain in accounts.values():
        for before, after in zip(chain, chain[1:]):
            model.add_implication(present[after], present[before])
            model.add(start[after] >= end[before] + rest(jobs[after])).only_enforce_if(present[after])
    for proxy, indexes in proxies.items():
        model.add_no_overlap([interval[i] for i in indexes] + [iv for group, iv in fixed if group == proxy])

    # Start-hour P50 minutes are an optimization proxy. Replay measures exact busy-minute overlap.
    weights = [max(1, round(j["model"][0])) for j in jobs]
    maximum = sum(weights)
    peak = model.new_int_var(0, maximum, "peak")
    for bucket in range(17):
        model.add(sum(weights[i] * flag for i, h, flag in assignment if h == bucket) <= peak)
    early = sum(weights[i] * flag for i, h, flag in assignment if h < 3)
    # Reward all planned tasks before considering load. P80 enforces feasible placement.
    value = sum((1 + len(j.get("tasksPlanned", []))) * p for j, p in zip(jobs, present))
    if balanced:
        late = sum(weights[i] * flag for i, h, flag in assignment if h >= 15)
        delay = sum(start[i] - min(DAY_MINUTES, j["release"]) for i, j in enumerate(jobs))
        peak_cost, tail_cost, delay_cost = (100, 25, 1) if smooth else (20, 4, 1)
        load_cost = peak_cost + 2 * tail_cost
        model.maximize((delay_cost * DAY_MINUTES * len(jobs) + load_cost * maximum + 1) * value
                       - peak_cost * peak - tail_cost * early - tail_cost * late - delay_cost * delay)
    else:
        model.maximize((6 * maximum + 1) * value - 5 * peak - early)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = seconds
    solver.parameters.num_search_workers = 4
    solver.parameters.random_seed = 17
    status = solver.solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return solver.status_name(status), [], solver.wall_time
    planned = [(solver.value(start[i]), i) for i, p in enumerate(present) if solver.boolean_value(p)]
    return solver.status_name(status), sorted(planned), solver.wall_time


def play(jobs, plan, capacity):
    """Dispatch no earlier than plan, using actual closes for the hard locks."""
    pending = list(plan)
    result = []
    account_last = {}
    proxy_last = {}
    predicted_start = {i: at for at, i in plan}
    previous = {}
    for i in sorted(predicted_start):
        account = jobs[i]["account"]
        previous[i] = account_last.get(account)
        account_last[account] = i
    account_last.clear()

    for now in range(DAY_MINUTES):
        running = [(i, end) for i, _, end in result if end > now]
        finished = {i for i, _, end in result if end <= now}
        for target, i in list(pending):
            if target > now or len(running) >= capacity:
                break
            job = jobs[i]
            account, proxy = job["account"], job["proxy"]
            if previous[i] is not None and previous[i] not in finished:
                continue
            if account in account_last and account_last[account] + rest(job) > now:
                continue
            if any(jobs[r]["proxy"] == proxy for r, _ in running):
                continue
            last = proxy_last.get(proxy)
            if last and last[0] != account and last[1] + 20 > now:
                slack = DAY_MINUTES - now - math.ceil(job["model"][1])
                if slack >= last[1] + 20 - now:
                    continue
            end = now + job["observed"]
            result.append((i, now, end))
            running.append((i, end))
            account_last[account] = end
            proxy_last[proxy] = account, end
            pending.remove((target, i))
    return result


def play_rolling(jobs, capacity, seconds, rescue=False, smooth=False, pace=False):
    """Replan unstarted work hourly, with live occupancy and actual closes enforced at dispatch."""
    pending = list(range(len(jobs)))
    result, plan = [], []
    account_last, proxy_last = {}, {}
    solver_stats = []
    for now in range(DAY_MINUTES):
        active = [(i, start, end) for i, start, end in result if end > now]
        if now % 60 == 0 and pending:
            active_accounts = {jobs[i]["account"]: max(now + 1, math.ceil(start + jobs[i]["model"][1]))
                               for i, start, _ in active}
            occupied = [(now, min(DAY_MINUTES, max(now + 1, math.ceil(start + jobs[i]["model"][1]))),
                         jobs[i]["proxy"]) for i, start, _ in active]
            remaining = []
            for i in pending:
                job = jobs[i]
                account = job["account"]
                lower = max(job["release"], now)
                if account in active_accounts:
                    lower = max(lower, active_accounts[account] + rest(job))
                elif account in account_last:
                    lower = max(lower, math.ceil(account_last[account]) + rest(job))
                remaining.append({**job, "release": min(DAY_MINUTES, lower)})
            status, solution, elapsed = solve(remaining, capacity, seconds, True, occupied, smooth)
            solver_stats.append({"minute": now, "status": status, "seconds": elapsed})
            if status in ("OPTIMAL", "FEASIBLE"):
                plan = sorted((at, pending[idx]) for at, idx in solution)

        chains = defaultdict(list)
        for i in pending:
            chains[jobs[i]["account"]].append(i)
        heads = {account: chain[0] for account, chain in chains.items()}
        slack_by_head = {}
        for chain in chains.values():
            ready = now
            for pos, i in enumerate(chain):
                job = jobs[i]
                if pos:
                    ready += rest(job)
                elif job["account"] in account_last:
                    ready = max(ready, account_last[job["account"]] + rest(job))
                ready = max(ready, job["release"]) + math.ceil(job["model"][1])
            slack_by_head[chain[0]] = DAY_MINUTES - ready

        targets = dict((i, at) for at, i in plan)
        if rescue:
            for i, slack in slack_by_head.items():
                if slack <= 30:
                    targets[i] = min(now, targets.get(i, now))
        hour_begin = now // 60 * 60
        hour_end = hour_begin + 60
        overlap = lambda a, b: max(0, min(b, hour_end) - max(a, hour_begin))
        busy_minutes = sum(overlap(start, end if end <= now else max(now, start + jobs[i]["model"][0]))
                           for i, start, end in result)
        hours_left = max(1, (DAY_MINUTES - now) / 60)
        hourly_budget = math.ceil(sum(jobs[i]["model"][0] for i in pending) / hours_left)
        dispatch = sorted(
            ((at, i) for i, at in targets.items() if at <= now),
            key=lambda entry: (slack_by_head.get(entry[1], math.inf), entry)
        )
        for at, i in dispatch:
            if len(active) >= capacity:
                break
            job = jobs[i]
            account, proxy = job["account"], job["proxy"]
            if heads.get(account) != i or now < job["release"]:
                continue
            if account in account_last and account_last[account] + rest(job) > now:
                continue
            if any(jobs[idx]["proxy"] == proxy for idx, _, _ in active):
                continue
            last = proxy_last.get(proxy)
            if last and last[0] != account and last[1] + 20 > now:
                slack = slack_by_head[i] if rescue else DAY_MINUTES - now - math.ceil(job["model"][1])
                if slack >= last[1] + 20 - now:
                    continue
            projected = overlap(now, now + job["model"][0])
            can_wait = slack_by_head[i] > hour_end - now
            if pace and can_wait and busy_minutes > 0 and busy_minutes + projected > hourly_budget:
                continue
            busy_minutes += projected
            end = now + job["observed"]
            record = (i, now, end)
            result.append(record)
            active.append(record)
            account_last[account] = end
            proxy_last[proxy] = account, end
            pending.remove(i)
            plan = [(target, idx) for target, idx in plan if idx != i]
    return result, solver_stats


def summarize(jobs, rows, capacity):
    hours = [sum(max(0, min(end, (h + 1) * 60) - max(start, h * 60))
                 for _, start, end in rows) for h in range(17)]
    events = sorted([(start, 1) for _, start, _ in rows] + [(end, -1) for _, _, end in rows])
    running = 0
    for _, diff in events:
        running += diff
        assert 0 <= running <= capacity
    for i, (left, start, end) in enumerate(rows):
        for right, other_start, other_end in rows[i + 1:]:
            if jobs[left]["proxy"] == jobs[right]["proxy"]:
                assert end <= other_start or other_end <= start
    done = [jobs[i] for i, _, end in rows if end <= DAY_MINUTES]
    tasks = [task for job in done for task in job["completed"]]
    return {
        "hourly": hours, "early": sum(hours[:3]), "peak": max(hours),
        "sessions": len(done), "search": sum(job["queries"] or 0 for job in done),
        "tasks": len(tasks), "dailySet": tasks.count("dailySet"), "dailyCheckIn": tasks.count("dailyCheckIn")
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("baseline")
    parser.add_argument("output")
    parser.add_argument("--seconds", type=float, default=4)
    parser.add_argument("--balanced", action="store_true")
    parser.add_argument("--rolling", action="store_true")
    parser.add_argument("--smooth", action="store_true")
    parser.add_argument("--pace", action="store_true")
    parser.add_argument("--rescue", action="store_true", help="Let deadline-risk jobs advance outside the solver plan")
    args = parser.parse_args()
    rows = json.loads(Path(args.input).read_text())
    baseline = {(r["day"], r["worker"]): r["learned"] for r in json.loads(Path(args.baseline).read_text())}
    report = []
    for day, worker, capacity, jobs in load_cases(rows):
        if args.rolling:
            runs, history = play_rolling(jobs, capacity, args.seconds, args.rescue, args.smooth, args.pace)
            status = "ROLLING"
            elapsed = sum(r["seconds"] for r in history)
            plan = runs
        else:
            status, plan, elapsed = solve(jobs, capacity, args.seconds, args.balanced)
            runs, history = play(jobs, plan, capacity), []
        cp_sat = summarize(jobs, runs, capacity)
        report.append({"day": day, "worker": worker, "cohort": len(jobs), "status": status,
                       "planned": len(plan), "solveSeconds": elapsed, "solverHistory": history,
                       "current": baseline[day, worker], "cpSat": cp_sat})
        print(day, worker, status, len(plan), cp_sat["sessions"], cp_sat["tasks"], flush=True)
    Path(args.output).write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
