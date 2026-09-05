import json
import os
import sys
import joblib
import pandas as pd

# Path setup
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(BASE_DIR, 'ml', 'amr_decision_model.pkl')
PREPROCESSOR_PATH = os.path.join(BASE_DIR, 'ml', 'amr_preprocessor.pkl')

# Exactly the model's 24 feature columns
FEATURE_COLUMNS = [
    'current_x',
    'current_y',
    'destination_x',
    'destination_y',
    'speed_mps',
    'direction',
    'battery_pct',
    'task_type',
    'task_priority',
    'traffic_level',
    'obstacle_detected',
    'path_blocked',
    'nearby_robot_count',
    'nearest_robot_distance_m',
    'relative_direction',
    'distance_to_destination_m',
    'eta_sec',
    'congestion_score',
    'collision_risk',
    'deadlock_risk',
    'waiting_time_sec',
    'charging_required',
    'route_length_m',
    'alternative_route_available'
]

# Safe default values for missing inputs
DEFAULT_NUMERICAL = {
    'current_x': 0.0,
    'current_y': 0.0,
    'destination_x': 0.0,
    'destination_y': 0.0,
    'speed_mps': 0.0,
    'battery_pct': 100.0,
    'obstacle_detected': 0,
    'path_blocked': 0,
    'nearby_robot_count': 0,
    'nearest_robot_distance_m': 999.0,
    'distance_to_destination_m': 0.0,
    'eta_sec': 0.0,
    'congestion_score': 0.0,
    'collision_risk': 0.0,
    'deadlock_risk': 0.0,
    'waiting_time_sec': 0.0,
    'charging_required': 0,
    'route_length_m': 0.0,
    'alternative_route_available': 1
}

DEFAULT_CATEGORICAL = {
    'direction': 'North',
    'task_type': 'DELIVER',
    'task_priority': 'MEDIUM',
    'traffic_level': 'LOW',
    'relative_direction': 'NONE'
}

try:
    MODEL = joblib.load(MODEL_PATH)
    PREPROCESSOR = joblib.load(PREPROCESSOR_PATH)
except Exception as e:
    sys.stderr.write(f"[Predictor ERROR] Failed to load ML models: {e}\n")
    MODEL = None
    PREPROCESSOR = None


def predict(data: dict) -> dict:
    if MODEL is None or PREPROCESSOR is None:
        return {
            "decision": "WAIT",
            "confidence": 0.0,
            "error": "ML model or preprocessor not loaded"
        }

    row = {}
    for col in FEATURE_COLUMNS:
        if col in DEFAULT_NUMERICAL:
            val = data.get(col, DEFAULT_NUMERICAL[col])
            try:
                row[col] = float(val) if val is not None else DEFAULT_NUMERICAL[col]
            except (ValueError, TypeError):
                row[col] = DEFAULT_NUMERICAL[col]
        else:
            val = data.get(col, DEFAULT_CATEGORICAL.get(col, ''))
            row[col] = str(val) if val is not None else DEFAULT_CATEGORICAL.get(col, '')

    try:
        df = pd.DataFrame([row], columns=FEATURE_COLUMNS)
        X = PREPROCESSOR.transform(df)
        decision = str(MODEL.predict(X)[0])

        if hasattr(MODEL, 'predict_proba'):
            probs = MODEL.predict_proba(X)[0]
            confidence = float(max(probs))
        else:
            confidence = 1.0

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
