-- ml_export.sql
-- ML-ready table — exactly the 34 features used by the production model.
-- Single-leak (n_leaks=1), signal threshold >= 0.01 (notebook applies 0.15).

select
    source, seed, layout_id, config_hash, tick,

    -- Sensor aggregates
    sensor_delta, sensor_mean, reading_variance,
    centroid_row, centroid_col, coverage_ratio, sensor_count,
    wind_angle, wind_x, wind_y,
    distance_to_boundary,

    -- Top-3 sensor positions and readings
    top1_row, top1_col, top1_reading,
    top2_row, top2_col, top2_reading,
    top3_row, top3_col, top3_reading,

    -- Triangulation (precomputed in fct_training_examples)
    top3_centroid_row, top3_centroid_col,
    t1_t2_ratio, t1_t3_ratio,
    t1_t2_dist, t1_t3_dist,
    t1_t2_vec_row, t1_t2_vec_col,

    -- Wall/door features
    n_walls, n_doors,
    wall_density, open_path_ratio,
    wall_centroid_row, wall_centroid_col,
    wall_spread_row, wall_spread_col,
    walls_q1, walls_q2, walls_q3, walls_q4,
    walls_near_centroid, walls_blocking_top1,

    -- Targets
    target_centroid_row, target_centroid_col,
    target_nearest_row,  target_nearest_col,

    uploaded_at

from {{ ref('fct_training_examples') }}
where
    sensor_delta            is not null
    and wind_angle          is not null
    and target_centroid_row is not null
    and target_centroid_col is not null
    and target_n_leaks = 1
    and sensor_delta >= 0.01