import joblib
import pandas as pd
import numpy as np

# Load artifacts
cfg = joblib.load('ml/amr_ares_v2_config.pkl')
model = joblib.load('ml/amr_ares_v2_model.pkl')
preprocessor = joblib.load('ml/amr_ares_v2_preprocessor.pkl')

print("Classes in config:", cfg.get('classes'))
print("Numeric features:", cfg.get('numeric_features'))
print("Categorical features:", cfg.get('categorical_features'))
print("All features:", cfg.get('all_features'))

# Test sample from prompt Test 3:
sample = {
    'current_x': 25.0,
    'current_y': 15.0,
    'destination_x': 45.0,
    'destination_y': 35.0,
    'distance_to_destination_m': 28.28,
    'eta_sec': 28.3,
    'speed_mps': 1.0,
    'heading_rad': 0.7854,
    'battery_pct': 90.0,
    'obstacle_detected': 1,
    'path_blocked': 1,
    'alternative_route_available': 1,
    'dynamic_interaction_radius_m': 6.5,
    'nearby_robot_count': 1,
    'nearest_robot_distance_m': 2.5,
    'nearest_robot_relative_speed_mps': 0.5,
    'nearest_robot_relative_heading_rad': 3.1415,
    'closing_velocity_mps': 1.5,
    'true_ttc_sec': 1.67,
    'cpa_time_sec': 1.5,
    'cpa_distance_m': 0.5,
    'intersection_conflict': 1,
    'task_type': 'DROP',
    'task_priority': 'HIGH',
    'traffic_level': 'MEDIUM',
    'relative_direction': 'OPPOSITE'
}

df = pd.DataFrame([sample])[cfg['all_features']]
X = preprocessor.transform(df)
pred_idx = model.predict(X)[0]
probs = model.predict_proba(X)[0]

classes = [str(c) for c in cfg.get('classes', ['MOVE', 'SLOW', 'WAIT', 'REROUTE'])]
decision = classes[int(pred_idx)]
confidence = float(probs[int(pred_idx)])

print(f"Sample prediction: index={pred_idx}, decision={decision}, confidence={confidence:.4f}")
print("All probs:", probs)
