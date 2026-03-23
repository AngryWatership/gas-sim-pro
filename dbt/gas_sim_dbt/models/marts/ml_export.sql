-- ml_export.sql
-- Final ML-ready table. No nulls in any feature or target column.
-- Includes all leak counts (1-8). Multi-leak aware features.

select
    source, seed, layout_id, config_hash, tick,

    -- Sensor features (19)
    sensor_delta,
    sensor_mean,
    reading_variance,
    centroid_row,
    centroid_col,
    coverage_ratio,
    wind_angle,
    wind_magnitude,
    distance_to_boundary,
    wind_x,
    wind_y,
    diffusion_rate,
    decay_factor,
    leak_injection,
    sensor_count,
    n_sensors_above_threshold,
    max_reading,
    max_reading_row,
    max_reading_col,

    -- Multi-leak features (5)
    n_leaks,
    leaks_centroid_row,
    leaks_centroid_col,
    leaks_spread_row,
    leaks_spread_col,

    -- Targets (5)
    target_centroid_row,
    target_centroid_col,
    target_nearest_row,
    target_nearest_col,
    target_n_leaks,

    uploaded_at

from {{ ref('fct_training_examples') }}
where
    sensor_delta           is not null
    and wind_angle         is not null
    and wind_magnitude     is not null
    and target_centroid_row is not null
    and target_centroid_col is not null
    and target_nearest_row  is not null
    and target_nearest_col  is not null
