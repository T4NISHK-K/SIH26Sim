import json

# Read step109
with open('scratch/step109.txt', 'r', encoding='utf-8') as f:
    content = f.read()

# Parse the tool call args
data = eval(content)
code = data[0]['args']['CodeContent']

with open('scratch/ares_simulation_engine.py', 'w', encoding='utf-8') as f:
    f.write(code)

print("Saved clean scratch/ares_simulation_engine.py, length:", len(code))
