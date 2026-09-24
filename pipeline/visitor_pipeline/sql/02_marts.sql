-- Marts: the analytics-ready tables the dashboard and the SQL agent query.
CREATE SCHEMA IF NOT EXISTS marts;

CREATE OR REPLACE TABLE marts.dim_venue AS
SELECT venue_id, name AS venue_name, city, region_code, setting, capacity, latitude, longitude
FROM raw.venues;

CREATE OR REPLACE TABLE marts.dim_date AS
WITH bounds AS (
    SELECT CAST(min(sales_date) AS TIMESTAMP) AS lo, CAST(max(sales_date) AS TIMESTAMP) AS hi
    FROM staging.stg_ticket_sales
),
days AS (
    SELECT unnest(generate_series(lo, hi, INTERVAL 1 DAY)) AS d FROM bounds
)
SELECT
    CAST(d AS DATE)                          AS date,
    year(d)                                  AS year,
    month(d)                                 AS month,
    monthname(d)                             AS month_name,
    CAST(date_trunc('week', d) AS DATE)      AS week_start,
    isodow(d)                                AS iso_day_of_week,
    dayname(d)                               AS day_name,
    isodow(d) IN (6, 7)                      AS is_weekend,
    CASE WHEN month(d) IN (12, 1, 2) THEN 'summer'
         WHEN month(d) IN (3, 4, 5)  THEN 'autumn'
         WHEN month(d) IN (6, 7, 8)  THEN 'winter'
         ELSE 'spring' END                   AS season  -- southern hemisphere
FROM days;

CREATE OR REPLACE TABLE marts.fct_ticket_sales AS
SELECT record_id, venue_id, sales_date AS date, ticket_type, channel, quantity, gross_amount_nzd
FROM staging.stg_ticket_sales
WHERE sales_date IS NOT NULL AND gross_amount_nzd IS NOT NULL;  -- rejects are counted by DQ checks

CREATE OR REPLACE TABLE marts.fct_daily_venue AS
WITH sales AS (
    SELECT
        venue_id,
        date,
        sum(quantity)                                        AS visitors,
        sum(gross_amount_nzd)                                AS revenue_nzd,
        sum(quantity) FILTER (WHERE channel = 'online')      AS online_visitors,
        sum(quantity) FILTER (WHERE ticket_type = 'child')   AS child_visitors
    FROM marts.fct_ticket_sales
    GROUP BY ALL
)
SELECT
    s.venue_id,
    s.date,
    s.visitors,
    s.revenue_nzd,
    round(s.revenue_nzd / nullif(s.visitors, 0), 2)              AS revenue_per_visitor_nzd,
    round(coalesce(s.online_visitors, 0) / nullif(s.visitors, 0), 4) AS online_share,
    round(coalesce(s.child_visitors, 0) / nullif(s.visitors, 0), 4)  AS child_share,
    round(s.visitors / v.capacity, 4)                             AS utilisation,
    w.temp_max_c,
    w.precipitation_mm,
    CASE WHEN w.precipitation_mm IS NULL THEN 'unknown'
         WHEN w.precipitation_mm >= 5 THEN 'wet'
         WHEN w.precipitation_mm >= 1 THEN 'showers'
         ELSE 'dry' END                                           AS weather_band,
    h.holiday_name,
    h.date IS NOT NULL                                            AS is_public_holiday,
    d.is_weekend,
    d.day_name,
    d.season
FROM sales s
JOIN marts.dim_venue v USING (venue_id)
JOIN marts.dim_date d USING (date)
LEFT JOIN staging.stg_weather_daily w USING (venue_id, date)
LEFT JOIN staging.stg_venue_holidays h USING (venue_id, date);
