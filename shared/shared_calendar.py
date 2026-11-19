"""The shared CME calendar and contract values (Bot-Lab plan step 1.5): the Python loader.

The originals live in market-data `shared/`: `cme_calendar.json`, `contracts.json`, this loader and its JS twin
`shared_calendar.js`. Every other repo carries exact copies, pinned by a sha256 test; a change is made in market-data
first and copied whole. Python 3.10 or later, standard library only.

  load_calendar(path=None)   the Calendar of `cme_calendar.json` (next to this file by default)
  load_contracts(path=None)  {root: Contract} of `contracts.json`

A Calendar answers by session date (the New York day a session ends; 18:00 the evening before up to the close):

  covered(d)           the table speaks for d
  ensure_covered(d)    d as a date; CalendarNotCovered outside the table (fail closed: no holiday is guessed)
  is_session(d)        a session is dated d (a weekday that is not a closed row)
  close_time(d)        the New York close of that session (a time), or None when there is no session
  is_holiday_halt(d)   a CME holiday whose trades CME books to the next trade date
  is_early_close(d)    a session with its own trade date that ends early
  holiday(d)           the holiday's name, else None
  entry(d)             the row for d (a copy), else None
  verified(d)          True only when CME text was read for both the kind and the time of d's row, or d has no row
                       and is not on the watch list
  sessions_between(a, b), next_session(d), prev_session(d)

Nothing here reads the network or any file but the two data files.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
CALENDAR_FILE = HERE / "cme_calendar.json"
CONTRACTS_FILE = HERE / "contracts.json"

CLOSED, HALT, EARLY = "closed", "halt", "early"
KINDS = (CLOSED, HALT, EARLY)
CHECKS = ("cme", "unverified")
CME_PREFIX = "https://www.cmegroup.com/"
ROOTS = ("NQ", "MNQ", "ES", "MES")
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class CalendarNotCovered(ValueError):
    """A date outside the table: the caller must not guess."""


class SharedDataError(ValueError):
    """A data file breaks its own rules."""


def as_date(d) -> date:
    """A date, a datetime (its own calendar date) or 'YYYY-MM-DD' as a date."""
    if isinstance(d, datetime):
        return d.date()
    if isinstance(d, date):
        return d
    if isinstance(d, str):
        return date.fromisoformat(d[:10])
    raise TypeError(f"not a date: {d!r}")


def _hhmm(s: str, what: str) -> time:
    if not isinstance(s, str) or not _HHMM.match(s):
        raise SharedDataError(f"{what}: {s!r} is not HH:MM")
    return time(int(s[:2]), int(s[3:]))


class Calendar:
    def __init__(self, data: dict):
        if data.get("schema") != 1:
            raise SharedDataError("cme_calendar: schema must be 1")
        self.normal_close = _hhmm(data.get("normal_close"), "normal_close")
        self.session_open = _hhmm(data.get("session_open"), "session_open")
        self.covered_from = date.fromisoformat(data["covered_from"])
        self.covered_to = date.fromisoformat(data["covered_to"])
        if self.covered_from > self.covered_to:
            raise SharedDataError("cme_calendar: covered_from is after covered_to")
        rows, last = {}, None
        for r in data["rows"]:
            ds = r.get("date")
            d = date.fromisoformat(ds)
            if d.isoformat() != ds:
                raise SharedDataError(f"cme_calendar: {ds!r} is not YYYY-MM-DD")
            if last is not None and d <= last:
                raise SharedDataError(f"cme_calendar: {ds} is out of order or twice")
            last = d
            if d.weekday() >= 5 or not (self.covered_from <= d <= self.covered_to):
                raise SharedDataError(f"cme_calendar: {ds} is a weekend or outside the table")
            kind = r.get("kind")
            if kind not in KINDS:
                raise SharedDataError(f"cme_calendar: {ds} has an unknown kind {kind!r}")
            if r.get("kind_check") not in CHECKS:
                raise SharedDataError(f"cme_calendar: {ds} kind_check must be one of {CHECKS}")
            if kind == CLOSED:
                if r.get("close_ny") is not None or r.get("time_check") is not None:
                    raise SharedDataError(f"cme_calendar: {ds} is closed, so close_ny and time_check are null")
                close = None
            else:
                close = _hhmm(r.get("close_ny"), f"cme_calendar: {ds} close_ny")
                if close >= self.normal_close:
                    raise SharedDataError(f"cme_calendar: {ds} closes at or after the normal close")
                if r.get("time_check") not in CHECKS:
                    raise SharedDataError(f"cme_calendar: {ds} time_check must be one of {CHECKS}")
            if kind == HALT and not r.get("holiday"):
                raise SharedDataError(f"cme_calendar: {ds} is a holiday halt with no holiday name")
            srcs = r.get("cme_sources") or []
            if not srcs or not all(isinstance(u, str) and u.startswith(CME_PREFIX) for u in srcs):
                raise SharedDataError(f"cme_calendar: {ds} needs at least one CME source, and only CME pages there")
            if any(not isinstance(u, str) or not u.startswith("https://") or u.startswith(CME_PREFIX)
                   for u in r.get("leads", [])):
                raise SharedDataError(f"cme_calendar: {ds} leads are non-CME https pages")
            rows[d] = {**r, "close": close}
        self._rows = rows
        self._watch = {}
        for w in data.get("watch", []):
            d = date.fromisoformat(w["date"])
            if d in rows or not (self.covered_from <= d <= self.covered_to) or not w.get("note"):
                raise SharedDataError(f"cme_calendar: watch date {w['date']} has a row, is outside the table or has no note")
            self._watch[d] = w["note"]

    # ------------------------------------------------------------ coverage
    def covered(self, d) -> bool:
        d = as_date(d)
        return self.covered_from <= d <= self.covered_to

    def ensure_covered(self, d) -> date:
        d = as_date(d)
        if not self.covered(d):
            raise CalendarNotCovered(f"the shared CME calendar covers {self.covered_from.isoformat()} to "
                                     f"{self.covered_to.isoformat()}, not {d.isoformat()}: no holiday is guessed")
        return d

    # ------------------------------------------------------------ one day
    def entry(self, d):
        r = self._rows.get(self.ensure_covered(d))
        if r is None:
            return None
        out = {k: v for k, v in r.items() if k != "close"}
        out["cme_sources"], out["leads"] = list(r.get("cme_sources", [])), list(r.get("leads", []))
        return out

    def is_session(self, d) -> bool:
        d = self.ensure_covered(d)
        if d.weekday() >= 5:
            return False
        r = self._rows.get(d)
        return not (r and r["kind"] == CLOSED)

    def close_time(self, d):
        d = self.ensure_covered(d)
        if not self.is_session(d):
            return None
        r = self._rows.get(d)
        return r["close"] if r else self.normal_close

    def is_holiday_halt(self, d) -> bool:
        r = self._rows.get(self.ensure_covered(d))
        return bool(r and r["kind"] == HALT)

    def is_early_close(self, d) -> bool:
        r = self._rows.get(self.ensure_covered(d))
        return bool(r and r["kind"] == EARLY)

    def holiday(self, d):
        r = self._rows.get(self.ensure_covered(d))
        return r.get("holiday") if r else None

    def verified(self, d) -> bool:
        d = self.ensure_covered(d)
        r = self._rows.get(d)
        if r is None:
            return d not in self._watch
        return r["kind_check"] == "cme" and r.get("time_check") in ("cme", None)

    def watch(self) -> dict:
        """{date: note}: dates with no row whose normal session is not confirmed."""
        return dict(self._watch)

    def rows(self) -> list:
        return [self.entry(d) for d in sorted(self._rows)]

    # ------------------------------------------------------------ ranges
    def sessions_between(self, first, last) -> list:
        d, e, out = self.ensure_covered(first), self.ensure_covered(last), []
        while d <= e:
            if self.is_session(d):
                out.append(d)
            d += timedelta(days=1)
        return out

    def next_session(self, d) -> date:
        d = self.ensure_covered(d) + timedelta(days=1)
        while not self.is_session(d):
            d += timedelta(days=1)
        return d

    def prev_session(self, d) -> date:
        d = self.ensure_covered(d) - timedelta(days=1)
        while not self.is_session(d):
            d -= timedelta(days=1)
        return d


@dataclass(frozen=True)
class Contract:
    root: str
    name: str
    point_value: float
    tick_size: float
    tick_value: float
    micro: str | None


def contracts_from(data: dict) -> dict:
    if data.get("schema") != 1:
        raise SharedDataError("contracts: schema must be 1")
    out = {}
    for c in data["contracts"]:
        root = c.get("root")
        if root in out:
            raise SharedDataError(f"contracts: {root} twice")
        pv, ts, tv = c.get("point_value"), c.get("tick_size"), c.get("tick_value")
        if not all(isinstance(x, (int, float)) and not isinstance(x, bool) and x > 0 for x in (pv, ts, tv)):
            raise SharedDataError(f"contracts: {root} needs positive numbers")
        if abs(pv * ts - tv) > 1e-9:
            raise SharedDataError(f"contracts: {root} tick_value is not point_value times tick_size")
        srcs = c.get("cme_sources") or []
        if not srcs or not all(isinstance(u, str) and u.startswith(CME_PREFIX) for u in srcs):
            raise SharedDataError(f"contracts: {root} needs CME sources")
        out[root] = Contract(root, c["name"], float(pv), float(ts), float(tv), c.get("micro"))
    for c in out.values():
        if c.micro is not None and c.micro not in out:
            raise SharedDataError(f"contracts: {c.root} names an unknown micro {c.micro}")
    if tuple(out) != ROOTS:
        raise SharedDataError(f"contracts: the roots must be {ROOTS} in that order")
    return out


def load_calendar(path=None) -> Calendar:
    with open(path or CALENDAR_FILE, encoding="utf-8") as f:
        return Calendar(json.load(f))


def load_contracts(path=None) -> dict:
    with open(path or CONTRACTS_FILE, encoding="utf-8") as f:
        return contracts_from(json.load(f))
