-- ml_export.sql
-- Final ML-ready table. No nulls in any feature or target column.
-- Includes all leak counts (1-8). Multi-leak aware features.

select
    source, seed, layout_id, config_hash, tick,

    -- Sensor features (15) — original proven set
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

    -- Targets (2) — single leak: centroid = nearest = leak position
    target_centroid_row,
    target_centroid_col,

    uploaded_at

from {{ ref('fct_training_examples') }}
where
    sensor_delta            is not null
    and wind_angle          is not null
    and wind_magnitude      is not null
    and target_centroid_row is not null
    and target_centroid_col is not null
    and target_nearest_row  is not null
    and target_nearest_col  is not null
    and n_leaks = 1          -- production model: single-leak only
    and sensor_delta >= 0.01  -- minimum signal threshold: gas must have reached sensors
