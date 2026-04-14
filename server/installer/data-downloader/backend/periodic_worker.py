from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from backend.config import get_settings
from backend.services import DataDownloaderService

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")


async def run_worker():
    settings = get_settings()
    service = DataDownloaderService(settings)
    
    interval = max(30, settings.periodic_interval_seconds)
    daily_time = settings.scan_daily_time

    if daily_time:
         logging.info(f"Starting periodic scanner loop (daily at {daily_time})")
    else:
         logging.info(f"Starting periodic scanner loop (interval={interval}s)")

    while True:
        try:
            active_season = settings.seasons[0]  # sorted descending by year; first = active
            logging.info(f"Running scheduled scan for active season: {active_season.name}")
            service.run_full_scan(source="periodic", season_names=[active_season.name])
            logging.info("Finished scheduled scan.")
            
            if daily_time:
                # Calculate seconds until next occurrence of daily_time
                now = datetime.now()
                target_hour, target_minute = map(int, daily_time.split(":"))
                target = now.replace(hour=target_hour, minute=target_minute, second=0, microsecond=0)
                
                if target <= now:
                    # If target time has passed today, schedule for tomorrow
                    target += timedelta(days=1)
                
                sleep_seconds = (target - now).total_seconds()
                logging.info(f"Next scan scheduled for {target} (in {sleep_seconds:.0f}s)")
                await asyncio.sleep(sleep_seconds)
            else:
                await asyncio.sleep(interval)

        except Exception:
            logging.exception("Scheduled scan failed. Retrying in 60s...")
            await asyncio.sleep(60)


if __name__ == "__main__":
    asyncio.run(run_worker())
