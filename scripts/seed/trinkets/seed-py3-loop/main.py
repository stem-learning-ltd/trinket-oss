# Never finishes on its own. The shell's 60-second run limit should stop it:
# the counter stops at about 59 and the run ends.
#
# It prints once a second on purpose: printing in a tight loop trips a
# different limit (see the seed-py3-flood trinket).
import time

seconds = 0
while True:
    print("still running,", seconds, "seconds so far")
    time.sleep(1)
    seconds += 1
