# Heavy imports. The first run after the shell starts is noticeably slower
# while numpy, pandas and scipy load; later runs should be quicker.
import time

started = time.time()
import numpy as np
import pandas as pd
import scipy
print("Imports took %.1f seconds" % (time.time() - started))
print("numpy", np.__version__, "| pandas", pd.__version__, "| scipy", scipy.__version__)

scores = pd.DataFrame({
    "pupil": ["Asha", "Ben", "Chen", "Dara"],
    "maths": [72, 85, 64, 90],
    "science": [68, 79, 88, 81],
})
scores["average"] = scores[["maths", "science"]].mean(axis=1)
print(scores.sort_values("average", ascending=False).to_string(index=False))
