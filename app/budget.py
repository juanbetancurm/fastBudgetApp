from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo


def calculate_summary(settings, expenses, today=None):
    today = today or datetime.now(ZoneInfo(settings["timezone"])).date()
    start, end = date.fromisoformat(settings["trip_start"]), date.fromisoformat(settings["trip_end"])
    days = (end - start).days + 1
    budget = settings["initial_budget"]
    original_daily = (budget + days // 2) // days if days > 0 else 0
    spent = sum(row["amount"] for row in expenses)
    remaining = budget - spent
    remaining_days = days if today < start else max(0, (end - today).days + 1) if today <= end else 0
    recommended = (max(0, remaining) + remaining_days // 2) // remaining_days if remaining_days else 0
    daily_map = {}
    category_map = {}
    for row in expenses:
        daily_map[row["expense_date"]] = daily_map.get(row["expense_date"], 0) + row["amount"]
        category_map[row["category"]] = category_map.get(row["category"], 0) + row["amount"]
    daily = []
    if 0 < days <= 366:
        trip_date_keys = set()
        for n in range(days):
            current = start + timedelta(days=n)
            trip_date_keys.add(current.isoformat())
            daily.append({"date": current.isoformat(), "amount": daily_map.get(current.isoformat(), 0)})
        daily.extend({"date": key, "amount": value} for key, value in daily_map.items() if key not in trip_date_keys)
        daily.sort(key=lambda item: item["date"])
    categories = [{"name": key, "amount": value} for key, value in sorted(category_map.items(), key=lambda item: (-item[1], item[0].casefold()))]
    pct = round(spent / budget * 100, 1) if budget else 0
    return {
        "initial_budget": budget, "total_spent": spent, "remaining": remaining, "original_daily": original_daily,
        "percent_used": pct, "trip_days": days, "remaining_days": remaining_days,
        "recommended_daily": recommended, "trip_start": settings["trip_start"], "trip_end": settings["trip_end"],
        "categories": categories, "daily": daily,
        "top_category": categories[0]["name"] if categories else None,
        "warning": "Presupuesto agotado o superado." if remaining <= 0 and spent > 0 else None,
    }
