# Two files. main.py imports helpers.py, which is a separate tab in the
# editor. It also writes results.txt, which should appear as a new file.
from helpers import shout, total

print(shout("multi-file trinkets work"))
print("Total of 1 to 10:", total(range(1, 11)))

with open("results.txt", "w") as f:
    f.write("Written by main.py\n")
print("Wrote results.txt")
