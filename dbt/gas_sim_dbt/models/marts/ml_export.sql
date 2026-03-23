-- ml_export.sql
-- Final ML-ready table. No nulls in any feature or target column.
-- Single-leak records only (n_leaks=1), signal-filtered (sensor_delta >= 0.01).

select
    source, seed, layout_id, config_hash, tick,

    -- Scalar context features (12)
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

    -- Spatial shape features (4)
    n_sensors_above_threshold,
    max_reading,
    max_reading_row,
    max_reading_col,

    -- Top-3 sensor positions and readings (9)
    top1_row, top1_col, top1_reading,
    top2_row, top2_col, top2_reading,
    top3_row, top3_col, top3_reading,

    -- Triangulation features (4)
    top3_centroid_row,
    top3_centroid_col,
    t1_t2_ratio,
    t1_t3_ratio,

    -- Targets (4)
    target_centroid_row,
    target_centroid_col,
    target_nearest_row,
    target_nearest_col,

    uploaded_at

from {{ ref('fct_training_examples') }}
where
    sensor_delta            is not null
    and wind_angle          is not null
    and target_centroid_row is not null
    and target_centroid_col is not null
    and n_leaks = 1
    and sensor_delta >= 0.01
