import joblib
import pandas as pd
import numpy as np

model = joblib.load('ml/amr_ares_v2_model.pkl')
preprocessor = joblib.load('ml/amr_ares_v2_preprocessor.pkl')
config = joblib.load('ml/amr_ares_v2_config.pkl')

# Let's inspect the V2 training dataset if available to see typical feature values for each class!
try:
    df_train = pd.read_csv('ml/amr_ares_v2_dataset.csv')
    print("Dataset shape:", df_train.shape)
    for act in ['MOVE', 'SLOW', 'WAIT', 'REROUTE']:
        sub = df_train[df_train['action'] == act]
        print(f"\n--- Typical samples for {act} (count: {len(sub)}) ---")
        if len(sub) > 0:
            sample = sub.iloc[0:3]
            X_sample = sample[config['all_features']]
            probs = model.predict_proba(preprocessor.transform(X_sample))
            for i, p in enumerate(probs):
                conf = np.max(p)
                pred_cls = config['classes'][np.argmax(p)]
                print(f"  sample {i}: true={act}, pred={pred_cls}, conf={conf:.4f}")
                print(f"    dist={sample.iloc[i]['nearest_robot_distance_m']}, ttc={sample.iloc[i]['true_ttc_sec']}, cpa_d={sample.iloc[i]['cpa_distance_m']}, rel_dir={sample.iloc[i]['relative_direction']}, obst={sample.iloc[i]['obstacle_detected']}")
except Exception as e:
    print("Could not load training dataset:", e)
