# Interactive input. Type an answer and press Enter for each question.
#
# Abandoned-session test: press Run, then close the tab without answering.
# The waiting python process should be killed. Check that none is left:
#   docker compose -f serverside/docker-compose.yml --profile python3 exec python3-shell ps -ef
# (no python3 line mentioning /tmp/sessions). Left open and unanswered, the
# program is stopped by the 60-second run limit instead.
name = input("What's your name? ")
age = input("How old are you? ")
print("Hello", name + "!")
try:
    print("In ten years you'll be", int(age) + 10)
except ValueError:
    print("That wasn't a whole number, but hello anyway.")
