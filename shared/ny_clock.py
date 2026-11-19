"""The New York clock and the session date (Bot-Lab plan step 1.6): the Python module.

Anthony's rule ("Standardize it across all trading code"): a session runs from 18:00 New York the evening
before to 17:00 New York on its session date, and a weekend rolls to Monday. The originals live in market-data
`shared/`: this module, its JS twin `ny_clock.js` and the table both are proved by, `ny_clock_cases.json`. Every other
repo carries exact copies, pinned by a sha256 test; a change is made in market-data first and copied whole. Python 3.10
or later, standard library only.

A moment is a timezone-aware datetime or true UTC epoch ms: a whole number (an int, numpy's int64 too) or a float with
no fraction. A naive datetime, a fraction of a millisecond, a moment before 2007-01-01T00:00Z and a moment in the year
2100 or later are refused, whatever the clock source, so seconds or microseconds passed as ms never get an answer. A
session date is a date or 'YYYY-MM-DD' from 2007-01-01 to the first day of 2100. The New York offset comes from
zoneinfo (the system time zone database, else the tzdata package); with neither, from the US rules in code (daylight
time from 02:00 on the second Sunday of March to 02:00 on the first Sunday of November; they answer from
2006-11-05T06:00Z, so the first session of 2007, which opens on the evening of 2006-12-31, has the same answer either
way). The tests prove the two agree on every hour of 2007 to 2040.

  ZONE_SOURCE              'zoneinfo' or 'us-rules': where this process takes the offset from
  utc_offset(m)            New York's offset from UTC at m (a timedelta: -4 or -5 hours)
  to_ny(m)                 m as an aware New York datetime
  now_ny()                 the current moment as an aware New York datetime
  ny_date(m)               m's New York calendar date
  ny_wall_ms(m)            m's New York wall clock as ms stored as if UTC (the charts' and tickreplay's wall time)
  session_date(m, cal)     the session date m belongs to: the New York date, the next day from 17:00, and a Saturday
                           or Sunday rolls to Monday. With a shared calendar (shared_calendar.load_calendar()), a day
                           with no session (a closed row) rolls on as a weekend does.
  session_date_wall(w)     the same from a naive New York wall-clock datetime (no calendar)
  session_start(d)         18:00 New York the evening before session date d, as an aware UTC datetime
  session_end(d, cal)      17:00 New York on d, or the calendar's close on an early close or a holiday halt (aware UTC)
  in_session(m, cal)       session_start(d) <= m < session_end(d, cal) for d = session_date(m, cal)
  is_weekend(m)            from Friday 17:00 to Sunday 18:00 New York

Between 17:00 and 18:00 on a weekday (the daily break) no session runs: session_date gives the next session's date (as
the weekend gives Monday) and in_session is False. After an early close or a holiday halt and before 17:00, the moment
keeps its session's date and in_session is False. A session date or a roll the calendar does not cover raises the
calendar's CalendarNotCovered: no holiday is guessed. Nothing here reads the network or any file.
"""

from __future__ import annotations

import numbers
from datetime import date, datetime, time, timedelta, timezone

try:                                    # Windows Python has no time zone database unless tzdata is installed
    from zoneinfo import ZoneInfo
    NY = ZoneInfo("America/New_York")
    ZONE_SOURCE = "zoneinfo"
except Exception:                       # noqa: BLE001 - the US rules below are used instead
    NY = None
    ZONE_SOURCE = "us-rules"

SESSION_OPEN = time(18, 0)              # the evening before the session date
SESSION_CLOSE = time(17, 0)             # on the session date (the calendar may close earlier)
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
FIRST_MOMENT = datetime(2007, 1, 1, tzinfo=timezone.utc)      # the first moment answered
END_YEAR = 2100                                               # the first year refused
END_MOMENT = datetime(END_YEAR, 1, 1, tzinfo=timezone.utc)    # the first moment refused again
FIRST_MS, END_MS = 1167609600000, 4102444800000               # the same, as UTC ms
FIRST_DAY, LAST_DAY = date(2007, 1, 1), END_MOMENT.date()     # the session dates answered
RULES_FROM = datetime(2006, 11, 5, 6, tzinfo=timezone.utc)    # the US rules in code answer from here (standard time)
_EDT, _EST = timedelta(hours=-4), timedelta(hours=-5)


# ------------------------------------------------------------------------------------------------ the offset
def _nth_sunday(year: int, month: int, n: int) -> date:
    d = date(year, month, 1)
    return d + timedelta(days=(6 - d.weekday()) % 7 + 7 * (n - 1))


def us_rules_offset(utc: datetime) -> timedelta:
    """New York's offset at an aware moment by the US rules in code: daylight time from 07:00 UTC on the second Sunday
    of March (02:00 standard time) to 06:00 UTC on the first Sunday of November (02:00 daylight time)."""
    u = utc.astimezone(timezone.utc)
    if u < RULES_FROM:
        raise ValueError(f"the US rules in code answer from {RULES_FROM.isoformat()}, not {u.isoformat()}")
    start = datetime.combine(_nth_sunday(u.year, 3, 2), time(7), tzinfo=timezone.utc)
    end = datetime.combine(_nth_sunday(u.year, 11, 1), time(6), tzinfo=timezone.utc)
    return _EDT if start <= u < end else _EST


