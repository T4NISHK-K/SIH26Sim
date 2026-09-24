import joblib
import pandas as pd
import numpy as np
import math

model = joblib.load('ml/amr_ares_v2_model.pkl')
preprocessor = joblib.load('ml/amr_ares_v2_preprocessor.pkl')
config = joblib.load('ml/amr_ares_v2_config.pkl')

classes = config['classes']

def predict_single(feat_dict):
    df = pd.DataFrame([feat_dict])
    X = preprocessor.transform(df)
    probs = model.predict_proba(X)[0]
    best_idx = np.argmax(probs)
    return classes[best_idx], float(probs[best_idx]), probs

print("Testing Model on Representative Multi-Robot Dynamic States:")

# Scenario A: 3 robots same direction (R1 lead at x=20, R2 follower at x=17, R3 follower at x=14)
# R2 following R1 closely
feat_a_follower = {
    'current_x': 17.0, 'current_y': 20.0, 'destination_x': 50.0, 'destination_y': 20.0,
    'distance_to_destination_m': 33.0, 'eta_sec': 33.0, 'speed_mps': 1.0, 'heading_rad': 0.0,
    'battery_pct': 90.0, 'obstacle_detected': 0, 'path_blocked': 0, 'alternative_route_available': 1,
    'dynamic_interaction_radius_m': 8.5, 'nearby_robot_count': 2, 'nearest_robot_distance_m': 3.0,
    'nearest_robot_relative_speed_mps': 0.2, 'nearest_robot_relative_heading_rad': 0.0,
    'closing_velocity_mps': 0.2, 'true_ttc_sec': 15.0, 'cpa_time_sec': 8.0, 'cpa_distance_m': 1.4,
    'intersection_conflict': 0, 'task_type': 'DROP', 'task_priority': 'MEDIUM',
    'traffic_level': 'MEDIUM', 'relative_direction': 'SAME'
}
act_a, conf_a, p_a = predict_single(feat_a_follower)
print(f"Scenario A (Follower): {act_a} (conf: {conf_a:.4f})")

# Scenario B: 3 robots head-on (R1 at x=30 heading east, R2 at x=34 heading west, R3 nearby)
feat_b_headon = {
    'current_x': 30.0, 'current_y': 20.0, 'destination_x': 60.0, 'destination_y': 20.0,
    'distance_to_destination_m': 30.0, 'eta_sec': 30.0, 'speed_mps': 1.0, 'heading_rad': 0.0,
    'battery_pct': 85.0, 'obstacle_detected': 1, 'path_blocked': 1, 'alternative_route_available': 1,
    'dynamic_interaction_radius_m': 8.5, 'nearby_robot_count': 2, 'nearest_robot_distance_m': 4.0,
    'nearest_robot_relative_speed_mps': 2.0, 'nearest_robot_relative_heading_rad': 3.1415,
    'closing_velocity_mps': 2.0, 'true_ttc_sec': 2.0, 'cpa_time_sec': 2.0, 'cpa_distance_m': 0.0,
    'intersection_conflict': 0, 'task_type': 'DROP', 'task_priority': 'MEDIUM',
    'traffic_level': 'MEDIUM', 'relative_direction': 'OPPOSITE'
}
act_b, conf_b, p_b = predict_single(feat_b_headon)
print(f"Scenario B (Head-on approaching): {act_b} (conf: {conf_b:.4f})")

# Scenario C: 3 robots crossing at intersection (50, 50)
feat_c_crossing = {
    'current_x': 47.0, 'current_y': 50.0, 'destination_x': 60.0, 'destination_y': 50.0,
    'distance_to_destination_m': 13.0, 'eta_sec': 13.0, 'speed_mps': 1.0, 'heading_rad': 0.0,
    'battery_pct': 80.0, 'obstacle_detected': 1, 'path_blocked': 1, 'alternative_route_available': 1,
    'dynamic_interaction_radius_m': 8.5, 'nearby_robot_count': 2, 'nearest_robot_distance_m': 4.24,
    'nearest_robot_relative_speed_mps': 1.414, 'nearest_robot_relative_heading_rad': 1.57,
    'closing_velocity_mps': 1.0, 'true_ttc_sec': 3.0, 'cpa_time_sec': 2.1, 'cpa_distance_m': 0.5,
    'intersection_conflict': 1, 'task_type': 'DROP', 'task_priority': 'LOW',
    'traffic_level': 'MEDIUM', 'relative_direction': 'CROSSING'
}
act_c, conf_c, p_c = predict_single(feat_c_crossing)
print(f"Scenario C (Crossing intersection): {act_c} (conf: {conf_c:.4f})")

# Scenario D: 4-5 robots congested cluster (traffic_level=CRITICAL, nearby_robot_count=4)
feat_d_congested = {
    'current_x': 49.0, 'current_y': 49.0, 'destination_x': 60.0, 'destination_y': 50.0,
    'distance_to_destination_m': 11.0, 'eta_sec': 11.0, 'speed_mps': 0.5, 'heading_rad': 0.1,
    'battery_pct': 70.0, 'obstacle_detected': 1, 'path_blocked': 1, 'alternative_route_available': 1,
    'dynamic_interaction_radius_m': 12.0, 'nearby_robot_count': 4, 'nearest_robot_distance_m': 1.2,
    'nearest_robot_relative_speed_mps': 0.5, 'nearest_robot_relative_heading_rad': 2.0,
    'closing_velocity_mps': 0.5, 'true_ttc_sec': 2.4, 'cpa_time_sec': 1.0, 'cpa_distance_m': 0.4,
    'intersection_conflict': 1, 'task_type': 'DROP', 'task_priority': 'LOW',
    'traffic_level': 'CRITICAL', 'relative_direction': 'CROSSING'
}
act_d, conf_d, p_d = predict_single(feat_d_congested)
print(f"Scenario D (Congested cluster): {act_d} (conf: {conf_d:.4f})")

# Scenario E: Mixed traffic - Open road robot
feat_e_open = {
    'current_x': 10.0, 'current_y': 80.0, 'destination_x': 40.0, 'destination_y': 80.0,
    'distance_to_destination_m': 30.0, 'eta_sec': 30.0, 'speed_mps': 1.0, 'heading_rad': 0.0,
    'battery_pct': 95.0, 'obstacle_detected': 0, 'path_blocked': 0, 'alternative_route_available': 1,
    'dynamic_interaction_radius_m': 6.5, 'nearby_robot_count': 0, 'nearest_robot_distance_m': 99.0,
    'nearest_robot_relative_speed_mps': 0.0, 'nearest_robot_relative_heading_rad': 0.0,
    'closing_velocity_mps': 0.0, 'true_ttc_sec': 99.0, 'cpa_time_sec': 0.0, 'cpa_distance_m': 99.0,
    'intersection_conflict': 0, 'task_type': 'PICK', 'task_priority': 'HIGH',
    'traffic_level': 'LOW', 'relative_direction': 'NONE'
}
act_e, conf_e, p_e = predict_single(feat_e_open)
print(f"Scenario E (Open road): {act_e} (conf: {conf_e:.4f})")
