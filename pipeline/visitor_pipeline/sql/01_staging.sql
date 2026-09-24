-- Staging: one clean, typed, de-duplicated view per source.
CREATE SCHEMA IF NOT EXISTS staging;

-- Vendor ticket sales: normalise casing, parse money, collapse timestamps to dates,
-- and keep only the latest copy of each record (pages can overlap).
CREATE OR REPLACE VIEW staging.stg_ticket_sales AS
SELECT
    record_id,
    upper(trim(venue_code))                                           AS venue_id,
    try_cast(left(trim(sales_date_raw), 10) AS DATE)                  AS sales_date,
    lower(trim(ticket_type_raw))                                      AS ticket_type,
    lower(trim(channel_raw))                                          AS channel,
    quantity,
    try_cast(regexp_replace(gross_amount_raw, '[^0-9.\-]', '', 'g') AS DECIMAL(14, 2))
                                                                      AS gross_amount_nzd,
    upper(trim(currency))                                             AS currency,
    _loaded_at
FROM raw.ticket_sales
QUALIFY row_number() OVER (PARTITION BY record_id ORDER BY _loaded_at DESC) = 1;

CREATE OR REPLACE VIEW staging.stg_weather_daily AS
SELECT venue_id, date, temp_max_c, temp_min_c, precipitation_mm, source
FROM raw.weather_daily
QUALIFY row_number() OVER (PARTITION BY venue_id, date ORDER BY _loaded_at DESC) = 1;

-- Expand holidays to the venues they apply to: national holidays apply everywhere,
-- regional anniversary days only where the venue's region code matches.
CREATE OR REPLACE VIEW staging.stg_venue_holidays AS
WITH holidays AS (
    SELECT *
    FROM raw.public_holidays
    QUALIFY row_number() OVER (PARTITION BY date, name ORDER BY _loaded_at DESC) = 1
)
SELECT
    v.venue_id,
    h.date,
    string_agg(h.name, ' / ' ORDER BY h.name)   AS holiday_name,
    bool_or(NOT h.is_national)                  AS is_regional
FROM holidays h
JOIN raw.venues v
  ON h.is_national OR list_contains(h.regions, v.region_code)
GROUP BY ALL;
