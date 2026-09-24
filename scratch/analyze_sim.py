with open('scratch/ares_simulation_engine.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()

for i, l in enumerate(lines, 1):
    # Print lines defining constants, functions, formulas, and record construction
    if any(k in l for k in [
        'MAP_', 'ROBOT_RADIUS', 'CRITICAL_DISTANCE', 'SAFE_DISTANCE', 'V_MAX', 'V_SLOW',
        'R_MIN', 'R_MAX', 'TAU_REACT', 'BETA_DENSITY', 'DENSITY_RADIUS',
        'compute_vector_ttc_and_cpa', 'compute_dynamic_interaction_radius',
        'dist_to_destination', 'eta(', 'dist_nearest', 'closing_vel', 'true_ttc',
        'cpa_time_sec', 'cpa_distance_m', 'traffic_lvl', 'inter_conflict', 'intersection_conflict',
        'dist_nearest =', 'ttc =', 't_cpa =', 'd_cpa =', 'rel_dir =', 'inter_conflict ='
    ]):
        print(f"{i:4d}: {l.rstrip()}")
