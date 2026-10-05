# matplotlib output. Expect a line chart to appear under the program's text
# output. The image is written by the shell and served by the local nginx
# from http://localhost:8080/python3-generated/...
import matplotlib.pyplot as plt

xs = list(range(11))
plt.plot(xs, [x * x for x in xs], label="x squared")
plt.plot(xs, [10 * x for x in xs], label="10x")
plt.title("Seed plot")
plt.legend()
plt.show()
print("Plot drawn.")
