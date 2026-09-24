import json
import os
import sys
import joblib
import pandas as pd
import numpy as np

# Path setup
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(BASE_DIR, 'ml', 'amr_ares_v2_model.pkl')
PREPROCESSOR_PATH = os.path.join(BASE_DIR, 'ml', 'amr_ares_v2_preprocessor.pkl')
CONFIG_PATH = os.path.join(BASE_DIR, 'ml', 'amr_ares_v2_config.pkl')

try:
    CONFIG = joblib.load(CONFIG_PATH)
    MODEL = joblib.load(MODEL_PATH)
    PREPROCESSOR = joblib.load(PREPROCESSOR_PATH)

    CLASSES = [str(c) for c in CONFIG.get('classes', ['MOVE', 'SLOW', 'WAIT', 'REROUTE'])]
    FEATURE_COLUMNS = list(CONFIG.get('all_features', []))
    NUMERIC_COLUMNS = set(CONFIG.get('numeric_features', []))
    CATEGORICAL_COLUMNS = set(CONFIG.get('categorical_features', []))
except Exception as e:
    sys.stderr.write(f"[Predictor ERROR] Failed to load V2 ML artifacts: {e}\n")
    CONFIG = None
    MODEL = None
    PREPROCESSOR = None
    CLASSES = ['MOVE', 'SLOW', 'WAIT', 'REROUTE']
    FEATURE_COLUMNS = [
        'current_x', 'current_y', 'destination_x', 'destination_y',
        'distance_to_destination_m', 'eta_sec', 'speed_mps', 'heading_rad',
        'battery_pct', 'obstacle_detected', 'path_blocked',
        'alternative_route_available', 'dynamic_interaction_radius_m',
        'nearby_robot_count', 'nearest_robot_distance_m',
        'nearest_robot_relative_speed_mps', 'nearest_robot_relative_heading_rad',
        'closing_velocity_mps', 'true_ttc_sec', 'cpa_time_sec',
        'cpa_distance_m', 'intersection_conflict',
        'task_type', 'task_priority', 'traffic_level', 'relative_direction'
    ]
    NUMERIC_COLUMNS = set(FEATURE_COLUMNS[:22])
    CATEGORICAL_COLUMNS = set(FEATURE_COLUMNS[22:])

# Safe default values for missing inputs matching V2 training defaults
DEFAULT_NUMERICAL = {
    'current_x': 0.0,
    'current_y': 0.0,
    'destination_x': 0.0,
    'destination_y': 0.0,
    'distance_to_destination_m': 0.0,
    'eta_sec': 0.0,
    'speed_mps': 1.0,
    'heading_rad': 0.0,
    'battery_pct': 100.0,
    'obstacle_detected': 0,
    'path_blocked': 0,
    'alternative_route_available': 1,
    'dynamic_interaction_radius_m': 6.5,
    'nearby_robot_count': 0,
    'nearest_robot_distance_m': 99.0,
    'nearest_robot_relative_speed_mps': 0.0,
    'nearest_robot_relative_heading_rad': 0.0,
    'closing_velocity_mps': 0.0,
    'true_ttc_sec': 99.0,
    'cpa_time_sec': 0.0,
    'cpa_distance_m': 99.0,
    'intersection_conflict': 0
}

DEFAULT_CATEGORICAL = {
    'task_type': 'DROP',
    'task_priority': 'MEDIUM',
    'traffic_level': 'LOW',
    'relative_direction': 'NONE'
}

VALID_CATEGORIES = {
    'task_type': {'CHARGE', 'DROP', 'PICK', 'RELOCATE'},
    'task_priority': {'CRITICAL', 'HIGH', 'LOW', 'MEDIUM'},
    'traffic_level': {'CRITICAL', 'HIGH', 'LOW', 'MEDIUM'},
    'relative_direction': {'CROSSING', 'NONE', 'OPPOSITE', 'SAME'}
}


def sanitize_categorical(col: str, raw_val) -> str:
    """Sanitize and harmonize categorical values to valid V2 categories."""
    if raw_val is None:
        return DEFAULT_CATEGORICAL.get(col, '')
    val = str(raw_val).strip().upper()

    # Domain harmonizations
    if col == 'task_type':
        if val in ('DELIVER', 'DROP'):
            return 'DROP'
        if val in ('PICK', 'PICKUP'):
            return 'PICK'
        if val in ('CHARGE', 'CHARGING'):
            return 'CHARGE'
        if val in ('TRANSFER', 'RELOCATE', 'RETURN'):
            return 'RELOCATE'
    elif col == 'relative_direction':
        if val == 'PERPENDICULAR':
            return 'CROSSING'

    if val in VALID_CATEGORIES.get(col, set()):
        return val
    return DEFAULT_CATEGORICAL.get(col, '')


def predict(data: dict) -> dict:
    if MODEL is None or PREPROCESSOR is None:
        return {
            "decision": "WAIT",
            "confidence": 0.0,
            "error": "ARES V2 ML model or preprocessor not loaded"
        }

    row = {}
    for col in FEATURE_COLUMNS:
        if col in NUMERIC_COLUMNS:
            val = data.get(col, DEFAULT_NUMERICAL.get(col, 0.0))
            try:
                row[col] = float(val) if val is not None else DEFAULT_NUMERICAL.get(col, 0.0)
            except (ValueError, TypeError):
                row[col] = DEFAULT_NUMERICAL.get(col, 0.0)
        else:
            raw_val = data.get(col)
            row[col] = sanitize_categorical(col, raw_val)

    try:
        df = pd.DataFrame([row], columns=FEATURE_COLUMNS)
        X = PREPROCESSOR.transform(df)

        # XGBoost returns integer class indices (0: MOVE, 1: SLOW, 2: WAIT, 3: REROUTE)
        pred_raw = MODEL.predict(X)[0]
        pred_idx = int(pred_raw)

        if hasattr(MODEL, 'predict_proba'):
            probs = MODEL.predict_proba(X)[0]
            confidence = float(probs[pred_idx]) if 0 <= pred_idx < len(probs) else 0.0
        else:
            confidence = 1.0

        decision = CLASSES[pred_idx] if 0 <= pred_idx < len(CLASSES) else "WAIT"

        return {
            "decision": decision,
            "confidence": round(confidence, 4)
        }
    except Exception as e:
        return {
            "decision": "WAIT",
            "confidence": 0.0,
            "error": str(e)
        }


def main():
    # If JSON payload is passed as command-line argument
    if len(sys.argv) > 1:
        try:
            payload = json.loads(sys.argv[1])
            result = predict(payload)
            print(json.dumps(result))
        except Exception as e:
            print(json.dumps({"decision": "WAIT", "confidence": 0.0, "error": str(e)}))
        return

    # Otherwise stream lines from stdin
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
            result = predict(payload)
            print(json.dumps(result), flush=True)
        except Exception as e:
            print(json.dumps({"decision": "WAIT", "confidence": 0.0, "error": str(e)}), flush=True)


if __name__ == '__main__':
    main()

