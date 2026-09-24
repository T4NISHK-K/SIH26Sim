import joblib
import json

# 1. Inspect config
cfg = joblib.load('ml/amr_ares_v2_config.pkl')
print('CONFIG:')
for k, v in cfg.items():
    print(f'  {k}: {v}')

# 2. Inspect preprocessor
prep = joblib.load('ml/amr_ares_v2_preprocessor.pkl')
print('\nPREPROCESSOR:')
print('Type:', type(prep))
if hasattr(prep, 'transformers_'):
    for name, trans, cols in prep.transformers_:
        print(f'  Transformer {name}: {type(trans)} on cols: {cols}')
        if hasattr(trans, 'categories_'):
            print(f'    categories: {trans.categories_}')
elif hasattr(prep, 'named_transformers_'):
    for name, trans in prep.named_transformers_.items():
        print(f'  Named {name}: {type(trans)}')
        if hasattr(trans, 'categories_'):
            print(f'    categories: {trans.categories_}')

# 3. Inspect model
model = joblib.load('ml/amr_ares_v2_model.pkl')
print('\nMODEL:')
print('Type:', type(model))
if hasattr(model, 'classes_'):
    print('classes_:', model.classes_)
if hasattr(model, 'n_features_in_'):
    print('n_features_in_:', model.n_features_in_)
if hasattr(model, 'feature_names_in_'):
    print('feature_names_in_:', model.feature_names_in_)

# 4. Check transcripts
paths = [
    r'C:\Users\ASUS1\.gemini\antigravity-ide\brain\1a0f3027-b147-4542-83d4-c848e7c07fd8\.system_generated\logs\transcript_full.jsonl',
    r'C:\Users\ASUS1\.gemini\antigravity-ide\brain\0bd100cb-dc04-4ef2-8ec1-0a517fbd84a5\.system_generated\logs\transcript_full.jsonl'
]

for p in paths:
    print('Checking transcript:', p)
    try:
        with open(p, 'r', encoding='utf-8') as f:
            for idx, line in enumerate(f):
                if 'true_ttc_sec' in line:
                    data = json.loads(line)
                    content = data.get('content', '')
                    if 'def ' in content or 'r_min' in content:
                        print(f'Match at line {idx} in {p[:60]}...')
                        # print excerpt
                        for subline in content.split('\n'):
                            if any(k in subline for k in ['true_ttc', 'r_min', 'rho', 'cpa_', 'relative_direction', 'density_radius']):
                                print('  ', subline[:120])
    except Exception as e:
        print('Error reading transcript:', e)