def _as_utc(m) -> datetime:
    if isinstance(m, bool):
        raise TypeError(f"not a moment: {m!r}")
    if isinstance(m, numbers.Integral) or (isinstance(m, float) and m.is_integer()):
        ms = int(m)
        if not FIRST_MS <= ms < END_MS:
            raise ValueError(f"{ms} ms is outside 2007-01-01T00:00Z to {END_MOMENT.isoformat()}: not UTC ms of a moment")
        return _EPOCH + timedelta(milliseconds=ms)
    if isinstance(m, float):
        raise TypeError(f"{m!r} is not a whole number of ms")
    if isinstance(m, datetime):
        if m.tzinfo is None or m.utcoffset() is None:
            raise TypeError("a naive datetime does not say its clock: pass an aware datetime or UTC ms")
        u = m.astimezone(timezone.utc)
        if not FIRST_MOMENT <= u < END_MOMENT:
            raise ValueError(f"{u.isoformat()} is outside 2007-01-01T00:00Z to {END_MOMENT.isoformat()}")
        return u
    raise TypeError(f"not a moment: {m!r}")


def utc_offset(m) -> timedelta:
    u = _as_utc(m)
    if NY is not None:
        return u.astimezone(NY).utcoffset()
    return us_rules_offset(u)


def to_ny(m) -> datetime:
    u = _as_utc(m)
    if NY is not None:
        return u.astimezone(NY)
    return u.astimezone(timezone(us_rules_offset(u)))


def now_ny() -> datetime:
    return to_ny(datetime.now(timezone.utc))


def ny_date(m) -> date:
    return to_ny(m).date()


def ny_wall_ms(m) -> int:
    w = to_ny(m)
    return int(round((w.replace(tzinfo=timezone.utc) - _EPOCH) / timedelta(milliseconds=1)))


def _wall_to_utc(day: date, at: time) -> datetime:
    """An aware UTC moment for a New York wall time that is never inside a switch hour (the session's times are 09:15 or
    later, the switches are at 02:00)."""
    if not time(3) <= at:
        raise ValueError(f"{at} can fall inside a daylight-saving switch")
    wall = datetime.combine(day, at)
    if NY is not None:
        return wall.replace(tzinfo=NY).astimezone(timezone.utc)
    guess = wall.replace(tzinfo=timezone.utc) - _EST          # the wall time read as standard time
    off = us_rules_offset(guess)
    return (wall.replace(tzinfo=timezone.utc) - off).astimezone(timezone.utc)


# ------------------------------------------------------------------------------------------------ sessions
def _as_day(d) -> date:
    if isinstance(d, datetime):
        raise TypeError("a session date is a date or 'YYYY-MM-DD', not a datetime")
    if isinstance(d, str):
        if len(d) != 10:
            raise TypeError(f"a session date is 'YYYY-MM-DD', not {d!r}")
        d = date.fromisoformat(d)
    if not isinstance(d, date):
        raise TypeError(f"not a date: {d!r}")
    if not FIRST_DAY <= d <= LAST_DAY:
        raise ValueError(f"{d.isoformat()} is outside the session dates answered, {FIRST_DAY} to {LAST_DAY}")
    return d


def _has_session(d: date, cal) -> bool:
    if d.weekday() >= 5:
        return False
    return cal is None or cal.is_session(d)


def _roll(d: date, cal) -> date:
    while not _has_session(d, cal):
        d += timedelta(days=1)
    return d


def _date_of_wall(wall: datetime) -> date:
    d = wall.date()
    if wall.time() >= SESSION_CLOSE:
        d += timedelta(days=1)
    return d


def session_date(m, cal=None) -> date:
    return _roll(_date_of_wall(to_ny(m).replace(tzinfo=None)), cal)


def session_date_wall(wall: datetime) -> date:
    if not isinstance(wall, datetime) or wall.tzinfo is not None:
        raise TypeError("session_date_wall takes a naive New York wall-clock datetime")
    if not FIRST_MOMENT.replace(tzinfo=None) <= wall < END_MOMENT.replace(tzinfo=None):
        raise ValueError(f"{wall.isoformat()} is outside 2007-01-01 to {END_MOMENT.date()}")
    return _roll(_date_of_wall(wall), None)


def _check_session(d: date, cal) -> date:
    if not _has_session(d, cal):
        raise ValueError(f"no session is dated {d.isoformat()}")
    return d


def session_start(d) -> datetime:
    d = _check_session(_as_day(d), None)
    return _wall_to_utc(d - timedelta(days=1), SESSION_OPEN)


def session_end(d, cal=None) -> datetime:
    d = _check_session(_as_day(d), cal)
    return _wall_to_utc(d, SESSION_CLOSE if cal is None else cal.close_time(d))


def in_session(m, cal=None) -> bool:
    u = _as_utc(m)
    d = session_date(u, cal)
    return session_start(d) <= u < session_end(d, cal)


def is_weekend(m) -> bool:
    w = to_ny(m)
    wd, t = w.weekday(), w.time()
    return (wd == 4 and t >= SESSION_CLOSE) or wd == 5 or (wd == 6 and t < SESSION_OPEN)
