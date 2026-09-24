import joblib
import pandas as pd
import numpy as np

model = joblib.load('ml/amr_ares_v2_model.pkl')
preprocessor = joblib.load('ml/amr_ares_v2_preprocessor.pkl')
config = joblib.load('ml/amr_ares_v2_config.pkl')

print("Config:", config)

# Test cases representing scenarios A, B, C, D, E
scenarios = {
    "A_same_direction_following": {
        "current_x": 10.0, "current_y": 10.0, "destination_x": 30.0, "destination_y": 10.0,
        "distance_to_destination_m": 20.0, "eta_sec": 20.0, "speed_mps": 1.0, "heading_rad": 0.0,
        "battery_pct": 90.0, "obstacle_detected": 0, "path_blocked": 0, "alternative_route_available": 1,
        "dynamic_interaction_radius_m": 7.5, "nearby_robot_count": 1, "nearest_robot_distance_m": 2.5,
        "nearest_robot_relative_speed_mps": 0.4, "nearest_robot_relative_heading_rad": 0.0,
        "closing_velocity_mps": 0.4, "true_ttc_sec": 6.25, "cpa_time_sec": 6.25, "cpa_distance_m": 0.2,
        "intersection_conflict": 0, "task_type": "DROP", "task_priority": "MEDIUM",
        "traffic_level": "MEDIUM", "relative_direction": "SAME"
    },
    "B_head_on_critical": {
        "current_x": 20.0, "current_y": 15.0, "destination_x": 40.0, "destination_y": 15.0,
        "distance_to_destination_m": 20.0, "eta_sec": 20.0, "speed_mps": 1.0, "heading_rad": 0.0,
        "battery_pct": 85.0, "obstacle_detected": 1, "path_blocked": 1, "alternative_route_available": 1,
        "dynamic_interaction_radius_m": 8.5, "nearby_robot_count": 1, "nearest_robot_distance_m": 2.0,
        "nearest_robot_relative_speed_mps": 2.0, "nearest_robot_relative_heading_rad": 3.1415,
        "closing_velocity_mps": 2.0, "true_ttc_sec": 1.0, "cpa_time_sec": 1.0, "cpa_distance_m": 0.0,
        "intersection_conflict": 0, "task_type": "DROP", "task_priority": "MEDIUM",
        "traffic_level": "MEDIUM", "relative_direction": "OPPOSITE"
    },
    "C_crossing_intersection": {
        "current_x": 25.0, "current_y": 25.0, "destination_x": 25.0, "destination_y": 45.0,
        "distance_to_destination_m": 20.0, "eta_sec": 20.0, "speed_mps": 1.0, "heading_rad": 1.5708,
        "battery_pct": 80.0, "obstacle_detected": 1, "path_blocked": 1, "alternative_route_available": 1,
        "dynamic_interaction_radius_m": 8.0, "nearby_robot_count": 1, "nearest_robot_distance_m": 3.0,
        "nearest_robot_relative_speed_mps": 1.414, "nearest_robot_relative_heading_rad": 1.5708,
        "closing_velocity_mps": 1.0, "true_ttc_sec": 3.0, "cpa_time_sec": 1.5, "cpa_distance_m": 0.5,
        "intersection_conflict": 1, "task_type": "DROP", "task_priority": "LOW",
        "traffic_level": "MEDIUM", "relative_direction": "CROSSING"
    },
    "D_congested_cluster": {
        "current_x": 30.0, "current_y": 30.0, "destination_x": 50.0, "destination_y": 30.0,
        "distance_to_destination_m": 20.0, "eta_sec": 20.0, "speed_mps": 0.5, "heading_rad": 0.0,
        "battery_pct": 75.0, "obstacle_detected": 1, "path_blocked": 1, "alternative_route_available": 1,
        "dynamic_interaction_radius_m": 12.0, "nearby_robot_count": 4, "nearest_robot_distance_m": 1.5,
        "nearest_robot_relative_speed_mps": 0.8, "nearest_robot_relative_heading_rad": 2.5,
        "closing_velocity_mps": 0.8, "true_ttc_sec": 1.8, "cpa_time_sec": 1.2, "cpa_distance_m": 0.3,
        "intersection_conflict": 1, "task_type": "DROP", "task_priority": "LOW",
        "traffic_level": "CRITICAL", "relative_direction": "CROSSING"
    },
    "E_clear_nominal": {
        "current_x": 5.0, "current_y": 5.0, "destination_x": 25.0, "destination_y": 5.0,
        "distance_to_destination_m": 20.0, "eta_sec": 20.0, "speed_mps": 1.0, "heading_rad": 0.0,
        "battery_pct": 95.0, "obstacle_detected": 0, "path_blocked": 0, "alternative_route_available": 1,
        "dynamic_interaction_radius_m": 6.5, "nearby_robot_count": 0, "nearest_robot_distance_m": 99.0,
        "nearest_robot_relative_speed_mps": 0.0, "nearest_robot_relative_heading_rad": 0.0,
        "closing_velocity_mps": 0.0, "true_ttc_sec": 99.0, "cpa_time_sec": 0.0, "cpa_distance_m": 99.0,
        "intersection_conflict": 0, "task_type": "DROP", "task_priority": "HIGH",
        "traffic_level": "LOW", "relative_direction": "NONE"
    }
}

df = pd.DataFrame(list(scenarios.values()))
X_proc = preprocessor.transform(df)
preds = model.predict(X_proc)
probs = model.predict_proba(X_proc)

int_to_action = config.get("target_mapping", {0: "MOVE", 1: "SLOW", 2: "WAIT", 3: "REROUTE"})
if isinstance(list(int_to_action.keys())[0], str):
    # reverse mapping if needed
    pass

for name, pred, prob in zip(scenarios.keys(), preds, probs):
    act = int_to_action.get(int(pred), str(pred))
    conf = float(np.max(prob))
    print(f"[{name}] -> Action: {act} (conf: {conf:.4f}) Probs: {prob}")
