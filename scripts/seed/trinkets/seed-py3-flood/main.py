# Prints as fast as it can. The shell disconnects any session that sends
# more than 100 output messages in a quarter of a second, so this should be
# cut off within a moment; the shell log shows "too many emits".
i = 0
while True:
    print(i)
    i += 1
