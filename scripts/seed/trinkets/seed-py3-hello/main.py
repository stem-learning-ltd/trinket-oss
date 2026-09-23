# Basic output. The lines should appear one at a time, half a second apart,
# not all together when the program finishes.
import sys
import time

print("Hello from Python", sys.version.split()[0])
for i in range(1, 6):
    print("line", i, "of 5")
    time.sleep(0.5)
print("Done.")
